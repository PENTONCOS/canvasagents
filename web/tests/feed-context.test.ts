import { describe, expect, test } from "bun:test";

import { buildFeedPrompt, collectEvidenceNodeIds, feedKindOf, feedableNodes, isFeedableNode, type FeedLookup } from "@/lib/delivery/feed-context";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { AcceptanceCriterion, DeliveryAnnotation, DeliveryBug, DeliveryEnvironment, DesignVariant, Journey } from "@/types/delivery";

function node(overrides: Partial<CanvasNodeData> & Pick<CanvasNodeData, "id" | "type">): CanvasNodeData {
    return { title: overrides.id, position: { x: 0, y: 0 }, width: 320, height: 240, ...overrides };
}

const emptyLookup: FeedLookup = {
    bugs: {},
    annotations: {},
    acceptance: {},
    journeys: {},
    designs: {},
    environments: {},
};

function bug(overrides: Partial<DeliveryBug> & Pick<DeliveryBug, "id">): DeliveryBug {
    return { title: overrides.id, severity: "major", violates: [], status: "open", fixRunIds: [], ...overrides };
}

function ac(overrides: Partial<AcceptanceCriterion> & Pick<AcceptanceCriterion, "id">): AcceptanceCriterion {
    return { statement: overrides.id, journeyIds: [], stepIds: [], testCaseIds: [], status: "draft", ...overrides };
}

describe("框选任意节点 → 结构化投喂", () => {
    test("配置节点和分组框不参与投喂，其余类型都有归属", () => {
        expect(feedKindOf(node({ id: "cfg", type: CanvasNodeType.Config }))).toBeNull();
        expect(feedKindOf(node({ id: "grp", type: CanvasNodeType.Group }))).toBeNull();
        expect(isFeedableNode(node({ id: "cfg", type: CanvasNodeType.Config }))).toBe(false);
        expect(feedKindOf(node({ id: "req", type: CanvasNodeType.Requirement }))).toBe("requirement");
        expect(feedKindOf(node({ id: "js", type: CanvasNodeType.JourneyStep }))).toBe("journey");
        expect(feedKindOf(node({ id: "tc", type: CanvasNodeType.TestCase }))).toBe("acceptance");
        expect(feedKindOf(node({ id: "vd", type: CanvasNodeType.Video }))).toBe("media");
    });

    test("只有不可投喂内容时不生成提示词（调用方据此不发）", () => {
        const prompt = buildFeedPrompt([node({ id: "cfg", type: CanvasNodeType.Config }), node({ id: "grp", type: CanvasNodeType.Group })], emptyLookup);
        expect(prompt).toBe("");
        expect(feedableNodes([node({ id: "cfg", type: CanvasNodeType.Config })])).toHaveLength(0);
    });

    test("按内容类型分组，顺序固定：需求 → 旅程 → 验收 → 设计 → 问题单 → 图片", () => {
        const prompt = buildFeedPrompt(
            [
                node({ id: "img", type: CanvasNodeType.Image }),
                node({ id: "acc", type: CanvasNodeType.Acceptance, metadata: { acId: "AC-01" } }),
                node({ id: "req", type: CanvasNodeType.Requirement, metadata: { content: "做一个落地页" } }),
                node({ id: "bug", type: CanvasNodeType.Bug, metadata: { bugId: "BUG-01" } }),
            ],
            { ...emptyLookup, acceptance: { "AC-01": ac({ id: "AC-01", statement: "首屏三秒内可见" }) }, bugs: { "BUG-01": bug({ id: "BUG-01", title: "按钮点不动" }) } },
        );
        const positions = ["【需求】", "【验收标准】", "【问题单】", "【图片】"].map((section) => prompt.indexOf(section));
        expect(positions.every((index) => index >= 0)).toBe(true);
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
        // 旅程、设计、环境本次没有选中，对应的分组标题不应出现。
        expect(prompt).not.toContain("【用户旅程】");
        expect(prompt).not.toContain("【环境】");
        expect(prompt).toContain("AC-01 首屏三秒内可见");
        expect(prompt).toContain("BUG-01");
        expect(prompt).toContain("按钮点不动");
    });

    test("问题单带上严重级、违反的 AC 与圈注编号，Agent 不必再问是哪条标准", () => {
        const annotations: Record<string, DeliveryAnnotation> = {
            "AN-01": { id: "AN-01", nodeId: "shot-1", shape: "rect", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, label: 3, createdAt: 1, bugId: "BUG-02" },
        };
        const prompt = buildFeedPrompt([node({ id: "bug", type: CanvasNodeType.Bug, metadata: { bugId: "BUG-02" } })], {
            ...emptyLookup,
            annotations,
            bugs: { "BUG-02": bug({ id: "BUG-02", title: "提交没反应", severity: "blocker", violates: ["AC-04", "AC-07"] }) },
        });
        expect(prompt).toContain("BUG-02");
        expect(prompt).toContain("blocker");
        expect(prompt).toContain("AC-04, AC-07");
        expect(prompt).toContain("#3");
    });

    test("设计稿标出选定/候选，避免 Agent 同时实现三个版本", () => {
        const designs: Record<string, DesignVariant> = {
            "D-01-A": { id: "D-01-A", label: "A", selected: false, nodeId: "design-a" },
            "D-01-B": { id: "D-01-B", label: "B", selected: true, nodeId: "design-b" },
        };
        const prompt = buildFeedPrompt(
            [node({ id: "design-a", type: CanvasNodeType.Design, metadata: { variantLabel: "A" } }), node({ id: "design-b", type: CanvasNodeType.Design, metadata: { variantLabel: "B" } })],
            { ...emptyLookup, designs },
        );
        expect(prompt).toContain("A（候选）");
        expect(prompt).toContain("B（已选定）");
    });

    test("环境节点带出名称、URL 与版本，便于 Agent 判断往哪部署", () => {
        const environments: Record<string, DeliveryEnvironment> = {
            "ENV-01": { id: "ENV-01", name: "staging", url: "https://stage.example.com", version: "v1.2.0", status: "healthy" },
        };
        const prompt = buildFeedPrompt([node({ id: "env", type: CanvasNodeType.Environment, metadata: { envId: "ENV-01" } })], { ...emptyLookup, environments });
        expect(prompt).toContain("ENV-01");
        expect(prompt).toContain("https://stage.example.com");
        expect(prompt).toContain("v1.2.0");
    });

    test("长正文截断，不把整篇文本塞进提示词", () => {
        const long = "甲".repeat(200);
        const prompt = buildFeedPrompt([node({ id: "txt", type: CanvasNodeType.Text, metadata: { content: long } })], emptyLookup);
        expect(prompt).toContain("…");
        expect(prompt.length).toBeLessThan(long.length);
    });

    test("证据截图沿「问题单 → 圈注 → 截图节点」取，且不重复引用已选中的图", () => {
        const annotations: Record<string, DeliveryAnnotation> = {
            "AN-01": { id: "AN-01", nodeId: "shot-1", shape: "rect", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, label: 1, createdAt: 1, bugId: "BUG-01" },
            "AN-02": { id: "AN-02", nodeId: "shot-2", shape: "rect", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, label: 2, createdAt: 2, bugId: "BUG-01" },
        };
        const bugs = { "BUG-01": bug({ id: "BUG-01" }) };
        const selected = [node({ id: "bug", type: CanvasNodeType.Bug, metadata: { bugId: "BUG-01" } }), node({ id: "shot-2", type: CanvasNodeType.Image })];
        expect(collectEvidenceNodeIds(selected, { bugs, annotations })).toEqual(["shot-1"]);
    });

    test("没有圈注的问题单不产生证据引用，也不误报", () => {
        const selected = [node({ id: "bug", type: CanvasNodeType.Bug, metadata: { bugId: "BUG-09" } })];
        expect(collectEvidenceNodeIds(selected, { bugs: { "BUG-09": bug({ id: "BUG-09" }) }, annotations: {} })).toEqual([]);
    });

    test("旅程节点用实体标题而不是节点标题（节点常被改名）", () => {
        const journeys: Record<string, Journey> = { "J-01": { id: "J-01", title: "新用户注册", stepIds: [], nodeId: "journey" } };
        const prompt = buildFeedPrompt([node({ id: "journey", type: CanvasNodeType.Journey, title: "节点上的旧名字" })], { ...emptyLookup, journeys });
        expect(prompt).toContain("J-01 新用户注册");
    });
});
