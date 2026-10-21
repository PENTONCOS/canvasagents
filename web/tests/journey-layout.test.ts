import { describe, expect, test } from "bun:test";

import { DESIGN_VARIANT_GAP_X, JOURNEY_STEP_GAP_X, JOURNEY_STEP_GAP_Y, JOURNEY_STEPS_PER_ROW, layoutDesignVariants, layoutJourneySteps } from "@/lib/canvas/journey-layout";

const journeySize = { width: 620, height: 300 };
const stepSize = { width: 240, height: 360 };

describe("旅程步骤排布", () => {
    test("步骤从旅程正下方开始，横向按间距排列", () => {
        const positions = layoutJourneySteps({ origin: { x: 100, y: 200 }, journeySize, stepSize, count: 3 });
        expect(positions).toHaveLength(3);
        expect(positions[0]).toEqual({ x: 100, y: 200 + 300 + JOURNEY_STEP_GAP_Y });
        expect(positions[1].x).toBe(100 + 240 + JOURNEY_STEP_GAP_X);
        expect(positions[2].x).toBe(100 + 2 * (240 + JOURNEY_STEP_GAP_X));
        // 同一行 y 必须一致，否则「并排」就名不副实。
        expect(new Set(positions.map((p) => p.y)).size).toBe(1);
    });

    test("超过一行换行，不重叠", () => {
        const count = JOURNEY_STEPS_PER_ROW + 2;
        const positions = layoutJourneySteps({ origin: { x: 0, y: 0 }, journeySize, stepSize, count });
        expect(positions).toHaveLength(count);
        const secondRowY = positions[JOURNEY_STEPS_PER_ROW].y;
        expect(secondRowY).toBeGreaterThan(positions[0].y);
        // 换行后回到起始 x。
        expect(positions[JOURNEY_STEPS_PER_ROW].x).toBe(positions[0].x);
    });

    test("count 为 0 返回空数组", () => {
        expect(layoutJourneySteps({ origin: { x: 0, y: 0 }, journeySize, stepSize, count: 0 })).toEqual([]);
    });
});

describe("三版设计排布", () => {
    test("以原点为中线居中，等距并排", () => {
        const variantSize = { width: 340, height: 240 };
        const positions = layoutDesignVariants({ x: 1000, y: 500 }, variantSize, 3);
        expect(positions).toHaveLength(3);
        const middle = positions[1].x;
        expect(middle).toBeCloseTo(1000, 5);
        expect(positions[1].x - positions[0].x).toBeCloseTo(340 + DESIGN_VARIANT_GAP_X, 5);
        expect(new Set(positions.map((p) => p.y)).size).toBe(1);
    });

    test("单版本时落在原点", () => {
        const positions = layoutDesignVariants({ x: 50, y: 60 }, { width: 340, height: 240 }, 1);
        expect(positions[0]).toEqual({ x: 50, y: 60 });
    });
});
