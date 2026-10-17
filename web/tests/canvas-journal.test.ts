import { expect, test } from "bun:test";

import { CANVAS_JOURNAL_KINDS, CANVAS_JOURNAL_LIMIT, appendJournalEntry, diffCanvasSnapshots, normalizeJournal, normalizeJournalEntry, redactLargeValues } from "../src/lib/canvas/canvas-journal";
import enUS from "../src/i18n/locales/en-US";
import zhCN from "../src/i18n/locales/zh-CN";
import type { CanvasConnection, CanvasJournalEntry, CanvasNodeData } from "../src/types/canvas";

const ACTOR = { kind: "user" as const, name: "Tester" };

const node = (id: string, overrides: Partial<CanvasNodeData> = {}): CanvasNodeData => ({ id, type: "text", title: id, position: { x: 0, y: 0 }, width: 100, height: 50, ...overrides });

const edge = (id: string, fromNodeId: string, toNodeId: string, overrides: Partial<CanvasConnection> = {}): CanvasConnection => ({ id, fromNodeId, toNodeId, ...overrides });

const snapshot = (nodes: CanvasNodeData[] = [], connections: CanvasConnection[] = []) => ({ nodes, connections });

const kinds = (entries: CanvasJournalEntry[]): string[] => entries.map((entry) => entry.kind);

// A fresh deterministic id/clock source, so two independent runs of the same diff line up byte for
// byte without touching the real clock or nanoid.
const deterministicOpts = () => {
    let counter = 0;
    return { now: () => 1000, makeId: () => `j-${counter++}`, seqStart: 0 };
};

const journalEntry = (seq: number): CanvasJournalEntry => ({ seq, id: `e${seq}`, at: seq, actor: { kind: "user" }, kind: "node.add", targets: { nodeIds: [`n${seq}`] }, summary: { key: "canvas.journal.nodeAdd", params: { title: `n${seq}`, count: 1 } } });

function expectEntry(value: unknown): CanvasJournalEntry {
    const entry = normalizeJournalEntry(value);
    if (!entry) throw new Error("expected a normalized journal entry");
    return entry;
}

// --- diffCanvasSnapshots: kinds -----------------------------------------------------------------

test("diffCanvasSnapshots returns an empty list when nothing changed", () => {
    const before = snapshot([node("a"), node("b")], [edge("e1", "a", "b")]);
    const after = { nodes: [node("b"), node("a")], connections: [edge("e1", "a", "b")] };
    expect(diffCanvasSnapshots(before, after, ACTOR)).toEqual([]);
    expect(diffCanvasSnapshots(undefined, undefined, ACTOR)).toEqual([]);
    expect(diffCanvasSnapshots(snapshot(), snapshot(), ACTOR)).toEqual([]);
});

test("diffCanvasSnapshots reports added and removed nodes with node targets", () => {
    const added = diffCanvasSnapshots(snapshot([]), snapshot([node("n1", { title: "Hero" })]), ACTOR);
    expect(kinds(added)).toEqual(["node.add"]);
    expect(added[0].targets.nodeIds).toEqual(["n1"]);
    expect(added[0].summary.key).toBe("canvas.journal.nodeAdd");
    expect(added[0].summary.params).toMatchObject({ title: "Hero", count: 1 });

    const removed = diffCanvasSnapshots(snapshot([node("n1", { title: "Hero" })]), snapshot([]), ACTOR);
    expect(kinds(removed)).toEqual(["node.remove"]);
    expect(removed[0].targets.nodeIds).toEqual(["n1"]);
    expect(removed[0].summary.key).toBe("canvas.journal.nodeRemove");
});

test("diffCanvasSnapshots reports added, removed and updated edges with edge targets", () => {
    const prev = snapshot([node("a"), node("b")], [edge("e1", "a", "b"), edge("e2", "a", "b")]);
    const next = snapshot([node("a"), node("b")], [edge("e2", "a", "b", { label: "renamed" }), edge("e3", "b", "a")]);

    const entries = diffCanvasSnapshots(prev, next, ACTOR);
    expect(kinds(entries)).toEqual(["edge.add", "edge.remove", "edge.update"]);
    expect(entries[0].targets.edgeIds).toEqual(["e3"]);
    expect(entries[0].summary.key).toBe("canvas.journal.edgeAdd");
    expect(entries[0].summary.params).toMatchObject({ from: "b", to: "a" });
    expect(entries[1].targets.edgeIds).toEqual(["e1"]);
    expect(entries[1].summary.key).toBe("canvas.journal.edgeRemove");
    expect(entries[2].targets.edgeIds).toEqual(["e2"]);
    expect(entries[2].summary.key).toBe("canvas.journal.edgeUpdate");
    expect(entries[2].meta?.fields).toEqual(["label"]);
});

test("diffCanvasSnapshots maps a single changed node field to its dedicated kind", () => {
    const base = snapshot([node("n1", { type: "image", title: "Pic", metadata: { content: "old", editor: { engine: "miniPaint", lastSavedAt: 1 } } })]);

    expect(kinds(diffCanvasSnapshots(base, snapshot([node("n1", { type: "image", title: "Pic", position: { x: 10, y: 0 }, metadata: { content: "old", editor: { engine: "miniPaint", lastSavedAt: 1 } } })]), ACTOR))).toEqual(["node.move"]);
    expect(kinds(diffCanvasSnapshots(base, snapshot([node("n1", { type: "image", title: "Pic", width: 200, metadata: { content: "old", editor: { engine: "miniPaint", lastSavedAt: 1 } } })]), ACTOR))).toEqual(["node.resize"]);
    expect(kinds(diffCanvasSnapshots(base, snapshot([node("n1", { type: "image", title: "Pic", height: 200, metadata: { content: "old", editor: { engine: "miniPaint", lastSavedAt: 1 } } })]), ACTOR))).toEqual(["node.resize"]);
    expect(kinds(diffCanvasSnapshots(base, snapshot([node("n1", { type: "image", title: "Renamed", metadata: { content: "old", editor: { engine: "miniPaint", lastSavedAt: 1 } } })]), ACTOR))).toEqual(["node.update"]);
    expect(kinds(diffCanvasSnapshots(base, snapshot([node("n1", { type: "image", title: "Pic", metadata: { content: "new", editor: { engine: "miniPaint", lastSavedAt: 1 } } })]), ACTOR))).toEqual(["node.content"]);
    expect(kinds(diffCanvasSnapshots(base, snapshot([node("n1", { type: "image", title: "Pic", metadata: { content: "old", editor: { engine: "miniPaint", lastSavedAt: 2 } } })]), ACTOR))).toEqual(["node.image-edit"]);
    expect(kinds(diffCanvasSnapshots(base, snapshot([node("n1", { type: "image", title: "Pic", metadata: { content: "old", editor: { engine: "miniPaint", lastSavedAt: 1 }, history: [{ kind: "ps-edit", at: 3 }] } })]), ACTOR))).toEqual([
        "node.image-edit",
    ]);
});

test("diffCanvasSnapshots merges several changed fields of one node into a single entry", () => {
    const prev = snapshot([node("n1", { title: "Old" })]);
    const next = snapshot([node("n1", { title: "New", position: { x: 5, y: 5 }, width: 200 })]);

    const entries = diffCanvasSnapshots(prev, next, ACTOR);
    expect(entries.length).toBe(1);
    expect(entries[0].kind).toBe("node.resize");
    expect(entries[0].targets.nodeIds).toEqual(["n1"]);
    expect(entries[0].meta?.fields).toEqual(["title", "position", "width"]);
    expect(entries[0].summary.params).toMatchObject({ title: "New", count: 3 });
});

test("a PS-style save collapses content + editor changes into one image-edit entry", () => {
    const prev = snapshot([node("img", { type: "image", metadata: { content: "data:image/png;base64,OLD", editor: { engine: "miniPaint", lastSavedAt: 1 } } })]);
    const next = snapshot([node("img", { type: "image", metadata: { content: "data:image/png;base64,NEW", editor: { engine: "miniPaint", lastSavedAt: 2 } } })]);

    const entries = diffCanvasSnapshots(prev, next, ACTOR);
    expect(entries.length).toBe(1);
    expect(entries[0].kind).toBe("node.image-edit");
    expect(entries[0].meta?.fields).toEqual(["content", "editor"]);
});

test("diffCanvasSnapshots emits a project.rename entry with no targets", () => {
    const entries = diffCanvasSnapshots({ title: "Old", nodes: [] }, { title: "New", nodes: [] }, ACTOR);
    expect(kinds(entries)).toEqual(["project.rename"]);
    expect(entries[0].targets).toEqual({});
    expect(entries[0].summary.key).toBe("canvas.journal.projectRename");
    expect(entries[0].summary.params).toEqual({ from: "Old", to: "New" });
});

// --- ordering + determinism --------------------------------------------------------------------

test("diffCanvasSnapshots orders a batch by id so the output does not depend on input order", () => {
    const forward = diffCanvasSnapshots(snapshot([]), snapshot([node("b"), node("a"), node("c")]), ACTOR).map((entry) => entry.targets.nodeIds?.[0]);
    const backward = diffCanvasSnapshots(snapshot([]), snapshot([node("c"), node("b"), node("a")]), ACTOR).map((entry) => entry.targets.nodeIds?.[0]);
    expect(forward).toEqual(["a", "b", "c"]);
    expect(backward).toEqual(["a", "b", "c"]);
});

test("diffCanvasSnapshots is deterministic for identical input under injected clock/id", () => {
    const prev = snapshot([node("a"), node("b")], [edge("e1", "a", "b")]);
    const next = snapshot([node("a", { position: { x: 9, y: 9 } }), node("b", { title: "B2" }), node("c")], [edge("e1", "a", "b", { label: "L" }), edge("e2", "b", "c")]);
    expect(diffCanvasSnapshots(prev, next, ACTOR, deterministicOpts())).toEqual(diffCanvasSnapshots(prev, next, ACTOR, deterministicOpts()));
});

test("injected now/makeId/seqStart fully determine seq, id and at", () => {
    const prev = snapshot([]);
    const next = snapshot([node("a"), node("b")]);
    const entries = diffCanvasSnapshots(
        prev,
        next,
        ACTOR,
        (() => {
            let counter = 0;
            return { now: () => 5000, makeId: () => `k-${counter++}`, seqStart: 10 };
        })(),
    );

    expect(entries.map((entry) => entry.seq)).toEqual([10, 11]);
    expect(entries.map((entry) => entry.id)).toEqual(["k-0", "k-1"]);
    expect(entries.map((entry) => entry.at)).toEqual([5000, 5000]);
    expect(entries.every((entry) => entry.actor === ACTOR)).toBe(true);
});

// --- redaction ---------------------------------------------------------------------------------

test("redactLargeValues replaces long strings with a compact reference placeholder", () => {
    expect(redactLargeValues({ a: "x".repeat(10), n: 3, keep: "ok" }, 5)).toEqual({ a: { __ref: true, len: 10, sha: expect.any(String) }, n: 3, keep: "ok" });
    expect(redactLargeValues(["short", "y".repeat(20)], 5)).toEqual(["short", { __ref: true, len: 20, sha: expect.any(String) }]);
    // Deterministic fingerprint: the same input always yields the same sha, different input does not.
    const first = redactLargeValues("z".repeat(20), 5) as { sha: string };
    const second = redactLargeValues("z".repeat(20), 5) as { sha: string };
    expect(first.sha).toBe(second.sha);
    expect(first.sha).not.toBe((redactLargeValues("q".repeat(20), 5) as { sha: string }).sha);
});

test("a patch never inlines a full image data URL", () => {
    const big = `data:image/png;base64,${"A".repeat(3000)}`;
    const prev = snapshot([node("n1", { type: "image", metadata: { content: big } })]);
    const next = snapshot([node("n1", { type: "image", metadata: { content: `${big}B` } })]);

    const serialized = JSON.stringify(diffCanvasSnapshots(prev, next, ACTOR));
    expect(serialized).not.toContain(big);
    expect(serialized).toContain("__ref");
});

// --- appendJournalEntry ------------------------------------------------------------------------

test("appendJournalEntry appends oldest-first and never mutates the input array", () => {
    const original = [journalEntry(1)];
    const snapshotBefore = JSON.stringify(original);
    const result = appendJournalEntry(original, journalEntry(2));
    expect(result.entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(result.dropped).toBe(0);
    expect(original.map((entry) => entry.seq)).toEqual([1]);
    expect(JSON.stringify(original)).toBe(snapshotBefore);
});

test("appendJournalEntry caps the journal and reports how many entries were dropped", () => {
    const history = [1, 2, 3].map(journalEntry);
    const result = appendJournalEntry(history, journalEntry(4), 3);
    expect(result.entries.map((entry) => entry.seq)).toEqual([2, 3, 4]);
    expect(result.dropped).toBe(1);
    expect(history.length).toBe(3);
});

test("appendJournalEntry treats a missing/non-array journal as empty and drops a dirty append", () => {
    expect(appendJournalEntry(undefined, journalEntry(1)).entries.map((entry) => entry.seq)).toEqual([1]);
    expect(appendJournalEntry(null, journalEntry(1)).entries.length).toBe(1);
    expect(appendJournalEntry("nope", journalEntry(1)).entries.length).toBe(1);
    expect(appendJournalEntry([], "not-an-entry")).toEqual({ entries: [], dropped: 0 });
    expect(appendJournalEntry(undefined, { kind: "bogus", at: 1, summary: { key: "k" } })).toEqual({ entries: [], dropped: 0 });
});

test("appendJournalEntry honours a zero limit by keeping nothing", () => {
    const result = appendJournalEntry([journalEntry(1)], journalEntry(2), 0);
    expect(result.entries).toEqual([]);
    expect(result.dropped).toBe(2);
});

test("appendJournalEntry defaults to the journal cap", () => {
    let journal: CanvasJournalEntry[] = [];
    for (let seq = 1; seq <= CANVAS_JOURNAL_LIMIT + 5; seq += 1) journal = appendJournalEntry(journal, journalEntry(seq)).entries;
    expect(journal.length).toBe(CANVAS_JOURNAL_LIMIT);
    expect(journal[0].seq).toBe(6);
    expect(journal[journal.length - 1].seq).toBe(CANVAS_JOURNAL_LIMIT + 5);
});

// --- normalizeJournal --------------------------------------------------------------------------

test("normalizeJournal tolerates empty and non-array input", () => {
    expect(normalizeJournal(undefined)).toEqual([]);
    expect(normalizeJournal(null)).toEqual([]);
    expect(normalizeJournal("no")).toEqual([]);
    expect(normalizeJournal({ at: 1 })).toEqual([]);
});

test("normalizeJournal drops entries it cannot render and keeps the rest in order", () => {
    const dirty = [null, "x", 5, { kind: "bogus", at: 1, summary: { key: "k" } }, { kind: "node.add", at: Number.NaN, summary: { key: "k" } }, { kind: "node.add", at: 2, summary: {} }, { kind: "node.add", at: 3, summary: { key: "" } }, journalEntry(7)];
    const entries = normalizeJournal(dirty);
    expect(entries.length).toBe(1);
    expect(entries[0]).toEqual(journalEntry(7));
});

test("normalizeJournal caps the result at the limit, dropping the oldest first", () => {
    const many = [1, 2, 3, 4, 5].map(journalEntry);
    expect(normalizeJournal(many, 2).map((entry) => entry.seq)).toEqual([4, 5]);
    expect(normalizeJournal(many, 0)).toEqual([]);
    expect(normalizeJournal(many).length).toBe(5);
});

test("normalizeJournalEntry fills recoverable gaps and drops unreadable params", () => {
    const entry = expectEntry({ kind: "node.move", at: 42, summary: { key: "canvas.journal.nodeMove", params: { title: "T", count: 1, bad: true, nan: Number.NaN } }, actor: { kind: "ghost" }, targets: { nodeIds: ["a", "a", "", 7], edgeIds: "x" } });
    expect(entry.seq).toBe(0);
    expect(entry.id).toBe("node.move-42");
    expect(entry.actor).toEqual({ kind: "system" });
    expect(entry.targets).toEqual({ nodeIds: ["a"] });
    expect(entry.summary.params).toEqual({ title: "T", count: 1 });
    expect("patch" in entry).toBe(false);
    expect("meta" in entry).toBe(false);
});

test("normalizeJournalEntry keeps known actor/seq/id and passes patch/meta through", () => {
    const entry = expectEntry({
        seq: 9,
        id: "keep-me",
        at: 100,
        actor: { kind: "agent", id: "a1", name: "Ada" },
        kind: "agent.tool",
        targets: { edgeIds: ["e1"] },
        summary: { key: "canvas.journal.agentTool" },
        patch: { after: { x: 1 } },
        meta: { fields: ["added"] },
    });
    expect(entry).toEqual({
        seq: 9,
        id: "keep-me",
        at: 100,
        actor: { kind: "agent", id: "a1", name: "Ada" },
        kind: "agent.tool",
        targets: { edgeIds: ["e1"] },
        summary: { key: "canvas.journal.agentTool" },
        patch: { after: { x: 1 } },
        meta: { fields: ["added"] },
    });
});

test("normalizeJournalEntry drops anything without a renderable kind/at/summary key", () => {
    expect(normalizeJournalEntry(null)).toBeNull();
    expect(normalizeJournalEntry("node.add")).toBeNull();
    expect(normalizeJournalEntry([{ kind: "node.add", at: 1, summary: { key: "k" } }])).toBeNull();
    expect(normalizeJournalEntry({ kind: "unknown", at: 1, summary: { key: "k" } })).toBeNull();
    expect(normalizeJournalEntry({ kind: "node.add", at: "1", summary: { key: "k" } })).toBeNull();
    expect(normalizeJournalEntry({ kind: "node.add", summary: { key: "k" } })).toBeNull();
    expect(normalizeJournalEntry({ kind: "node.add", at: 1 })).toBeNull();
});

// --- performance smoke -------------------------------------------------------------------------

test("diffing a large snapshot does not throw and stays readable", () => {
    const nodes = Array.from({ length: 200 }, (_, index) => node(`n${String(index).padStart(3, "0")}`, { position: { x: index, y: index } }));
    const connections = Array.from({ length: 190 }, (_, index) => edge(`e${index}`, nodes[index].id, nodes[index + 1].id));
    const prev = snapshot(nodes, connections);
    const next = snapshot(
        nodes.map((item) => ({ ...item, position: { x: item.position.x + 1, y: item.position.y } })),
        connections,
    );

    const entries = diffCanvasSnapshots(prev, next, ACTOR, deterministicOpts());
    expect(entries.length).toBe(200);
    expect(entries.every((entry) => entry.kind === "node.move")).toBe(true);
    expect(entries[0].targets.nodeIds).toEqual(["n000"]);
});

// --- i18n parity -------------------------------------------------------------------------------

const JOURNAL_KEYS = [
    "nodeAdd",
    "nodeRemove",
    "nodeUpdate",
    "nodeMove",
    "nodeResize",
    "nodeContent",
    "nodeImageEdit",
    "edgeAdd",
    "edgeRemove",
    "edgeUpdate",
    "projectRename",
    "agentTurn",
    "agentTool",
    "actorUser",
    "actorAgent",
    "actorSystem",
    "panelTitle",
    "panelEmpty",
    "panelHint",
    "panelOutOfWindow",
    "panelCurrent",
    "panelJump",
    "panelChangeCount",
    "panelHidden",
    "panelLargeRef",
    "panelTruncated",
];

const lookup = (locale: Record<string, unknown>, path: string): unknown => path.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), locale);

test("canvas.journal exposes the same keys on both locales", () => {
    const zh = Object.keys((zhCN as { canvas: { journal: Record<string, unknown> } }).canvas.journal).sort();
    const en = Object.keys((enUS as { canvas: { journal: Record<string, unknown> } }).canvas.journal).sort();
    expect(zh).toEqual(en);
    expect(zh).toEqual([...JOURNAL_KEYS].sort());
});

test("every journal kind has an i18n key that resolves in both locales", () => {
    const prev = snapshot([]);
    const next = snapshot([node("a", { title: "Hero" }), node("b")], [edge("e1", "a", "b")]);
    const emitted = new Set([...diffCanvasSnapshots(prev, next, ACTOR).map((entry) => entry.summary.key), ...diffCanvasSnapshots({ title: "x" }, { title: "y" }, ACTOR).map((entry) => entry.summary.key)]);
    expect(emitted.size).toBeGreaterThan(0);
    for (const key of emitted) {
        expect(typeof lookup(zhCN as Record<string, unknown>, key)).toBe("string");
        expect(typeof lookup(enUS as Record<string, unknown>, key)).toBe("string");
    }
    expect(emitted).toEqual(new Set(["canvas.journal.nodeAdd", "canvas.journal.edgeAdd", "canvas.journal.projectRename"]));
});

test("CANVAS_JOURNAL_KINDS covers the kinds the diff can emit", () => {
    for (const kind of ["node.add", "node.remove", "node.update", "node.move", "node.resize", "node.content", "node.image-edit", "edge.add", "edge.remove", "edge.update", "project.rename", "agent.turn", "agent.tool"]) {
        expect(CANVAS_JOURNAL_KINDS).toContain(kind as CanvasJournalEntry["kind"]);
    }
});
