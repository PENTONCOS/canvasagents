import { describe, expect, test } from "bun:test";

import { buildContextSections, contextSignature } from "@/lib/agent/context-bar";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { AcceptanceCriterion, DesignVariant } from "@/types/delivery";

function node(overrides: Partial<CanvasNodeData> & Pick<CanvasNodeData, "id" | "type">): CanvasNodeData {
    return { title: overrides.id, position: { x: 0, y: 0 }, width: 320, height: 240, ...overrides };
}

function ac(overrides: Partial<AcceptanceCriterion> & Pick<AcceptanceCriterion, "id">): AcceptanceCriterion {
    return { statement: overrides.id, journeyIds: [], stepIds: [], testCaseIds: [], status: "draft", ...overrides };
}

function design(overrides: Partial<DesignVariant> & Pick<DesignVariant, "id">): DesignVariant {
    return { label: "A", selected: false, ...overrides };
}

describe("C2 上下文条聚合", () => {
    test("空画布不生成任何条目（调用方据此不渲染）", () => {
        expect(buildContextSections({ nodes: [] })).toEqual([]);
    });

    test("配置节点与分组框不进上下文条", () => {
        const sections = buildContextSections({
            nodes: [node({ id: "cfg", type: CanvasNodeType.Config }), node({ id: "grp", type: CanvasNodeType.Group })],
        });
        expect(sections).toEqual([]);
    });

    test("分组顺序固定：需求 → 旅程 → 验收 → 设计", () => {
        const sections = buildContextSections({
            nodes: [
                node({ id: "d1", type: CanvasNodeType.Design }),
                node({ id: "ac1", type: CanvasNodeType.Acceptance }),
                node({ id: "j1", type: CanvasNodeType.Journey }),
                node({ id: "r1", type: CanvasNodeType.Requirement }),
            ],
        });
        expect(sections.map((section) => section.kind)).toEqual(["requirement", "journey", "acceptance", "design"]);
    });

    test("同类节点合并计数，标题按原顺序保留", () => {
        const sections = buildContextSections({
            nodes: [
                node({ id: "r1", type: CanvasNodeType.Requirement, title: "落地页需求" }),
                node({ id: "r2", type: CanvasNodeType.Requirement, title: "定价页需求" }),
            ],
        });
        expect(sections).toHaveLength(1);
        expect(sections[0]).toMatchObject({ kind: "requirement", count: 2, titles: ["落地页需求", "定价页需求"] });
    });

    test("验收节点回指实体：给出总数与通过数", () => {
        const sections = buildContextSections({
            nodes: [node({ id: "ac1", type: CanvasNodeType.Acceptance })],
            acceptance: {
                "AC-01": ac({ id: "AC-01", nodeId: "ac1", status: "passing" }),
                "AC-02": ac({ id: "AC-02", nodeId: "ac1", status: "failing" }),
                "AC-03": ac({ id: "AC-03", nodeId: "ac1", status: "passing" }),
                "AC-09": ac({ id: "AC-09", nodeId: "unrelated", status: "passing" }),
            },
        });
        expect(sections[0]).toMatchObject({ kind: "acceptance", count: 1, total: 3, passing: 2 });
    });

    test("没有绑定实体时不下发通过数，避免显示 0/0", () => {
        const sections = buildContextSections({ nodes: [node({ id: "ac1", type: CanvasNodeType.Acceptance })] });
        expect(sections[0].total).toBeUndefined();
        expect(sections[0].passing).toBeUndefined();
    });

    test("设计节点给出已选定版本数", () => {
        const sections = buildContextSections({
            nodes: [node({ id: "d1", type: CanvasNodeType.Design })],
            designs: {
                "D-01-A": design({ id: "D-01-A", nodeId: "d1", selected: false }),
                "D-01-B": design({ id: "D-01-B", nodeId: "d1", label: "B", selected: true }),
            },
        });
        expect(sections[0]).toMatchObject({ kind: "design", count: 1, selected: 1 });
    });

    test("标题为空串的节点不会在提示里留空档", () => {
        const sections = buildContextSections({ nodes: [node({ id: "t1", type: CanvasNodeType.Text, title: "" })] });
        expect(sections[0].titles).toEqual([]);
    });

    test("签名只随分类/数量/状态变化，拖动画布不触发重渲染", () => {
        const nodes = [node({ id: "r1", type: CanvasNodeType.Requirement, position: { x: 0, y: 0 } })];
        const before = buildContextSections({ nodes });
        const moved = [node({ id: "r1", type: CanvasNodeType.Requirement, position: { x: 480, y: 240 } })];
        const after = buildContextSections({ nodes: moved });
        expect(contextSignature(after)).toBe(contextSignature(before));

        const added = [...moved, node({ id: "r2", type: CanvasNodeType.Requirement })];
        expect(contextSignature(buildContextSections({ nodes: added }))).not.toBe(contextSignature(before));
    });
});
