import { expect, test } from "bun:test";

import enUS from "../src/i18n/locales/en-US";
import zhCN from "../src/i18n/locales/zh-CN";
import { CANVAS_NODE_STAGES } from "../src/lib/canvas/canvas-stage-utils";
import { buildStageTimeline, computeStageProgress, nextActionHint, timelineToDot } from "../src/lib/canvas/canvas-timeline-utils";

function node(id: string, stage?: string, title = id) {
    return { id, title, metadata: stage === undefined ? {} : { stage } };
}

// --- bucketing ------------------------------------------------------------------------------

test("buildStageTimeline buckets nodes by stage and keeps the canonical stage order", () => {
    const timeline = buildStageTimeline([node("a", "design"), node("b", "requirement"), node("c", "design")]);
    expect(timeline.stages.map((entry) => entry.stage)).toEqual(CANVAS_NODE_STAGES);
    expect(timeline.stages.find((entry) => entry.stage === "requirement")!.count).toBe(1);
    const design = timeline.stages.find((entry) => entry.stage === "design")!;
    expect(design.count).toBe(2);
    expect(design.nodes.map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(timeline.unassigned).toEqual([]);
});

test("buildStageTimeline preserves the input order inside a single bucket", () => {
    const ids = ["code-3", "code-1", "code-2", "code-0"];
    const timeline = buildStageTimeline(ids.map((id) => node(id, "code")));
    const code = timeline.stages.find((entry) => entry.stage === "code")!;
    expect(code.nodes.map((entry) => entry.id)).toEqual(ids);
});

test("buildStageTimeline keeps a stable order across interleaved stages", () => {
    const timeline = buildStageTimeline([node("t1", "test"), node("c1", "code"), node("t2", "test"), node("c2", "code")]);
    expect(timeline.stages.find((entry) => entry.stage === "test")!.nodes.map((entry) => entry.id)).toEqual(["t1", "t2"]);
    expect(timeline.stages.find((entry) => entry.stage === "code")!.nodes.map((entry) => entry.id)).toEqual(["c1", "c2"]);
});

test("buildStageTimeline routes nodes without a known stage to unassigned", () => {
    const timeline = buildStageTimeline([node("a"), node("b", "bogus"), node("c", "test"), node("d")]);
    expect(timeline.unassigned.map((entry) => entry.id)).toEqual(["a", "b", "d"]);
    expect(timeline.unassigned.every((entry) => entry.stage === undefined)).toBe(true);
    expect(timeline.stages.find((entry) => entry.stage === "test")!.count).toBe(1);
});

test("buildStageTimeline ignores entries without a usable id", () => {
    const timeline = buildStageTimeline([{ id: "", title: "x", metadata: { stage: "code" } }]);
    expect(timeline.stages.every((entry) => entry.count === 0)).toBe(true);
    expect(timeline.unassigned).toEqual([]);
});

test("buildStageTimeline honours a custom stage order and treats unknown-to-order stages as unassigned", () => {
    const timeline = buildStageTimeline([node("a", "runtime"), node("b", "code")], ["code"]);
    expect(timeline.stages.map((entry) => entry.stage)).toEqual(["code"]);
    expect(timeline.stages[0].count).toBe(1);
    expect(timeline.unassigned.map((entry) => entry.id)).toEqual(["a"]);
});

test("buildStageTimeline defaults to an empty, stage-complete skeleton", () => {
    const timeline = buildStageTimeline();
    expect(timeline.stages.map((entry) => entry.stage)).toEqual(CANVAS_NODE_STAGES);
    expect(timeline.stages.every((entry) => entry.count === 0)).toBe(true);
    expect(timeline.unassigned).toEqual([]);
});

// --- progress -------------------------------------------------------------------------------

test("computeStageProgress scores an empty timeline as zero progress", () => {
    const progress = computeStageProgress(buildStageTimeline([]));
    expect(progress.total).toBe(6);
    expect(progress.filledCount).toBe(0);
    expect(progress.completionRatio).toBe(0);
    expect(progress.stages.every((entry) => entry.filled === false)).toBe(true);
});

test("computeStageProgress counts one stage as one sixth", () => {
    const progress = computeStageProgress(buildStageTimeline([node("a", "requirement"), node("b", "requirement")]));
    expect(progress.filledCount).toBe(1);
    expect(progress.completionRatio).toBeCloseTo(1 / 6);
    expect(progress.stages.find((entry) => entry.stage === "requirement")).toEqual({ stage: "requirement", count: 2, filled: true });
});

test("computeStageProgress reports a full timeline as complete", () => {
    const progress = computeStageProgress(buildStageTimeline(CANVAS_NODE_STAGES.map((stage) => node(stage, stage))));
    expect(progress.filledCount).toBe(6);
    expect(progress.completionRatio).toBe(1);
    expect(progress.stages.every((entry) => entry.filled)).toBe(true);
});

test("computeStageProgress ignores unassigned nodes when scoring stages", () => {
    const progress = computeStageProgress(buildStageTimeline([node("a"), node("b", "bogus")]));
    expect(progress.filledCount).toBe(0);
    expect(progress.completionRatio).toBe(0);
});

test("computeStageProgress never divides by zero for an empty stage list", () => {
    const progress = computeStageProgress({ stages: [], unassigned: [] });
    expect(progress.total).toBe(0);
    expect(progress.filledCount).toBe(0);
    expect(progress.completionRatio).toBe(0);
});

// --- next action hint -----------------------------------------------------------------------

test("nextActionHint points at the earliest empty stage", () => {
    const timeline = buildStageTimeline([node("a", "requirement"), node("b", "requirement")]);
    expect(nextActionHint(timeline)).toEqual({ stage: "design", count: 0, totalNodes: 2 });
});

test("nextActionHint returns null once every stage holds a node", () => {
    const timeline = buildStageTimeline(CANVAS_NODE_STAGES.map((stage) => node(stage, stage)));
    expect(nextActionHint(timeline)).toBeNull();
});

test("nextActionHint on an empty canvas asks for the first stage", () => {
    expect(nextActionHint(buildStageTimeline([]))).toEqual({ stage: "requirement", count: 0, totalNodes: 0 });
});

test("nextActionHint skips a filled early stage to reach the first gap", () => {
    const timeline = buildStageTimeline([node("a", "requirement"), node("b", "design"), node("c", "design")]);
    expect(nextActionHint(timeline)).toEqual({ stage: "code", count: 0, totalNodes: 3 });
});

// --- dot export -----------------------------------------------------------------------------

test("timelineToDot is deterministic and reflects per-stage counts", () => {
    const dot = timelineToDot(buildStageTimeline([node("a", "code"), node("b", "code")]));
    expect(dot).toBe(timelineToDot(buildStageTimeline([node("a", "code"), node("b", "code")])));
    expect(dot.startsWith('digraph timeline {\n  rankdir="LR";')).toBe(true);
    expect(dot.endsWith("}")).toBe(true);
    expect(dot).toContain('stage_code [label="code (2)"]');
    expect(dot).toContain('stage_requirement [label="requirement (0)"]');
    expect(dot).toContain("stage_requirement -> stage_design");
    expect(dot).toContain("stage_test -> stage_runtime");
});

test("timelineToDot emits an unassigned node only when there is one", () => {
    expect(timelineToDot(buildStageTimeline([node("a")]))).toContain('unassigned [label="unassigned (1)"]');
    expect(timelineToDot(buildStageTimeline([]))).not.toContain("unassigned [");
});

// --- i18n parity ----------------------------------------------------------------------------

function flattenKeys(value: unknown, prefix = ""): string[] {
    if (typeof value !== "object" || value === null) return [prefix];
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

const zhKeys = new Set(flattenKeys(zhCN));
const enKeys = new Set(flattenKeys(enUS));

test("zh-CN and en-US expose exactly the same key paths", () => {
    expect([...zhKeys].filter((key) => !enKeys.has(key))).toEqual([]);
    expect([...enKeys].filter((key) => !zhKeys.has(key))).toEqual([]);
});

test("every stage timeline i18n key exists in both locales", () => {
    const required = ["title", "open", "close", "progress", "todo", "next", "complete", "unassigned"].map((key) => `canvas.timeline.${key}`);
    expect(required.filter((key) => !zhKeys.has(key))).toEqual([]);
    expect(required.filter((key) => !enKeys.has(key))).toEqual([]);
});

test("canvas.timeline exposes an identical key set in both locales", () => {
    const zhTimeline = [...zhKeys].filter((key) => key.startsWith("canvas.timeline.")).sort();
    const enTimeline = [...enKeys].filter((key) => key.startsWith("canvas.timeline.")).sort();
    expect(zhTimeline.length).toBeGreaterThan(0);
    expect(zhTimeline).toEqual(enTimeline);
});
