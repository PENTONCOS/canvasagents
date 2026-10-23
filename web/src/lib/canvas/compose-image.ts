// C4: 多张截图合成一张高清图 —— 绘制层。
//
// 这里只负责「按版式把图画上去」，版式算术在 compose-layout.ts 里（纯函数、可单测）。
// 高清的做法是按 composeScale 放大整块画布，再把每张原图按放大后的单元格尺寸重绘，
// 而不是先画小图再整体放大——后者会把截图里的文字糊掉。

import { COMPOSE_GAP, COMPOSE_PADDING, composeScale, planCompose, type ComposePlan } from "@/lib/canvas/compose-layout";

export type ComposeSource = { src: string; title?: string };

export type ComposeResult = {
    dataUrl: string;
    /** 逻辑像素尺寸（未乘缩放倍数）。 */
    width: number;
    height: number;
    /** 缩放倍数，便于调用方标注「2x」这类信息。 */
    scale: number;
    plan: ComposePlan;
};

export type ComposeFailure = { index: number; title?: string; reason: string };

export class ComposeError extends Error {
    readonly failures: ComposeFailure[];

    constructor(failures: ComposeFailure[]) {
        const indexes = failures.map((failure) => failure.index + 1).join(", ");
        super(`compose failed: images ${indexes} could not be loaded`);
        this.name = "ComposeError";
        this.failures = failures;
    }
}

async function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("image load failed"));
        image.src = src;
    });
}

/**
 * 把多张截图合成一张 PNG。
 *
 * 只要有一张加载失败就整批失败（抛 `ComposeError`，带上失败序号）——宁可让用户换一张，
 * 也不要在合成图里悄悄少一张图：少一张图的后果是 Agent 看到的是残缺界面，且没人知道。
 */
export async function composeScreenshots(sources: ComposeSource[], options: { devicePixelRatio?: number; background?: string } = {}): Promise<ComposeResult> {
    if (sources.length < 2) throw new Error("compose requires at least 2 images");

    const loaded: { index: number; image: HTMLImageElement }[] = [];
    const failures: ComposeFailure[] = [];
    for (const [index, source] of sources.entries()) {
        try {
            loaded.push({ index, image: await loadImage(source.src) });
        } catch (caught) {
            failures.push({ index, title: source.title, reason: caught instanceof Error ? caught.message : String(caught) });
        }
    }
    if (failures.length > 0) throw new ComposeError(failures);

    const plan = planCompose(loaded.map((item) => ({ width: item.image.naturalWidth || item.image.width, height: item.image.naturalHeight || item.image.height })));
    if (!plan) throw new Error("compose has no usable image size");

    const scale = composeScale(options.devicePixelRatio ?? globalThis.devicePixelRatio);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(plan.width * scale);
    canvas.height = Math.round(plan.height * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas 2d context unavailable");

    context.scale(scale, scale);
    context.fillStyle = options.background || "#ffffff";
    context.fillRect(0, 0, plan.width, plan.height);

    // plan.cells 的顺序与 loaded 一致（都按可用源图的原始顺序过滤），下标可直接对应。
    plan.cells.forEach((cell, index) => {
        const image = loaded[index].image;
        context.drawImage(image, cell.x, cell.y, cell.width, cell.height);
    });

    return {
        dataUrl: canvas.toDataURL("image/png"),
        width: plan.width,
        height: plan.height,
        scale,
        plan,
    };
}

export const COMPOSE_SPACING = { gap: COMPOSE_GAP, padding: COMPOSE_PADDING };
