import type { Position } from "@/types/canvas";

/**
 * 新建节点的落点修正。
 *
 * `createCanvasNode` 是**以点击点为中心**摆节点的（position = 点击点 - 尺寸 / 2）。
 * 于是双击画布顶端附近建出来的节点，上半部分是负坐标：节点自己的工具条就贴在节点
 * 顶边，直接被画布上边界裁掉，看起来「节点在、按钮点不到」。I2 在画布上方加了
 * 三层导航（占 30px 高）之后，这段被裁掉的区域正好压在导航条上，连带把
 * full-chain 的用例点崩了——但根因是上面这条，导航只是把它暴露出来。
 *
 * 这里只做「把中心点往回拉」，不缩放、不改变尺寸，也不动已经在画布上的老节点：
 * 视野比节点还小的时候（比如手机竖屏）退化成居中，至少不会一半在屏外。
 */

export type NodeBox = { width: number; height: number };
export type ViewportBox = { x: number; y: number; k: number; width: number; height: number };

/** 可见区域在画布坐标系里的矩形。画布原点 = 容器左上角，因此反推即可。 */
export function visibleCanvasRect(view: ViewportBox) {
    const k = view.k || 1;
    // 0 会被算成 -0（Object.is 下不等于 0），单测按值比较会挂，这里统一归一。
    const toCanvas = (value: number) => (value === 0 ? 0 : value / k);
    return {
        left: toCanvas(-view.x),
        top: toCanvas(-view.y),
        right: toCanvas(view.width - view.x),
        bottom: toCanvas(view.height - view.y),
    };
}

function clampAxis(value: number, half: number, low: number, high: number, margin: number) {
    const min = low + half + margin;
    const max = high - half - margin;
    // 视野装不下整个节点：居中，别让用户看到「一半在屏外」还没有抓手。
    if (max < min) return (low + high) / 2;
    return Math.min(Math.max(value, min), max);
}

export function clampNodeCenter(center: Position, node: NodeBox, view: ViewportBox, margin = 8): Position {
    const rect = visibleCanvasRect(view);
    const halfW = node.width / 2;
    const halfH = node.height / 2;
    return {
        x: clampAxis(center.x, halfW, rect.left, rect.right, margin),
        y: clampAxis(center.y, halfH, rect.top, rect.bottom, margin),
    };
}
