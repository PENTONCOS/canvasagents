import { annotationRect, clampNormalized } from "@/types/delivery";
import type { CanvasSketchShape } from "@/types/canvas";

// A3: 线框草图节点的纯几何逻辑。
// 复用圈注图层（canvas-annotation-layer）的实现思路：坐标归一化到 0..1、渲染时乘回节点尺寸，
// 所以缩放画布或改节点尺寸都不会跑位。区别只在存储位置：圈注属于问题单（delivery store），
// 草图属于节点自己（metadata.sketch），随画布一起持久化。
export const SKETCH_NODE_TYPE = "sketch";
/** 单节点最多保留的图形数：防止误拖把 metadata 撑爆（画布是整体持久化的）。 */
export const SKETCH_SHAPE_LIMIT = 300;
/** 小于这个像素位移视为误点，不产生图形（与圈注图层一致）。 */
export const SKETCH_MIN_DRAG_PX = 6;

export type SketchPoint = { x: number; y: number };
export type SketchSize = { width: number; height: number };

/** 屏幕坐标 → 节点内归一化坐标；节点尺寸为 0 时退回原点，避免除零产生 NaN。 */
export function toNormalizedPoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): SketchPoint {
    if (!rect.width || !rect.height) return { x: 0, y: 0 };
    return {
        x: clampNormalized((clientX - rect.left) / rect.width),
        y: clampNormalized((clientY - rect.top) / rect.height),
    };
}

function isFinitePoint(value: unknown): value is SketchPoint {
    if (!value || typeof value !== "object") return false;
    const point = value as { x?: unknown; y?: unknown };
    return typeof point.x === "number" && Number.isFinite(point.x) && typeof point.y === "number" && Number.isFinite(point.y);
}

/** 持久化数据可能来自旧版本/插件/手写 JSON：读取时校验并剔除坏数据，不让坏形状把节点画崩。 */
export function isSketchShape(value: unknown): value is CanvasSketchShape {
    if (!value || typeof value !== "object") return false;
    const shape = value as { id?: unknown; shape?: unknown; from?: unknown; to?: unknown };
    return typeof shape.id === "string" && shape.id.length > 0 && (shape.shape === "rect" || shape.shape === "arrow") && isFinitePoint(shape.from) && isFinitePoint(shape.to);
}

/** 读取 metadata.sketch.shapes：归一化越界值、去重、限长。 */
export function readSketchShapes(sketch: unknown): CanvasSketchShape[] {
    if (!sketch || typeof sketch !== "object") return [];
    const shapes = (sketch as { shapes?: unknown }).shapes;
    if (!Array.isArray(shapes)) return [];
    const seen = new Set<string>();
    const clean: CanvasSketchShape[] = [];
    for (const candidate of shapes) {
        if (!isSketchShape(candidate) || seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        clean.push({
            id: candidate.id,
            shape: candidate.shape,
            from: { x: clampNormalized(candidate.from.x), y: clampNormalized(candidate.from.y) },
            to: { x: clampNormalized(candidate.to.x), y: clampNormalized(candidate.to.y) },
        });
    }
    return clean.slice(-SKETCH_SHAPE_LIMIT);
}

/** 追加一个图形；拖拽距离过小（误点）直接返回原数组，调用方据此跳过持久化。 */
export function appendSketchShape(shapes: CanvasSketchShape[], next: CanvasSketchShape, size: SketchSize): CanvasSketchShape[] {
    const dx = Math.abs(next.to.x - next.from.x) * size.width;
    const dy = Math.abs(next.to.y - next.from.y) * size.height;
    if (dx < SKETCH_MIN_DRAG_PX && dy < SKETCH_MIN_DRAG_PX) return shapes;
    return [...shapes, { ...next, from: { x: clampNormalized(next.from.x), y: clampNormalized(next.from.y) }, to: { x: clampNormalized(next.to.x), y: clampNormalized(next.to.y) } }].slice(-SKETCH_SHAPE_LIMIT);
}

export function removeSketchShape(shapes: CanvasSketchShape[], id: string): CanvasSketchShape[] {
    return shapes.filter((shape) => shape.id !== id);
}

/** 图形在节点内的像素矩形（矩形用；箭头两端点另行还原）。 */
export function sketchShapeRect(shape: Pick<CanvasSketchShape, "from" | "to">, size: SketchSize) {
    return annotationRect(shape, size);
}

/** 图形是否是「空图形」（两端点重合），用于渲染时跳过无效数据。 */
export function isEmptySketchShape(shape: Pick<CanvasSketchShape, "from" | "to">): boolean {
    return shape.from.x === shape.to.x && shape.from.y === shape.to.y;
}

/**
 * 橡皮擦命中测试：从最后画的图形往前找，命中包围盒（含 2% 容差）的第一个返回。
 * 倒序保证「后画的压在上面」，与视觉层级一致。
 */
export function sketchHitTest(shapes: CanvasSketchShape[], point: SketchPoint, padding = 0.02): string | null {
    for (let index = shapes.length - 1; index >= 0; index -= 1) {
        const shape = shapes[index];
        const rect = sketchShapeRect(shape, { width: 1, height: 1 });
        if (
            point.x >= rect.x - padding &&
            point.x <= rect.x + rect.width + padding &&
            point.y >= rect.y - padding &&
            point.y <= rect.y + rect.height + padding
        ) {
            return shape.id;
        }
    }
    return null;
}
