import type { Position } from "@/types/canvas";

/**
 * M1: 旅程步骤自动排布。
 *
 * 约定：旅程节点在上，步骤（原型屏）平铺在下方，一行最多 4 个，超出换行。
 * 纯函数，不读 store、不碰 DOM —— 排布规则可单测，画布侧只负责把结果转成节点。
 */

export const JOURNEY_STEP_GAP_X = 32;
export const JOURNEY_STEP_GAP_Y = 64;
export const JOURNEY_STEPS_PER_ROW = 4;

export type JourneyLayoutInput = {
    /** 旅程节点左上角世界坐标。 */
    origin: Position;
    /** 旅程节点尺寸。 */
    journeySize: { width: number; height: number };
    /** 单个步骤节点尺寸。 */
    stepSize: { width: number; height: number };
    /** 步骤数量。 */
    count: number;
};

/** 返回每个步骤节点的左上角坐标（顺序即步骤顺序：先左后右、先上后下）。 */
export function layoutJourneySteps({ origin, journeySize, stepSize, count }: JourneyLayoutInput): Position[] {
    if (count <= 0) return [];
    const startX = origin.x;
    const startY = origin.y + journeySize.height + JOURNEY_STEP_GAP_Y;
    const positions: Position[] = [];
    for (let index = 0; index < count; index += 1) {
        const row = Math.floor(index / JOURNEY_STEPS_PER_ROW);
        const column = index % JOURNEY_STEPS_PER_ROW;
        positions.push({
            x: startX + column * (stepSize.width + JOURNEY_STEP_GAP_X),
            y: startY + row * (stepSize.height + JOURNEY_STEP_GAP_Y),
        });
    }
    return positions;
}

/** 三版设计并排时的水平间距（设计稿比步骤宽，单独一组常量便于调）。 */
export const DESIGN_VARIANT_GAP_X = 48;

/** 返回 count 个设计版本的左上角坐标，整体以旅程/原点为中心水平居中。 */
export function layoutDesignVariants(origin: Position, variantSize: { width: number; height: number }, count: number): Position[] {
    if (count <= 0) return [];
    const totalWidth = count * variantSize.width + (count - 1) * DESIGN_VARIANT_GAP_X;
    const startX = origin.x - totalWidth / 2 + variantSize.width / 2;
    return Array.from({ length: count }, (_, index) => ({
        x: startX + index * (variantSize.width + DESIGN_VARIANT_GAP_X),
        y: origin.y,
    }));
}
