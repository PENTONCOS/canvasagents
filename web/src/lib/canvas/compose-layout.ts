// C4: 多张截图合成一张高清图 —— 版式算术（纯函数，可单测）。
//
// 约定：合成是为了「一次投喂看全」而不是做海报，所以版式必须可预测：
// 列数固定用平方根近似（2 张 → 2 列 1 行，4 张 → 2×2，5 张 → 3 列 2 行），
// 单元格等宽、行高取该行最高图，等比缩放不拉伸、不裁切，四周与行间留固定间距。
// 列宽取所有源图的最大原始宽度，保证不会把原图缩小（宁可画布大一点）。

export type ComposeSourceSize = { width: number; height: number };

export type ComposeCell = {
    /** 源图在输入数组里的下标，过滤掉无效源图后仍然指回原始位置。 */
    sourceIndex: number;
    x: number;
    y: number;
    width: number;
    height: number;
};

export type ComposePlan = {
    cols: number;
    rows: number;
    /** 合成图的逻辑像素尺寸（绘制时再乘缩放倍数）。 */
    width: number;
    height: number;
    cells: ComposeCell[];
};

export const COMPOSE_GAP = 16;
export const COMPOSE_PADDING = 16;
/** 单列最大宽度：原图再宽也封顶，避免 8 张 4K 截图拼出 3 万像素的图。 */
export const COMPOSE_MAX_COLUMN_WIDTH = 1600;

/** 列数：平方根向上取整。1 张也要占 1 列，不能返回 0。 */
export function composeColumnCount(count: number): number {
    if (!Number.isFinite(count) || count <= 1) return 1;
    return Math.ceil(Math.sqrt(count));
}

function isUsable(size: ComposeSourceSize | null | undefined): size is ComposeSourceSize {
    return Boolean(size) && Number.isFinite(size!.width) && Number.isFinite(size!.height) && size!.width > 0 && size!.height > 0;
}

/**
 * 计算合成版式。没有可用源图时返回 null（调用方据此拒绝合成，而不是画一张空图）。
 * 零尺寸/负数/NaN 的源图被过滤，且它们的下标不会影响其余图片的排列顺序。
 */
export function planCompose(sizes: ComposeSourceSize[]): ComposePlan | null {
    const usable: { sourceIndex: number; width: number; height: number }[] = [];
    sizes.forEach((size, index) => {
        if (isUsable(size)) usable.push({ sourceIndex: index, width: size.width, height: size.height });
    });
    if (usable.length === 0) return null;

    const cols = composeColumnCount(usable.length);
    const rows = Math.ceil(usable.length / cols);
    const columnWidth = Math.min(Math.max(...usable.map((size) => size.width)), COMPOSE_MAX_COLUMN_WIDTH);

    // 先按列宽等比算出每张图的目标高度，再按行取最高值，行内不重叠。
    const scaled = usable.map((size) => ({
        sourceIndex: size.sourceIndex,
        width: columnWidth,
        height: Math.max(1, Math.round((size.height * columnWidth) / size.width)),
    }));

    const rowHeights: number[] = [];
    for (let row = 0; row < rows; row += 1) {
        const slice = scaled.slice(row * cols, row * cols + cols);
        rowHeights.push(Math.max(...slice.map((item) => item.height)));
    }

    const cells: ComposeCell[] = scaled.map((item, index) => {
        const row = Math.floor(index / cols);
        const col = index % cols;
        const offsetY = COMPOSE_PADDING + rowHeights.slice(0, row).reduce((sum, height) => sum + height, 0) + row * COMPOSE_GAP;
        return {
            sourceIndex: item.sourceIndex,
            x: COMPOSE_PADDING + col * (columnWidth + COMPOSE_GAP),
            y: offsetY,
            width: item.width,
            height: item.height,
        };
    });

    return {
        cols,
        rows,
        width: COMPOSE_PADDING * 2 + cols * columnWidth + Math.max(0, cols - 1) * COMPOSE_GAP,
        height: COMPOSE_PADDING * 2 + rowHeights.reduce((sum, height) => sum + height, 0) + Math.max(0, rows - 1) * COMPOSE_GAP,
        cells,
    };
}

/** 绘制倍数：至少 2x（截图文字不糊），最多 3x（内存可控）。 */
export function composeScale(devicePixelRatio: number | undefined): number {
    const ratio = Number.isFinite(devicePixelRatio) && (devicePixelRatio as number) > 0 ? (devicePixelRatio as number) : 1;
    return Math.min(3, Math.max(2, Math.ceil(ratio)));
}
