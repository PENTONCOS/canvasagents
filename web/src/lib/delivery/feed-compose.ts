import i18n from "@/i18n";
import type { ComposePlan } from "@/lib/canvas/compose-layout";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/**
 * C4: 多张截图合成一张高清图再投喂。
 *
 * 为什么要合成而不是连发 N 张：截同一个界面时，Agent 需要「并排看差异」，
 * 分成 N 张附件会被逐张理解、前后对不上；合成一张后版式是确定的（列×行），
 * 提示词里也能一句话写清「几张、几列几行、实际多少像素」，Agent 不必自己猜布局。
 *
 * 这里只做筛选与文案（纯函数），画图在 lib/canvas/compose-image.ts。
 */

/** 少于 2 张没有合并意义：一张图就是它自己。 */
export const COMPOSE_MIN_IMAGES = 2;

/** 能参与合成的图片节点：必须有可读的图源（内容地址或存储键）。 */
export function feedImageNodes(nodes: CanvasNodeData[]): CanvasNodeData[] {
    return nodes.filter((node) => node.type === CanvasNodeType.Image && Boolean(node.metadata?.content || node.metadata?.storageKey));
}

export function shouldComposeFeedImages(nodes: CanvasNodeData[]): boolean {
    return feedImageNodes(nodes).length >= COMPOSE_MIN_IMAGES;
}

export type ComposedImageSummaryInput = {
    count: number;
    plan: Pick<ComposePlan, "cols" | "rows" | "width" | "height">;
    /** 实际导出倍数：提示词里要写真实像素，Agent 才能判断清晰度够不够。 */
    scale: number;
};

/** 提示词里那一行摘要：张数、列×行、实际像素（已乘导出倍数）。 */
export function composeImageSummary(input: ComposedImageSummaryInput): string {
    return i18n.t("canvas.nodeToolbar.feedImageComposed", {
        count: input.count,
        cols: input.plan.cols,
        rows: input.plan.rows,
        width: Math.round(input.plan.width * input.scale),
        height: Math.round(input.plan.height * input.scale),
    });
}

/**
 * 合成后的引用标签沿用「图片 N」，这样它在提示词的素材清单里仍是一张普通图片，
 * 只是标题换成了「N 张合成」——Agent 不会因为标签变了而去猜这是个新类型。
 */
export function composedImageTitle(count: number): string {
    return i18n.t("canvas.nodeToolbar.feedImageComposedTitle", { count });
}
