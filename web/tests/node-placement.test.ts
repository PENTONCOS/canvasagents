import { describe, expect, test } from "bun:test";

import { clampNodeCenter, visibleCanvasRect, type ViewportBox } from "@/lib/canvas/node-placement";

/**
 * 新建节点落点修正。
 *
 * 这条约束是为了一个真实缺陷：节点以点击点为中心摆放，双击画布顶端附近建出来的
 * 节点上半截（含自己的工具条）在画布外，按钮点不到。I2 的导航条只是把这段区域
 * 变成了「有东西挡着」，根因在落点。
 */

const view = (patch: Partial<ViewportBox> = {}): ViewportBox => ({ x: 0, y: 0, k: 1, width: 1000, height: 700, ...patch });

describe("visibleCanvasRect", () => {
    test("默认视口就是容器本身", () => {
        expect(visibleCanvasRect(view())).toEqual({ left: 0, top: 0, right: 1000, bottom: 700 });
    });

    test("平移后按反方向换算成画布坐标", () => {
        // 视野右移 100、下移 50：可见区域在画布坐标里从 (-100, -50) 开始。
        expect(visibleCanvasRect(view({ x: 100, y: 50 }))).toEqual({ left: -100, top: -50, right: 900, bottom: 650 });
    });

    test("缩放 2 倍时可见范围减半", () => {
        expect(visibleCanvasRect(view({ k: 2 }))).toEqual({ left: 0, top: 0, right: 500, bottom: 350 });
    });
});

describe("clampNodeCenter", () => {
    const node = { width: 200, height: 100 };

    test("已经在可见区域内的落点一点都不动", () => {
        const center = { x: 400, y: 300 };
        expect(clampNodeCenter(center, node, view())).toEqual(center);
    });

    test("贴顶创建：中心被推到上边距之内，工具条不再被裁掉", () => {
        // 点击点 y=20，节点高 100 → 原来顶部落在 -30。修正后顶部 = 8。
        const result = clampNodeCenter({ x: 400, y: 20 }, node, view());
        expect(result.y).toBe(58);
        expect(result.y - node.height / 2).toBe(8);
    });

    test("贴左边创建：中心被推到左边距之内", () => {
        const result = clampNodeCenter({ x: 5, y: 300 }, node, view());
        expect(result.x - node.width / 2).toBe(8);
    });

    test("右边与底部同样收敛，且尺寸小的节点不会被推到负坐标", () => {
        const rightBottom = clampNodeCenter({ x: 990, y: 695 }, node, view());
        expect(rightBottom.x + node.width / 2).toBe(992);
        expect(rightBottom.y + node.height / 2).toBe(692);
    });

    test("视野比节点还小时退化成居中，不产生负数落点", () => {
        const small = clampNodeCenter({ x: 0, y: 0 }, { width: 300, height: 200 }, view({ width: 240, height: 160 }));
        expect(small).toEqual({ x: 120, y: 80 });
    });

    test("缩小到 0.5 倍后可见区域翻倍，原本贴底的落点不再被拉回", () => {
        // 同一个 y 在 k=1 时要被拉到 642，缩小后视野到底 1400，落点保持原样。
        expect(clampNodeCenter({ x: 400, y: 695 }, node, view()).y).toBe(642);
        expect(clampNodeCenter({ x: 400, y: 695 }, node, view({ k: 0.5 }))).toEqual({ x: 400, y: 695 });
    });

    test("边距确实是 8px：贴着上边界时顶部恰好是 8", () => {
        const result = clampNodeCenter({ x: 400, y: -1000 }, node, view());
        expect(result.y).toBe(58);
    });
});
