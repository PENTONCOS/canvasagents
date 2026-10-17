import { expect, test } from "bun:test";

import { EDITOR_ENGINE_NAME, EDITOR_ENGINE_VERSION, buildEditorSavePatch } from "../src/lib/canvas/editor-bridge";
import { CANVAS_NODE_HISTORY_LIMIT, appendNodeEdit, normalizeNodeEditLimit, normalizeNodeEditRecord, normalizeNodeHistory } from "../src/lib/canvas/canvas-node-history";
import { CANVAS_NODE_ACTIVITY_LIMIT, buildNodeActivity } from "../src/lib/canvas/canvas-timeline-utils";
import enUS from "../src/i18n/locales/en-US";
import zhCN from "../src/i18n/locales/zh-CN";
import type { CanvasNodeEditRecord } from "../src/types/canvas";

const psEdit = (at: number): CanvasNodeEditRecord => ({ kind: "ps-edit", at, engine: EDITOR_ENGINE_NAME, version: EDITOR_ENGINE_VERSION });

const keyPaths = (value: unknown, prefix = ""): string[] =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key)) : prefix ? [prefix] : [];

// --- appendNodeEdit ---------------------------------------------------------------------------

test("appendNodeEdit appends oldest-first and never mutates the input array", () => {
    const original: CanvasNodeEditRecord[] = [psEdit(1)];
    const snapshot = JSON.stringify(original);
    const next = appendNodeEdit(original, psEdit(2));
    expect(next.map((entry) => entry.at)).toEqual([1, 2]);
    expect(original.map((entry) => entry.at)).toEqual([1]);
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(next).not.toBe(original);
});

test("appendNodeEdit copies the record so later caller mutations cannot reach the history", () => {
    const record = psEdit(5);
    const next = appendNodeEdit([], record);
    record.at = 999;
    expect(next[0].at).toBe(5);
    expect(next[0]).not.toBe(record);
});

test("appendNodeEdit treats a missing or non-array history as empty", () => {
    expect(appendNodeEdit(undefined, psEdit(1))).toEqual([{ kind: "ps-edit", at: 1, engine: "miniPaint", version: "4.14.3" }]);
    expect(appendNodeEdit(null, psEdit(1)).length).toBe(1);
    expect(appendNodeEdit("nope", psEdit(1)).length).toBe(1);
    expect(appendNodeEdit({ at: 1 }, psEdit(1)).length).toBe(1);
});

test("appendNodeEdit caps the history at the limit and drops the oldest entries first", () => {
    const history = [1, 2, 3].map((at) => psEdit(at));
    const next = appendNodeEdit(history, psEdit(4), 3);
    expect(next.map((entry) => entry.at)).toEqual([2, 3, 4]);
    expect(next.length).toBe(3);
    expect(history.length).toBe(3);
});

test("appendNodeEdit defaults to the 50-record cap", () => {
    let history: CanvasNodeEditRecord[] = [];
    for (let index = 1; index <= CANVAS_NODE_HISTORY_LIMIT + 10; index += 1) history = appendNodeEdit(history, psEdit(index));
    expect(history.length).toBe(CANVAS_NODE_HISTORY_LIMIT);
    expect(history[0].at).toBe(11);
    expect(history[history.length - 1].at).toBe(CANVAS_NODE_HISTORY_LIMIT + 10);
});

test("appendNodeEdit honours a zero limit by keeping nothing, and falls back on a bogus limit", () => {
    expect(appendNodeEdit([psEdit(1)], psEdit(2), 0)).toEqual([]);
    expect(appendNodeEdit([psEdit(1)], psEdit(2), -5).map((entry) => entry.at)).toEqual([1, 2]);
    expect(appendNodeEdit([psEdit(1)], psEdit(2), Number.NaN).map((entry) => entry.at)).toEqual([1, 2]);
});

test("normalizeNodeEditLimit floors and rejects non-numbers", () => {
    expect(normalizeNodeEditLimit(2.9, 50)).toBe(2);
    expect(normalizeNodeEditLimit(0, 50)).toBe(0);
    expect(normalizeNodeEditLimit("3", 50)).toBe(50);
    expect(normalizeNodeEditLimit(Number.POSITIVE_INFINITY, 50)).toBe(50);
    expect(normalizeNodeEditLimit(undefined, 50)).toBe(50);
});

// --- normalizeNodeEditRecord / normalizeNodeHistory -------------------------------------------

test("normalizeNodeEditRecord keeps known kinds with optional fields and drops empty strings", () => {
    expect(normalizeNodeEditRecord({ kind: "ps-edit", at: 7, engine: "miniPaint", version: "4.14.3", summary: "" })).toEqual({ kind: "ps-edit", at: 7, engine: "miniPaint", version: "4.14.3" });
    expect(normalizeNodeEditRecord({ kind: "region-edit", at: 0 })).toEqual({ kind: "region-edit", at: 0 });
});

test("normalizeNodeEditRecord drops dirty values instead of guessing", () => {
    expect(normalizeNodeEditRecord(null)).toBeNull();
    expect(normalizeNodeEditRecord("ps-edit")).toBeNull();
    expect(normalizeNodeEditRecord([{ kind: "ps-edit", at: 1 }])).toBeNull();
    expect(normalizeNodeEditRecord({ kind: "unknown-kind", at: 1 })).toBeNull();
    expect(normalizeNodeEditRecord({ kind: "ps-edit" })).toBeNull();
    expect(normalizeNodeEditRecord({ kind: "ps-edit", at: "1" })).toBeNull();
    expect(normalizeNodeEditRecord({ kind: "ps-edit", at: Number.NaN })).toBeNull();
    expect(normalizeNodeEditRecord({ at: 1 })).toBeNull();
});

test("normalizeNodeHistory keeps the readable records in order and ignores non-arrays", () => {
    expect(normalizeNodeHistory([{ kind: "ps-edit", at: 2 }, { kind: "bogus", at: 3 }, "x", { kind: "ps-edit", at: 1 }])).toEqual([
        { kind: "ps-edit", at: 2 },
        { kind: "ps-edit", at: 1 },
    ]);
    expect(normalizeNodeHistory(undefined)).toEqual([]);
    expect(normalizeNodeHistory("no")).toEqual([]);
});

// --- buildEditorSavePatch ---------------------------------------------------------------------

test("buildEditorSavePatch appends a ps-edit record stamped with the engine and save time", () => {
    const patch = buildEditorSavePatch(undefined, "data:image/png;base64,NEW", 4242);
    expect(patch.history).toEqual([{ kind: "ps-edit", at: 4242, engine: EDITOR_ENGINE_NAME, version: EDITOR_ENGINE_VERSION }]);
});

test("buildEditorSavePatch keeps the existing history and appends oldest-first", () => {
    const existing: CanvasNodeEditRecord[] = [{ kind: "ps-edit", at: 100, engine: EDITOR_ENGINE_NAME, version: EDITOR_ENGINE_VERSION }];
    const metadata = { history: existing };
    const patch = buildEditorSavePatch(metadata, "data:image/png;base64,NEW", 200);
    expect(patch.history?.map((entry) => entry.at)).toEqual([100, 200]);
    expect(existing.map((entry) => entry.at)).toEqual([100]);
});

test("buildEditorSavePatch keeps the artifact and structure semantics it always had", () => {
    const patch = buildEditorSavePatch({ regions: { source: "old.png", regions: [{ id: "r1", type: "title", bbox: { x: 0, y: 0, w: 10, h: 10 }, text: "Hi" }] } }, "data:image/png;base64,NEW", 1234);
    expect(patch.content).toBe("data:image/png;base64,NEW");
    expect(patch.editor).toEqual({ engine: "miniPaint", version: "4.14.3", lastSavedAt: 1234 });
    expect(patch.regions?.source).toBe("old.png");
    expect(patch.regions?.parsedAt).toBe(1234);
    expect(patch.regions?.regions?.length).toBe(1);
    expect(patch.history?.length).toBe(1);
});

test("buildEditorSavePatch omits the structure layer when the node has none but still logs the edit", () => {
    const patch = buildEditorSavePatch(undefined, "data:image/png;base64,NEW", 99);
    expect("regions" in patch).toBe(false);
    expect(patch.history?.length).toBe(1);
});

// --- buildNodeActivity ------------------------------------------------------------------------

function activityNode(id: string, history: unknown, stage?: string, title?: string) {
    return { id, title: title ?? id, metadata: { history, stage } };
}

test("buildNodeActivity returns an empty list for empty or unusable input", () => {
    expect(buildNodeActivity()).toEqual([]);
    expect(buildNodeActivity([])).toEqual([]);
    expect(buildNodeActivity([{ id: "", title: "x", metadata: { history: [psEdit(1)] } }])).toEqual([]);
    expect(buildNodeActivity([activityNode("a", undefined)])).toEqual([]);
});

test("buildNodeActivity flattens node histories into one stream, newest first", () => {
    const events = buildNodeActivity([activityNode("a", [psEdit(10), psEdit(30)], "design", "Hero banner"), activityNode("b", [psEdit(20)], "code", "Card")]);
    expect(events.map((entry) => [entry.nodeId, entry.at])).toEqual([
        ["a", 30],
        ["b", 20],
        ["a", 10],
    ]);
    expect(events[0]).toEqual({ nodeId: "a", nodeTitle: "Hero banner", stage: "design", kind: "ps-edit", at: 30, engine: EDITOR_ENGINE_NAME, version: EDITOR_ENGINE_VERSION });
    expect(events[1].stage).toBe("code");
});

test("buildNodeActivity breaks ties on nodeId so the order does not depend on node order", () => {
    const nodes = [activityNode("b", [psEdit(5)], "code"), activityNode("a", [psEdit(5)], "design"), activityNode("c", [psEdit(5)], "test")];
    const forward = buildNodeActivity(nodes).map((entry) => entry.nodeId);
    const backward = buildNodeActivity([...nodes].reverse()).map((entry) => entry.nodeId);
    expect(forward).toEqual(["a", "b", "c"]);
    expect(backward).toEqual(["a", "b", "c"]);
});

test("buildNodeActivity is deterministic for identical input", () => {
    const nodes = [activityNode("a", [psEdit(1), psEdit(3)], "design"), activityNode("b", [psEdit(3)], "code")];
    expect(buildNodeActivity(nodes)).toEqual(buildNodeActivity(nodes));
});

test("buildNodeActivity ignores dirty records and unknown stages", () => {
    const events = buildNodeActivity([activityNode("a", [{ kind: "ps-edit", at: Number.NaN }, { kind: "bogus", at: 5 }, "x", psEdit(15)], "bogus-stage")]);
    expect(events.length).toBe(1);
    expect(events[0].at).toBe(15);
    expect(events[0].stage).toBeUndefined();
});

test("buildNodeActivity honours the limit and defaults to the activity cap", () => {
    const many = Array.from({ length: CANVAS_NODE_ACTIVITY_LIMIT + 4 }, (_, index) => psEdit(index + 1));
    const events = buildNodeActivity([activityNode("a", many)]);
    expect(events.length).toBe(CANVAS_NODE_ACTIVITY_LIMIT);
    expect(events[0].at).toBe(CANVAS_NODE_ACTIVITY_LIMIT + 4);
    expect(buildNodeActivity([activityNode("a", [psEdit(1), psEdit(2)])], 1).map((entry) => entry.at)).toEqual([2]);
    expect(buildNodeActivity([activityNode("a", [psEdit(1)])], 0)).toEqual([]);
});

// --- i18n parity ------------------------------------------------------------------------------

test("canvas.timeline activity keys exist on both locales with identical key sets", () => {
    const zhTimeline = keyPaths((zhCN as Record<string, unknown>).canvas)
        .filter((path) => path.startsWith("timeline."))
        .sort();
    const enTimeline = keyPaths((enUS as Record<string, unknown>).canvas)
        .filter((path) => path.startsWith("timeline."))
        .sort();
    expect(zhTimeline).toEqual(enTimeline);
    for (const key of ["timeline.activity", "timeline.activityEmpty", "timeline.activityPsEdit", "timeline.activityRegionEdit"]) {
        expect(zhTimeline).toContain(key);
    }
});

test("the whole canvas namespace stays in sync across locales after the history keys landed", () => {
    const zh = keyPaths((zhCN as Record<string, unknown>).canvas).sort();
    const en = keyPaths((enUS as Record<string, unknown>).canvas).sort();
    expect(en).toEqual(zh);
});
