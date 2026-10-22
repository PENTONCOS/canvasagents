import { describe, expect, test } from "bun:test";

import {
    SKETCH_MIN_DRAG_PX,
    SKETCH_SHAPE_LIMIT,
    appendSketchShape,
    isEmptySketchShape,
    readSketchShapes,
    removeSketchShape,
    sketchHitTest,
    sketchShapeRect,
    toNormalizedPoint,
} from "@/lib/canvas/sketch-node-utils";
import type { CanvasSketchShape } from "@/types/canvas";

const SIZE = { width: 400, height: 200 };

function shape(id: string, from = { x: 0.1, y: 0.1 }, to = { x: 0.5, y: 0.4 }, kind: "rect" | "arrow" = "rect"): CanvasSketchShape {
    return { id, shape: kind, from, to };
}

describe("sketch node utils (A3) — normalized coordinates", () => {
    test("client point maps into 0..1 against the layer rect", () => {
        const rect = { left: 100, top: 50, width: 400, height: 200 };
        expect(toNormalizedPoint(300, 150, rect)).toEqual({ x: 0.5, y: 0.5 });
        expect(toNormalizedPoint(100, 50, rect)).toEqual({ x: 0, y: 0 });
        expect(toNormalizedPoint(500, 250, rect)).toEqual({ x: 1, y: 1 });
    });

    test("out-of-bounds and degenerate sizes are clamped, never NaN", () => {
        const rect = { left: 0, top: 0, width: 100, height: 100 };
        expect(toNormalizedPoint(-40, 400, rect)).toEqual({ x: 0, y: 1 });
        expect(toNormalizedPoint(50, 50, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
    });

    test("normalized shapes scale with the node size (缩放不跑位)", () => {
        const stored = shape("a", { x: 0.25, y: 0.5 }, { x: 0.75, y: 1 });
        expect(sketchShapeRect(stored, SIZE)).toEqual({ x: 100, y: 100, width: 200, height: 100 });
        // 双倍尺寸 → 像素翻倍，比例不变。
        expect(sketchShapeRect(stored, { width: 800, height: 400 })).toEqual({ x: 200, y: 200, width: 400, height: 200 });
    });
});

describe("sketch node utils (A3) — persistence hygiene", () => {
    test("readSketchShapes skips malformed entries and keeps valid ones", () => {
        const raw = {
            shapes: [
                shape("ok"),
                { id: "", shape: "rect", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
                { id: "bad-shape", shape: "circle", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
                { id: "bad-point", shape: "rect", from: { x: "0", y: 0 }, to: { x: 1, y: 1 } },
                { id: "nan-point", shape: "arrow", from: { x: Number.NaN, y: 0 }, to: { x: 1, y: 1 } },
                null,
                "nope",
            ],
        };
        expect(readSketchShapes(raw).map((item) => item.id)).toEqual(["ok"]);
    });

    test("readSketchShapes clamps out-of-range coordinates and dedupes ids", () => {
        const shapes = readSketchShapes({ shapes: [shape("dup", { x: -2, y: 3 }, { x: 0.5, y: 0.5 }), shape("dup")] });
        expect(shapes).toHaveLength(1);
        expect(shapes[0].from).toEqual({ x: 0, y: 1 });
    });

    test("readSketchShapes tolerates missing or foreign metadata", () => {
        expect(readSketchShapes(undefined)).toEqual([]);
        expect(readSketchShapes(null)).toEqual([]);
        expect(readSketchShapes({})).toEqual([]);
        expect(readSketchShapes({ shapes: "nope" })).toEqual([]);
    });

    test("readSketchShapes keeps at most the limit", () => {
        const many = Array.from({ length: SKETCH_SHAPE_LIMIT + 25 }, (_, index) => shape(`s-${index}`, { x: 0, y: 0 }, { x: 0.5, y: 0.5 }));
        const kept = readSketchShapes({ shapes: many });
        expect(kept).toHaveLength(SKETCH_SHAPE_LIMIT);
        expect(kept[kept.length - 1].id).toBe(`s-${SKETCH_SHAPE_LIMIT + 24}`);
    });

    test("a click-sized drag is discarded (误点不落数据)", () => {
        const existing = [shape("a")];
        const tiny = shape("tiny", { x: 0.5, y: 0.5 }, { x: 0.5 + (SKETCH_MIN_DRAG_PX - 1) / SIZE.width, y: 0.5 });
        expect(appendSketchShape(existing, tiny, SIZE)).toBe(existing);
    });

    test("a real drag is appended and clamped", () => {
        const next = appendSketchShape([], shape("new", { x: -1, y: 0.2 }, { x: 2, y: 0.9 }), SIZE);
        expect(next).toHaveLength(1);
        expect(next[0].from.x).toBe(0);
        expect(next[0].to.x).toBe(1);
    });

    test("appending past the limit drops the oldest shape", () => {
        const full = Array.from({ length: SKETCH_SHAPE_LIMIT }, (_, index) => shape(`s-${index}`, { x: 0, y: 0 }, { x: 0.3, y: 0.3 }));
        const next = appendSketchShape(full, shape("fresh", { x: 0, y: 0 }, { x: 0.3, y: 0.3 }), SIZE);
        expect(next).toHaveLength(SKETCH_SHAPE_LIMIT);
        expect(next[0].id).toBe("s-1");
        expect(next[next.length - 1].id).toBe("fresh");
    });

    test("removeSketchShape removes only the target", () => {
        const next = removeSketchShape([shape("a"), shape("b")], "a");
        expect(next.map((item) => item.id)).toEqual(["b"]);
        expect(removeSketchShape([shape("a")], "missing")).toHaveLength(1);
    });

    test("isEmptySketchShape flags zero-extent shapes", () => {
        expect(isEmptySketchShape({ from: { x: 0.2, y: 0.2 }, to: { x: 0.2, y: 0.2 } })).toBe(true);
        expect(isEmptySketchShape({ from: { x: 0.2, y: 0.2 }, to: { x: 0.3, y: 0.2 } })).toBe(false);
    });
});

describe("sketch node utils (A3) — eraser hit test", () => {
    test("hits inside the bounding box and misses outside", () => {
        const shapes = [shape("a", { x: 0.1, y: 0.1 }, { x: 0.4, y: 0.4 })];
        expect(sketchHitTest(shapes, { x: 0.25, y: 0.25 })).toBe("a");
        expect(sketchHitTest(shapes, { x: 0.8, y: 0.8 })).toBeNull();
    });

    test("returns the topmost (last drawn) shape on overlap", () => {
        const shapes = [shape("bottom", { x: 0, y: 0 }, { x: 0.5, y: 0.5 }), shape("top", { x: 0.2, y: 0.2 }, { x: 0.6, y: 0.6 })];
        expect(sketchHitTest(shapes, { x: 0.3, y: 0.3 })).toBe("top");
    });

    test("tolerance makes thin shapes easier to erase", () => {
        const shapes = [shape("line", { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, "arrow")];
        expect(sketchHitTest(shapes, { x: 0.51, y: 0.51 }, 0.02)).toBe("line");
        expect(sketchHitTest(shapes, { x: 0.6, y: 0.6 }, 0.02)).toBeNull();
    });
});
