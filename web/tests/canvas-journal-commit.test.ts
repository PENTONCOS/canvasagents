import { expect, test } from "bun:test";

import { normalizeJournal } from "../src/lib/canvas/canvas-journal";
import { commitCanvasJournal, nextJournalSeq, restoreCanvasJournal } from "../src/lib/canvas/canvas-journal-commit";
import type { CanvasConnection, CanvasJournalEntry, CanvasNodeData } from "../src/types/canvas";

const ACTOR = { kind: "user" as const };

const node = (id: string, overrides: Partial<CanvasNodeData> = {}): CanvasNodeData => ({ id, type: "text", title: id, position: { x: 0, y: 0 }, width: 100, height: 50, ...overrides });

const edge = (id: string, fromNodeId: string, toNodeId: string): CanvasConnection => ({ id, fromNodeId, toNodeId });

const snapshot = (nodes: CanvasNodeData[] = [], connections: CanvasConnection[] = []) => ({ nodes, connections });

// A fresh deterministic id/clock source so one commit's output is byte-stable across runs.
const deterministic = () => {
    let counter = 0;
    return { now: () => 500, makeId: () => `j-${counter++}` };
};

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

// Number of entries changed is a plain diff; the assertions below pin the exact, deterministic shape.

test("nextJournalSeq continues past the newest entry and restarts on a malformed tail", () => {
    expect(nextJournalSeq([])).toBe(0);
    expect(nextJournalSeq([entry(0), entry(7)])).toBe(8);
    expect(nextJournalSeq([entry(3, { seq: Number.NaN })])).toBe(0);
});

test("commitCanvasJournal stamps an entry with the commit id and starts seq at the journal tail", () => {
    const prev = snapshot([node("a")]);
    const next = snapshot([node("a"), node("b")]);
    const result = commitCanvasJournal(prev, next, [entry(4)], ACTOR, { commitId: "c1", ...deterministic() });

    expect(result.entries.map((item) => item.kind)).toEqual(["node.add"]);
    expect(result.entries.map((item) => item.meta?.commitId)).toEqual(["c1"]);
    expect(result.entries.map((item) => item.seq)).toEqual([5]);
    expect(result.journal.map((item) => item.seq)).toEqual([4, 5]);
    expect(result.journal[1].targets.nodeIds).toEqual(["b"]);
    expect(result.dropped).toBe(0);
});

test("commitCanvasJournal shares one commit id across a multi-entry diff and keeps seq monotonic", () => {
    const prev = snapshot([node("a")]);
    const next = snapshot([node("a", { position: { x: 5, y: 0 } }), node("b")], [edge("e1", "a", "b")]);
    const result = commitCanvasJournal(prev, next, [entry(4)], ACTOR, { commitId: "c2", ...deterministic() });

    expect(result.entries.length).toBe(3);
    expect(new Set(result.entries.map((item) => item.meta?.commitId))).toEqual(new Set(["c2"]));
    expect(result.entries.map((item) => item.seq)).toEqual([5, 6, 7]);
    expect(result.journal.map((item) => item.seq)).toEqual([4, 5, 6, 7]);
});

test("commitCanvasJournal leaves the journal untouched when the diff is empty", () => {
    // A pure reorder is not a change: the diff indexes by id, so nothing is recorded.
    const prev = snapshot([node("a"), node("b")]);
    const next = snapshot([node("b"), node("a")]);
    const result = commitCanvasJournal(prev, next, [entry(0)], ACTOR, { commitId: "c3", ...deterministic() });

    expect(result.entries).toEqual([]);
    expect(result.journal.map((item) => item.id)).toEqual(["e0"]);
    expect(result.dropped).toBe(0);
});

test("commitCanvasJournal caps the journal at the limit and reports the drops", () => {
    const prev = snapshot([]);
    const next = snapshot([node("a"), node("b")]);
    const result = commitCanvasJournal(prev, next, [entry(0), entry(1), entry(2)], ACTOR, { commitId: "c4", limit: 3, ...deterministic() });

    expect(result.entries.length).toBe(2);
    expect(result.journal.length).toBe(3);
    expect(result.journal.map((item) => item.seq)).toEqual([2, 3, 4]);
    expect(result.dropped).toBe(2);
});

test("restoreCanvasJournal normalizes, caps, and flags non-canonical data", () => {
    expect(restoreCanvasJournal(undefined)).toEqual({ journal: [], needsRewrite: false });
    expect(restoreCanvasJournal("not-an-array")).toEqual({ journal: [], needsRewrite: true });

    // An already-canonical journal (the shape persist round-trips) is not flagged for rewrite.
    const canonical = normalizeJournal([{ seq: 0, id: "e0", at: 10, actor: { kind: "user" }, kind: "node.add", targets: { nodeIds: ["n0"] }, summary: { key: "canvas.journal.nodeAdd" } }]);
    const persisted = JSON.parse(JSON.stringify(canonical));
    expect(restoreCanvasJournal(persisted)).toEqual({ journal: canonical, needsRewrite: false });

    // A dirty entry is dropped, which is a change worth writing back.
    const dirty = [...JSON.parse(JSON.stringify(canonical)), { kind: "bogus", at: 11 }];
    const dirtyResult = restoreCanvasJournal(dirty);
    expect(dirtyResult.journal.map((item) => item.id)).toEqual(["e0"]);
    expect(dirtyResult.needsRewrite).toBe(true);

    // An over-limit journal is truncated, also a change worth writing back.
    const overLimit = JSON.parse(JSON.stringify(normalizeJournal([entry(0), entry(1), entry(2)])));
    const cappedResult = restoreCanvasJournal(overLimit, 2);
    expect(cappedResult.journal.map((item) => item.seq)).toEqual([1, 2]);
    expect(cappedResult.needsRewrite).toBe(true);
});
