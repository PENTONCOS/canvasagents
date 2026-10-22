import { describe, expect, test } from "bun:test";

import { createCanvasNode } from "@/lib/canvas/canvas-node-factory";
import { patchNodeMetadata } from "@/lib/canvas/node-updates";
import { REQUIREMENT_NODE_TYPE, normalizeRequirementDraft, requirementContent, requirementOrdinal } from "@/lib/canvas/requirement-node-utils";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function requirement(id: string, content: string): CanvasNodeData {
    return { id, type: CanvasNodeType.Requirement, title: "需求便签", position: { x: 0, y: 0 }, width: 340, height: 120, metadata: { content } };
}

describe("A4 需求便签：多条并列，各自独立持久化", () => {
    test("连续新建两条便签：id 唯一、默认正文独立，不是同一个 metadata 引用", () => {
        const first = createCanvasNode(CanvasNodeType.Requirement, { x: 100, y: 100 });
        const second = createCanvasNode(CanvasNodeType.Requirement, { x: 500, y: 100 });
        expect(first.type).toBe(REQUIREMENT_NODE_TYPE);
        expect(second.type).toBe(REQUIREMENT_NODE_TYPE);
        expect(first.id).not.toBe(second.id);
        expect(first.metadata).not.toBe(second.metadata);
        expect(requirementContent(first)).toBe("");
        expect(requirementContent(second)).toBe("");
        // 改一条的 metadata 不会顺着共享引用改到另一条。
        first.metadata = { ...first.metadata, content: "支持提前改约" };
        expect(requirementContent(first)).toBe("支持提前改约");
        expect(requirementContent(second)).toBe("");
    });

    test("更新一条便签的正文，兄弟节点原样保留（含对象引用与顺序）", () => {
        const first = requirement("requirement-1", "支持提前 24 小时改约");
        const second = requirement("requirement-2", "改约成功后短信通知双方");
        const nodes: CanvasNodeData[] = [first, second];

        const next = patchNodeMetadata(nodes, second.id, { content: "改约后短信通知双方（新）" });
        expect(requirementContent(next[0])).toBe("支持提前 24 小时改约");
        expect(requirementContent(next[1])).toBe("改约后短信通知双方（新）");
        // 未命中的节点必须是原对象，不能被整体复制或重建。
        expect(next[0]).toBe(first);
        expect(next.map((node) => node.id)).toEqual(["requirement-1", "requirement-2"]);
        // 原数组不被就地修改。
        expect(requirementContent(nodes[1])).toBe("改约成功后短信通知双方");
    });

    test("序号只数需求便签、按画布顺序稳定；其它节点不占号", () => {
        const nodes: CanvasNodeData[] = [
            { id: "text-1", type: CanvasNodeType.Text, title: "文本", position: { x: 0, y: 0 }, width: 100, height: 100 },
            requirement("requirement-a", "第一条"),
            { id: "image-1", type: CanvasNodeType.Image, title: "图片", position: { x: 0, y: 0 }, width: 100, height: 100 },
            requirement("requirement-b", "第二条"),
        ];
        expect(requirementOrdinal(nodes, "requirement-a")).toBe(1);
        expect(requirementOrdinal(nodes, "requirement-b")).toBe(2);
        expect(requirementOrdinal(nodes, "text-1")).toBe(0);
        expect(requirementOrdinal(nodes, "missing")).toBe(0);
        // 再加一条排在最后，前两条编号不变。
        expect(requirementOrdinal([...nodes, requirement("requirement-c", "第三条")], "requirement-a")).toBe(1);
        expect(requirementOrdinal([...nodes, requirement("requirement-c", "第三条")], "requirement-c")).toBe(3);
    });

    test("正文优先 content，兼容旧数据的 statement；一句话会折掉换行与多余空白", () => {
        expect(requirementContent(requirement("r", "用 content"))).toBe("用 content");
        expect(requirementContent({ ...requirement("r", ""), metadata: { statement: "旧的 statement" } })).toBe("旧的 statement");
        expect(normalizeRequirementDraft("  支持\n提前\t改约  ")).toBe("支持 提前 改约");
        expect(normalizeRequirementDraft(undefined)).toBe("");
    });
});
