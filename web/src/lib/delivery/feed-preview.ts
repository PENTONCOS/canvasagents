import { buildFeedPrompt, feedableNodes, type FeedPromptOptions, type FeedLookup } from "@/lib/delivery/feed-context";
import type { CanvasNodeData } from "@/types/canvas";

/**
 * C3 投喂前预览：发送前把最终提示词整篇交给用户过目，并允许改完再发。
 *
 * 拼装只走 buildFeedPrompt 一份实现——预览层和直接投喂必须拼出同一个字符串，
 * 否则「看到的」和「发出去的」会在后续改动里悄悄分叉。
 */

/** C4: 已合成的高清截图。预览层要把它显出来，用户才信「发出去的是一张图」。 */
export type FeedComposedImage = {
    dataUrl: string;
    /** 逻辑像素尺寸（未乘导出倍数）。 */
    width: number;
    height: number;
    /** 导出倍数：摘要里写的是 width*scale / height*scale。 */
    scale: number;
    count: number;
    cols: number;
    rows: number;
    /** 合成图挂到哪个节点上（沿用第一张源图的 nodeId，发送链路才能过节点校验）。 */
    nodeId: string;
    /** 提示词「【图片】」分组里那一行摘要。 */
    summary: string;
    /** 引用标题（「N 张合成 1 张」）。 */
    title: string;
};

export type FeedPreview = {
    /** 拼好的提示词全文（预览层初值，用户可编辑）。 */
    prompt: string;
    /** 参与投喂的画布内容条数（配置节点、分组框不算）。 */
    count: number;
    /** 这段文字会发到哪个会话窗。 */
    targetWindowId: string;
    /** 目标窗的展示名，复用窗口命名能力（`编号:名称`）。 */
    targetLabel: string;
    /** C4: 多张截图已合成一张时才有值。 */
    composedImage?: FeedComposedImage;
};

export function composeFeedPrompt(nodes: CanvasNodeData[], lookup: FeedLookup, options: FeedPromptOptions = {}): string {
    return buildFeedPrompt(feedableNodes(nodes), lookup, options);
}

/** 框选内容 → 预览草稿；没有可投喂内容时返回 null（调用方据此不弹层、不发空消息）。 */
export function createFeedPreview(input: {
    nodes: CanvasNodeData[];
    lookup: FeedLookup;
    targetWindowId: string;
    targetLabel: string;
    composedImage?: FeedComposedImage;
}): FeedPreview | null {
    const feedNodes = feedableNodes(input.nodes);
    const prompt = buildFeedPrompt(
        feedNodes,
        input.lookup,
        // 已合成时才折叠图片分组：没合成成功的批次仍按原样逐条列出，不能让「合成失败」变成「内容消失」。
        input.composedImage ? { imageGroup: { count: input.composedImage.count, summary: input.composedImage.summary } } : {},
    );
    if (!prompt) return null;
    return {
        prompt,
        count: feedNodes.length,
        targetWindowId: input.targetWindowId,
        targetLabel: input.targetLabel,
        composedImage: input.composedImage,
    };
}

export type FeedPreviewOutcome = { kind: "send"; text: string } | { kind: "cancel" };

/**
 * 点「发送」：发的是编辑后的文本，不是拼装结果。
 * 全文被清空时按取消处理——空消息发出去只会让 Agent 空转一轮。
 */
export function confirmFeedPreview(editedText: string): FeedPreviewOutcome {
    const text = editedText.trim();
    if (!text) return { kind: "cancel" };
    return { kind: "send", text };
}

/** 点「取消」或按 Esc：什么都不发，输入框也不写。 */
export function cancelFeedPreview(): FeedPreviewOutcome {
    return { kind: "cancel" };
}
