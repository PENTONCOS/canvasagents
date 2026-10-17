import { expect, test } from "bun:test";

import { CANVAS_NODE_STAGES, normalizeStage, withNodeStage } from "../src/lib/canvas/canvas-stage-utils";

// The timeline buckets nodes by metadata.stage, but nothing in the app ever wrote that field, so
// every node showed up as "unassigned" with no way out. These tests pin the write path.

test("assigning a stage writes metadata.stage", () => {
    expect(withNodeStage(undefined, "code")).toEqual({ stage: "code" });
    expect(withNodeStage({ stage: "design" }, "runtime")).toEqual({ stage: "runtime" });
});

test("assigning keeps unrelated metadata intact", () => {
    expect(withNodeStage({ stage: "design", content: "x" }, "test")).toEqual({ stage: "test", content: "x" });
});

test("clearing a stage removes the key entirely (no stray stage: undefined)", () => {
    const next = withNodeStage({ stage: "code", content: "y" }, undefined);
    expect(next).toEqual({ content: "y" });
    expect("stage" in next).toBe(false);
    expect(normalizeStage(next.stage)).toBeUndefined();
});

test("does not mutate the metadata it was handed", () => {
    const original = { stage: "design" as const, content: "z" };
    withNodeStage(original, "runtime");
    expect(original).toEqual({ stage: "design", content: "z" });
});

test("every assignable stage survives normalizeStage, so it lands in a bucket", () => {
    for (const stage of CANVAS_NODE_STAGES) {
        expect(normalizeStage(withNodeStage(undefined, stage).stage)).toBe(stage);
    }
});
