import { expect, test } from "bun:test";

import {
    buildHistoryTimeline,
    CANVAS_JOURNAL_PANEL_LIMIT,
    flattenJournalPatch,
    groupJournalCommits,
    journalCommitId,
    jumpHistoryStacks,
    orderJournalForPanel,
    planHistoryJump,
    resolveJournalLocation,
    resolveJournalTarget,
    withJournalCommitId,
} from "../src/lib/canvas/canvas-journal-steps";
import type { CanvasJournalEntry } from "../src/types/canvas";

const ACTOR = { kind: "user" as const };

const entry = (seq: number, overrides: Partial<CanvasJournalEntry> = {}): CanvasJournalEntry => ({
    seq,
    id: `e${seq}`,
    at: 1000 + seq,
    actor: ACTOR,
    kind: "node.add",
    targets: { nodeIds: [`n${seq}`] },
    summary: { key: "canvas.journal.nodeAdd", params: { title: `n${seq}`, count: 1 } },
    ...overrides,
});

// A stack entry as the undo/redo stacks carry it: a snapshot tagged with the commit that produced it.
const snapshot = (commitId: string) => ({ commitId });

// --- commit identity / grouping --------------------------------------------------------------

test("withJournalCommitId stamps meta.commitId without clobbering meta, and a blank id is a no-op", () => {
    const original = entry(0, { meta: { fields: ["title"] } });
    expect(withJournalCommitId(original, "")).toBe(original);
    const stamped = withJournalCommitId(original, "c1");
    expect(journalCommitId(stamped)).toBe("c1");
    expect(stamped.meta?.fields).toEqual(["title"]);
    expect(journalCommitId(original)).toBeUndefined();
});

test("groupJournalCommits merges consecutive entries sharing a commit id and keeps the earliest time", () => {
    const groups = groupJournalCommits([withJournalCommitId(entry(0, { at: 200 }), "c1"), withJournalCommitId(entry(1, { at: 100 }), "c1"), withJournalCommitId(entry(2), "c2")]);
    expect(groups.map((group) => group.key)).toEqual(["c1", "c2"]);
    expect(groups[0].commitId).toBe("c1");
    expect(groups[0].entries.map((item) => item.id)).toEqual(["e0", "e1"]);
    expect(groups[0].at).toBe(100);
    expect(groups[0].actor).toEqual(ACTOR);
});

test("groupJournalCommits never fuses an entry without a commit id into a neighbour's step", () => {
    const groups = groupJournalCommits([withJournalCommitId(entry(0), "c1"), entry(1), withJournalCommitId(entry(2), "c1")]);
    expect(groups.map((group) => group.key)).toEqual(["c1", "entry:e1", "c1"]);
    expect(groups[1].commitId).toBeUndefined();
    expect(groups[1].entries.map((item) => item.id)).toEqual(["e1"]);
    expect(groupJournalCommits()).toEqual([]);
});

// --- timeline projection ---------------------------------------------------------------------

test("buildHistoryTimeline lays out past, current and future chronologically with currentIndex === past.length", () => {
    const stacks = { past: [snapshot("a"), snapshot("b")], current: snapshot("c"), future: [snapshot("e"), snapshot("d")] };
    const timeline = buildHistoryTimeline(stacks);
    // `future` is a LIFO stack (nearest redo last), so reversed it reads oldest-first.
    expect(timeline.commitIds).toEqual(["a", "b", "c", "d", "e"]);
    expect(timeline.currentIndex).toBe(2);
    expect(timeline.currentIndex).toBe(stacks.past.length);
});

test("buildHistoryTimeline returns an empty timeline when there is no live state", () => {
    expect(buildHistoryTimeline({ past: [snapshot("a")], current: null, future: [] })).toEqual({ commitIds: [], currentIndex: 0 });
});

// --- reachability ----------------------------------------------------------------------------

test("resolveJournalLocation classifies current, undo, redo and out-of-window", () => {
    const timeline = buildHistoryTimeline({ past: [snapshot("a"), snapshot("b")], current: snapshot("c"), future: [snapshot("d")] });
    expect(resolveJournalLocation(timeline, "c")).toEqual({ status: "current", index: 2, steps: 0 });
    expect(resolveJournalLocation(timeline, "a")).toEqual({ status: "undo", index: 0, steps: 2 });
    expect(resolveJournalLocation(timeline, "d")).toEqual({ status: "redo", index: 3, steps: 1 });
    expect(resolveJournalLocation(timeline, "missing")).toEqual({ status: "out-of-window", index: -1, steps: 0 });
    expect(resolveJournalLocation(timeline, undefined)).toEqual({ status: "out-of-window", index: -1, steps: 0 });
});

// --- jump planning / stacks ------------------------------------------------------------------

test("planHistoryJump reports the direction and step count of a jump", () => {
    expect(planHistoryJump(3, 3)).toEqual({ direction: "current", steps: 0 });
    expect(planHistoryJump(3, 1)).toEqual({ direction: "undo", steps: 2 });
    expect(planHistoryJump(1, 4)).toEqual({ direction: "redo", steps: 3 });
});

test("jumpHistoryStacks undoes N and the same N redos return to the original order", () => {
    const stacks = { past: [snapshot("a"), snapshot("b"), snapshot("c")], current: snapshot("d"), future: [] };
    const timeline = buildHistoryTimeline(stacks);
    const back = jumpHistoryStacks(stacks, timeline.currentIndex - 2);
    expect(back.current?.commitId).toBe("b");
    expect(back.past.map((item) => item.commitId)).toEqual(["a"]);

    // Replay the exact redo semantics (pop the nearest future state back onto past) to walk forward.
    const replay = { past: [...back.past], future: [...back.future], current: back.current };
    for (let index = 0; index < 2; index += 1) {
        const next = replay.future.pop();
        if (!next || !replay.current) break;
        replay.past.push(replay.current);
        replay.current = next;
    }
    expect(replay.current?.commitId).toBe("d");
    expect(buildHistoryTimeline(replay).commitIds).toEqual(timeline.commitIds);
});

test("jumpHistoryStacks returns an equivalent stack for an unreachable target instead of throwing", () => {
    const stacks = { past: [snapshot("a")], current: snapshot("b"), future: [] };
    const tooFarBack = jumpHistoryStacks(stacks, -5);
    expect(tooFarBack.past.map((item) => item.commitId)).toEqual(["a"]);
    expect(tooFarBack.current?.commitId).toBe("b");
    const tooFarForward = jumpHistoryStacks(stacks, 99);
    expect(tooFarForward.future).toEqual([]);
    expect(tooFarForward.current?.commitId).toBe("b");
    // The inputs are never mutated.
    expect(stacks.past.map((item) => item.commitId)).toEqual(["a"]);
});

// --- panel ordering --------------------------------------------------------------------------

test("orderJournalForPanel renders newest first, caps at the limit and reports the hidden count", () => {
    const ordered = orderJournalForPanel([entry(0), entry(1), entry(2), entry(3)], 2);
    expect(ordered.entries.map((item) => item.seq)).toEqual([3, 2]);
    expect(ordered.hidden).toBe(2);
});

test("orderJournalForPanel falls back to the panel cap for an unusable limit and reads an absent journal as empty", () => {
    const entries = [entry(0)];
    expect(orderJournalForPanel(entries, 0).entries).toHaveLength(1);
    expect(orderJournalForPanel(entries, Number.NaN).hidden).toBe(0);
    expect(orderJournalForPanel(undefined as unknown as readonly CanvasJournalEntry[], CANVAS_JOURNAL_PANEL_LIMIT).entries).toEqual([]);
});

// --- target labels ---------------------------------------------------------------------------

test("resolveJournalTarget prefers the live title, then the recorded title, then the raw id", () => {
    const live = entry(0, { targets: { nodeIds: ["nX"] }, summary: { key: "canvas.journal.nodeUpdate", params: { title: "Recorded", count: 1 } } });
    expect(resolveJournalTarget(live, { nX: "Live" }, "Untitled").label).toBe("Live");
    expect(resolveJournalTarget(live, {}, "Untitled").label).toBe("Recorded");
    const deleted = entry(1, { targets: { nodeIds: ["gone"] }, summary: { key: "canvas.journal.nodeRemove", params: { title: "", count: 1 } } });
    expect(resolveJournalTarget(deleted, {}, "Untitled").label).toBe("gone");
});

test("resolveJournalTarget renders edges as from -> to and falls back to untitled", () => {
    const edge = entry(2, { targets: { edgeIds: ["edge-1"] }, summary: { key: "canvas.journal.edgeAdd", params: { from: "A", to: "B" } } });
    expect(resolveJournalTarget(edge, {}, "Untitled").label).toBe("A → B");
    const pointed = entry(3, { targets: {}, summary: { key: "canvas.journal.projectRename", params: { from: "Old", to: "New" } } });
    expect(resolveJournalTarget(pointed, {}, "Untitled").label).toBe("New");
    const bare = entry(4, { targets: {}, summary: { key: "canvas.journal.agentTurn" } });
    expect(resolveJournalTarget(bare, {}, "Untitled").label).toBe("Untitled");
});

// --- patch flattening ------------------------------------------------------------------------

test("flattenJournalPatch renders a redaction placeholder as a reference and never a data URL", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(400)}`;
    const summary = flattenJournalPatch({ after: { content: { __ref: true, len: dataUrl.length, sha: "deadbeef" } } });
    expect(summary.truncated).toBe(false);
    expect(summary.lines).toHaveLength(1);
    expect(summary.lines[0].path).toBe("after.content");
    expect(summary.lines[0].ref?.len).toBe(dataUrl.length);
    expect(summary.lines[0].text).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain("data:");
});

test("flattenJournalPatch treats a raw data URL / blob string as a reference defensively", () => {
    const summary = flattenJournalPatch({ after: { url: "data:image/png;base64,AAAA" } });
    expect(summary.lines[0].ref).toBeDefined();
    expect(JSON.stringify(summary)).not.toContain("data:");
});

test("flattenJournalPatch bounds the walk by depth and reports truncation", () => {
    const deep = flattenJournalPatch({ a: { b: { c: { d: { e: 1 } } } } });
    expect(deep.lines).toEqual([{ path: "a.b.c.d", text: "{…}" }]);
    const wide = flattenJournalPatch({ after: { list: [1, 2, 3, 4, 5] } }, { maxLines: 2 });
    expect(wide.lines).toHaveLength(2);
    expect(wide.truncated).toBe(true);
});
