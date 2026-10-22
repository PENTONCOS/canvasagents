import { describe, expect, test } from "bun:test";

import { createCanvasNode } from "../src/lib/canvas/canvas-node-factory";
import { buildDesignSelectionOps, designGroupKey } from "../src/lib/delivery/design-selection";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function designNode(id: string, label: string, anchor: string, selected: boolean): CanvasNodeData {
    const node = createCanvasNode(CanvasNodeType.Design, { x: 0, y: 0 });
    node.id = id;
    node.metadata = { ...node.metadata, variantLabel: label, variantOf: anchor, selected };
    return node;
}

describe("design selection ops", () => {
    test("选定 B 后 A 的 selected 回写为 false，且同组恰一版选中", () => {
        const a = designNode("node-a", "A", "node-a", true);
        const b = designNode("node-b", "B", "node-a", false);
        const c = designNode("node-c", "C", "node-a", false);

        const ops = buildDesignSelectionOps([a, b, c], "node-b");

        expect(ops).toHaveLength(3);
        const selected = ops.flatMap((op) => (op.type === "update_node" && op.metadata?.selected ? [op.id] : []));
        expect(selected).toEqual(["node-b"]);
        const aOp = ops.find((op) => op.type === "update_node" && op.id === "node-a");
        expect(aOp && aOp.type === "update_node" ? aOp.metadata?.selected : undefined).toBe(false);
    });

    test("不碰其它分组的设计版本", () => {
        const a = designNode("node-a", "A", "node-a", true);
        const b = designNode("node-b", "B", "node-a", false);
        const other = designNode("node-x", "A", "node-x", true);

        const ops = buildDesignSelectionOps([a, b, other], "node-b");

        expect(ops.map((op) => (op.type === "update_node" ? op.id : ""))).toEqual(["node-a", "node-b"]);
    });

    test("非设计节点不产生操作", () => {
        const requirement = createCanvasNode(CanvasNodeType.Requirement, { x: 0, y: 0 });
        requirement.id = "req-1";
        expect(buildDesignSelectionOps([requirement], "req-1")).toEqual([]);
        expect(buildDesignSelectionOps([requirement], "missing")).toEqual([]);
    });

    test("锚点键：A 版用自己的 id，B/C 指向锚点", () => {
        const a = designNode("node-a", "A", "node-a", true);
        const b = designNode("node-b", "B", "node-a", false);
        expect(designGroupKey(a)).toBe("node-a");
        expect(designGroupKey(b)).toBe("node-a");
    });
});
