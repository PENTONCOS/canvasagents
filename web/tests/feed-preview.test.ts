import { describe, expect, test } from "bun:test";

import type { FeedLookup } from "../src/lib/delivery/feed-context";
import { cancelFeedPreview, composeFeedPrompt, confirmFeedPreview, createFeedPreview } from "../src/lib/delivery/feed-preview";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const node = (id: string, type: CanvasNodeData["type"], title: string, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({
    id,
    type,
    title,
    position: { x: 0, y: 0 },
    width: 240,
    height: 120,
    metadata,
});

const lookup: FeedLookup = { bugs: {}, annotations: {}, acceptance: {}, journeys: {}, designs: {}, environments: {} };

/** 顺序刻意打乱：拼装必须按 KIND_ORDER 归组，而不是按选中顺序。 */
const mixedSelection: CanvasNodeData[] = [
    node("m1", "markdown", "改约规则", { content: "提前 24 小时可免费改约一次" }),
    node("r1", CanvasNodeType.Requirement, "需求 1", { content: "支持提前改约" }),
    node("s1", "sketch", "首页线框", { sketch: { shapes: [] } }),
    node("r2", CanvasNodeType.Requirement, "需求 2", { content: "改约成功后短信通知" }),
    node("g1", CanvasNodeType.Group, "分组框"),
    node("c1", CanvasNodeType.Config, "配置"),
];

describe("composeFeedPrompt", () => {
    test("多类节点按固定分组顺序输出，组内保持选中顺序", () => {
        const prompt = composeFeedPrompt(mixedSelection, lookup);
        const requirementAt = prompt.indexOf("【需求】");
        const sketchAt = prompt.indexOf("【线框草图】");
        const markdownAt = prompt.indexOf("【Markdown 文档】");
        expect(requirementAt).toBeGreaterThan(-1);
        expect(sketchAt).toBeGreaterThan(-1);
        expect(markdownAt).toBeGreaterThan(-1);
        // KIND_ORDER：需求 → … → markdown → … → sketch。
        expect(requirementAt).toBeLessThan(markdownAt);
        expect(markdownAt).toBeLessThan(sketchAt);
        // 组内顺序与选中顺序一致。
        expect(prompt.indexOf("支持提前改约")).toBeLessThan(prompt.indexOf("改约成功后短信通知"));
        // 配置节点与分组框不参与投喂。
        expect(prompt).not.toContain("分组框");
        expect(prompt).not.toContain("配置");
    });

    test("同一批内容重复拼装结果稳定", () => {
        expect(composeFeedPrompt(mixedSelection, lookup)).toBe(composeFeedPrompt(mixedSelection, lookup));
    });

    test("没有可投喂内容时返回空串", () => {
        expect(composeFeedPrompt([node("g1", CanvasNodeType.Group, "分组框")], lookup)).toBe("");
    });
});

describe("createFeedPreview", () => {
    test("带出目标窗与条数，提示词全文可编辑", () => {
        const preview = createFeedPreview({ nodes: mixedSelection, lookup, targetWindowId: "win-2", targetLabel: "2:改约需求" });
        expect(preview).not.toBeNull();
        if (!preview) return;
        expect(preview.targetWindowId).toBe("win-2");
        expect(preview.targetLabel).toBe("2:改约需求");
        expect(preview.count).toBe(4);
        expect(preview.prompt).toBe(composeFeedPrompt(mixedSelection, lookup));
    });

    test("没有可投喂内容时不弹层", () => {
        expect(createFeedPreview({ nodes: [node("g1", CanvasNodeType.Group, "分组框")], lookup, targetWindowId: "win-1", targetLabel: "1:会话 1" })).toBeNull();
    });
});

describe("预览层出口", () => {
    const preview = createFeedPreview({ nodes: mixedSelection, lookup, targetWindowId: "win-1", targetLabel: "1:会话 1" });
    if (!preview) throw new Error("夹具应当能拼出预览");

    test("发送用的是编辑后的文本，而不是拼装结果", () => {
        const edited = `${preview.prompt}\n补充：改约入口放在订单详情页`;
        const outcome = confirmFeedPreview(edited);
        expect(outcome.kind).toBe("send");
        if (outcome.kind !== "send") return;
        expect(outcome.text).toBe(edited);
        expect(outcome.text).not.toBe(preview.prompt);
        expect(outcome.text).toContain("补充：改约入口放在订单详情页");
    });

    test("只发用户改后的那句也成立（没有被拼装结果覆盖）", () => {
        const outcome = confirmFeedPreview("  只看这一句  ");
        expect(outcome).toEqual({ kind: "send", text: "只看这一句" });
    });

    test("取消不产生发送", () => {
        expect(cancelFeedPreview()).toEqual({ kind: "cancel" });
    });

    test("清空全文按取消处理，不发空消息", () => {
        expect(confirmFeedPreview("   \n  ")).toEqual({ kind: "cancel" });
    });
});
