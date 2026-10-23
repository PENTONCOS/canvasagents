import { describe, expect, test } from "bun:test";

import { COMPOSE_GAP, COMPOSE_MAX_COLUMN_WIDTH, COMPOSE_PADDING, composeColumnCount, composeScale, planCompose } from "@/lib/canvas/compose-layout";

describe("合成版式：列数与缩放", () => {
    test("列数用平方根向上取整，1 张也要占 1 列", () => {
        expect(composeColumnCount(0)).toBe(1);
        expect(composeColumnCount(1)).toBe(1);
        expect(composeColumnCount(2)).toBe(2);
        expect(composeColumnCount(4)).toBe(2);
        expect(composeColumnCount(5)).toBe(3);
        expect(composeColumnCount(9)).toBe(3);
        expect(composeColumnCount(10)).toBe(4);
    });

    test("绘制倍数至少 2x、最多 3x，异常值退回 2x", () => {
        expect(composeScale(undefined)).toBe(2);
        expect(composeScale(1)).toBe(2);
        expect(composeScale(2)).toBe(2);
        expect(composeScale(3)).toBe(3);
        expect(composeScale(4)).toBe(3);
        expect(composeScale(Number.NaN)).toBe(2);
    });
});

describe("合成版式：尺寸与单元格", () => {
    test("没有可用源图时返回 null，不画空图", () => {
        expect(planCompose([])).toBeNull();
        expect(planCompose([{ width: 0, height: 100 }])).toBeNull();
        expect(planCompose([{ width: Number.NaN, height: 100 }])).toBeNull();
    });

    test("单张：列宽取原图宽度，四周留白", () => {
        const plan = planCompose([{ width: 800, height: 600 }]);
        expect(plan).not.toBeNull();
        expect(plan!.cols).toBe(1);
        expect(plan!.rows).toBe(1);
        expect(plan!.width).toBe(COMPOSE_PADDING * 2 + 800);
        expect(plan!.height).toBe(COMPOSE_PADDING * 2 + 600);
        expect(plan!.cells).toEqual([{ sourceIndex: 0, x: COMPOSE_PADDING, y: COMPOSE_PADDING, width: 800, height: 600 }]);
    });

    test("两张不等高：同一行按最高图取行高，第二个单元格右移一个列宽加间距", () => {
        const plan = planCompose([
            { width: 800, height: 600 },
            { width: 400, height: 400 },
        ]);
        expect(plan!.cols).toBe(2);
        expect(plan!.rows).toBe(1);
        // 列宽取最大原始宽度 800，第二张等比放大到 800x800。
        expect(plan!.cells[1]).toEqual({ sourceIndex: 1, x: COMPOSE_PADDING + 800 + COMPOSE_GAP, y: COMPOSE_PADDING, width: 800, height: 800 });
        expect(plan!.height).toBe(COMPOSE_PADDING * 2 + 800);
        expect(plan!.width).toBe(COMPOSE_PADDING * 2 + 2 * 800 + COMPOSE_GAP);
    });

    test("多张：5 张排成 3 列 2 行，第二行整体下移一行高加间距", () => {
        const plan = planCompose(Array.from({ length: 5 }, () => ({ width: 100, height: 100 })));
        expect(plan!.cols).toBe(3);
        expect(plan!.rows).toBe(2);
        expect(plan!.width).toBe(COMPOSE_PADDING * 2 + 3 * 100 + 2 * COMPOSE_GAP);
        expect(plan!.height).toBe(COMPOSE_PADDING * 2 + 2 * 100 + COMPOSE_GAP);
        expect(plan!.cells.map((cell) => [cell.x, cell.y])).toEqual([
            [COMPOSE_PADDING, COMPOSE_PADDING],
            [COMPOSE_PADDING + 100 + COMPOSE_GAP, COMPOSE_PADDING],
            [COMPOSE_PADDING + 2 * (100 + COMPOSE_GAP), COMPOSE_PADDING],
            [COMPOSE_PADDING, COMPOSE_PADDING + 100 + COMPOSE_GAP],
            [COMPOSE_PADDING + 100 + COMPOSE_GAP, COMPOSE_PADDING + 100 + COMPOSE_GAP],
        ]);
    });

    test("极端长宽比：列宽封顶，超宽图不会把画布撑到失控", () => {
        const plan = planCompose([{ width: 4000, height: 100 }]);
        expect(plan!.cells[0].width).toBe(COMPOSE_MAX_COLUMN_WIDTH);
        expect(plan!.cells[0].height).toBe(Math.round((100 * COMPOSE_MAX_COLUMN_WIDTH) / 4000));
    });

    test("零尺寸源图被过滤，其余图的 sourceIndex 仍指回原始位置", () => {
        const plan = planCompose([
            { width: 0, height: 0 },
            { width: 800, height: 600 },
        ]);
        expect(plan!.cells).toHaveLength(1);
        expect(plan!.cells[0].sourceIndex).toBe(1);
    });

    test("等比缩放：单元格高宽比与源图一致（取整误差不超过 1px）", () => {
        const plan = planCompose([
            { width: 1920, height: 1080 },
            { width: 1080, height: 1920 },
        ]);
        expect(plan!.cells[0].height).toBe(Math.round((1080 * plan!.cells[0].width) / 1920));
        expect(Math.abs(plan!.cells[1].height - (1920 * plan!.cells[1].width) / 1080)).toBeLessThanOrEqual(1);
    });
});
