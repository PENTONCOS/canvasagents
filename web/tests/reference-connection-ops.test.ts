import { expect, test } from "bun:test";

import { referenceConnectionOps } from "../src/lib/canvas/canvas-reference-links";

test("links a referenced canvas asset to the node it produced", () => {
    const ops = referenceConnectionOps(["ref-1"], ["image-new"], ["ref-1"]);
    expect(ops).toEqual([{ type: "connect_nodes", fromNodeId: "ref-1", toNodeId: "image-new" }]);
});

test("links every reference to every generated node", () => {
    const ops = referenceConnectionOps(["ref-1", "ref-2"], ["image-a", "image-b"], ["ref-1", "ref-2"]);
    expect(ops).toEqual([
        { type: "connect_nodes", fromNodeId: "ref-1", toNodeId: "image-a" },
        { type: "connect_nodes", fromNodeId: "ref-1", toNodeId: "image-b" },
        { type: "connect_nodes", fromNodeId: "ref-2", toNodeId: "image-a" },
        { type: "connect_nodes", fromNodeId: "ref-2", toNodeId: "image-b" },
    ]);
});

test("skips references that no longer exist on the canvas", () => {
    expect(referenceConnectionOps(["ref-1", "ref-gone"], ["image-new"], ["ref-1"])).toEqual([{ type: "connect_nodes", fromNodeId: "ref-1", toNodeId: "image-new" }]);
});

test("collapses duplicate references and drops self-links", () => {
    const ops = referenceConnectionOps(["ref-1", "ref-1", "image-new"], ["image-new"], ["ref-1", "image-new"]);
    expect(ops).toEqual([{ type: "connect_nodes", fromNodeId: "ref-1", toNodeId: "image-new" }]);
});

test("returns no ops when there is nothing to link", () => {
    expect(referenceConnectionOps([], ["image-new"], ["image-new"])).toEqual([]);
    expect(referenceConnectionOps(["ref-1"], [], ["ref-1"])).toEqual([]);
    expect(referenceConnectionOps(["ref-1"], ["", "image-new"], ["image-new"])).toEqual([]);
});
