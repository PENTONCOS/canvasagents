// A3: 线框草图节点。可以理解为「节点自己持有的圈注图层」：
// - 复用 canvas-annotation-layer 的坐标约定（0..1 归一化 + 渲染时乘回尺寸），缩放画布/改节点尺寸都不跑位；
// - 区别是数据存 metadata.sketch.shapes（随画布持久化），且带自己的工具栏与橡皮擦。
// 拖动时一律 stopPropagation + setPointerCapture，避免画布把拖拽当成移动节点。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Eraser, MousePointerSquareDashed, MoveRight, Square, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import {
    SKETCH_MIN_DRAG_PX,
    SKETCH_NODE_TYPE,
    SKETCH_SHAPE_LIMIT,
    appendSketchShape,
    isEmptySketchShape,
    readSketchShapes,
    removeSketchShape,
    sketchHitTest,
    toNormalizedPoint,
} from "@/lib/canvas/sketch-node-utils";
import type { CanvasSketchShape } from "@/types/canvas";
import type { CanvasNodeContext, CanvasNodeDefinition } from "@/types/canvas-plugin";

const SKETCH_COLOR = "#0f766e";
const SKETCH_DRAFT_COLOR = "#14b8a6";

type SketchTool = "rect" | "arrow" | "eraser";

type LayerSize = { width: number; height: number };

function nextShapeId(): string {
    return `sk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 箭头头部：在像素空间算好角度再折回归一化坐标，避免 preserveAspectRatio="none" 把箭头拉歪。 */
function arrowHead(shape: CanvasSketchShape, size: LayerSize) {
    const from = { x: shape.from.x * size.width, y: shape.from.y * size.height };
    const to = { x: shape.to.x * size.width, y: shape.to.y * size.height };
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const length = 12;
    const spread = Math.PI / 7;
    const p1 = { x: to.x - length * Math.cos(angle - spread), y: to.y - length * Math.sin(angle - spread) };
    const p2 = { x: to.x - length * Math.cos(angle + spread), y: to.y - length * Math.sin(angle + spread) };
    const norm = (point: { x: number; y: number }) => ({ x: size.width ? point.x / size.width : 0, y: size.height ? point.y / size.height : 0 });
    return { tip: norm(to), p1: norm(p1), p2: norm(p2) };
}

function SketchView({ ctx }: { ctx: CanvasNodeContext }) {
    const { t } = useTranslation();
    const shapes = useMemo(() => readSketchShapes(ctx.node.metadata?.sketch), [ctx.node.metadata?.sketch]);
    const [tool, setTool] = useState<SketchTool>("rect");
    const [draft, setDraft] = useState<CanvasSketchShape | null>(null);
    const [size, setSize] = useState<LayerSize>({ width: ctx.node.width, height: ctx.node.height });
    const layerRef = useRef<HTMLDivElement>(null);
    const drawingRef = useRef(false);

    // 真实渲染尺寸以 DOM 为准（节点有内边距/边框），归一再乘回才不会偏几像素。
    useEffect(() => {
        const element = layerRef.current;
        if (!element) return;
        const update = () => {
            const rect = element.getBoundingClientRect();
            setSize((prev) => (prev.width === rect.width && prev.height === rect.height ? prev : { width: rect.width, height: rect.height }));
        };
        update();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const persist = useCallback(
        (next: CanvasSketchShape[]) => {
            ctx.updateMetadata({ sketch: { shapes: next } });
        },
        [ctx],
    );

    const point = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const element = layerRef.current;
        if (!element) return { x: 0, y: 0 };
        return toNormalizedPoint(event.clientX, event.clientY, element.getBoundingClientRect());
    }, []);

    const handlePointerDown = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            if (event.button !== 0) return;
            // 自己吃掉，否则画布会把这次按下当成「拖节点」。
            event.stopPropagation();
            event.preventDefault();
            const at = point(event);
            if (tool === "eraser") {
                const hit = sketchHitTest(shapes, at);
                if (hit) persist(removeSketchShape(shapes, hit));
                return;
            }
            drawingRef.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            setDraft({ id: nextShapeId(), shape: tool, from: at, to: at });
        },
        [persist, point, shapes, tool],
    );

    const handlePointerMove = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            if (!drawingRef.current) return;
            event.stopPropagation();
            const at = point(event);
            setDraft((prev) => (prev ? { ...prev, to: at } : prev));
        },
        [point],
    );

    const handlePointerUp = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            if (!drawingRef.current) return;
            event.stopPropagation();
            drawingRef.current = false;
            const at = point(event);
            setDraft((prev) => {
                if (!prev) return null;
                const next = appendSketchShape(shapes, { ...prev, to: at }, size);
                // 误点（位移 < 6px）时 appendSketchShape 原样返回，不写库。
                if (next !== shapes) persist(next);
                return null;
            });
        },
        [persist, point, shapes, size],
    );

    const clearAll = useCallback(() => {
        if (shapes.length === 0) return;
        persist([]);
    }, [persist, shapes.length]);

    const toolButton = (value: SketchTool, label: string, icon: React.ReactNode) => {
        const active = tool === value;
        return (
            <button
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={active}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                    event.stopPropagation();
                    setTool(value);
                }}
                className={`flex size-6 items-center justify-center rounded border text-[11px] transition ${
                    active ? "border-teal-600 bg-teal-600/10 text-teal-700 dark:text-teal-300" : "border-stone-300 text-stone-500 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-400 dark:hover:bg-stone-800"
                }`}
                data-sketch-tool={value}
            >
                {icon}
            </button>
        );
    };

    const hasShapes = shapes.length > 0;
    const cursor = tool === "eraser" ? "cell" : "crosshair";

    return (
        <div className="flex h-full w-full flex-col overflow-hidden" style={{ color: ctx.theme.node.text }}>
            <div className="flex shrink-0 items-center justify-between gap-2 border-b px-2 py-1" style={{ borderColor: ctx.theme.node.stroke }}>
                <div className="flex items-center gap-1">
                    {toolButton("rect", t("canvas.sketch.toolRect"), <Square className="size-3.5" />)}
                    {toolButton("arrow", t("canvas.sketch.toolArrow"), <MoveRight className="size-3.5" />)}
                    {toolButton("eraser", t("canvas.sketch.toolEraser"), <Eraser className="size-3.5" />)}
                </div>
                <div className="flex items-center gap-1">
                    <span className="text-[10px] tabular-nums" style={{ color: ctx.theme.node.muted }}>
                        {t("canvas.sketch.shapeCount", { count: shapes.length, limit: SKETCH_SHAPE_LIMIT })}
                    </span>
                    <button
                        type="button"
                        title={t("canvas.sketch.clear")}
                        aria-label={t("canvas.sketch.clear")}
                        disabled={!hasShapes}
                        onPointerDown={(event) => event.stopPropagation()}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            clearAll();
                        }}
                        className="flex size-6 items-center justify-center rounded border border-stone-300 text-stone-500 transition hover:bg-stone-100 disabled:opacity-40 dark:border-stone-700 dark:text-stone-400 dark:hover:bg-stone-800"
                        data-sketch-clear
                    >
                        <Trash2 className="size-3.5" />
                    </button>
                </div>
            </div>
            <div
                ref={layerRef}
                className="relative min-h-0 flex-1 touch-none"
                style={{ cursor, background: "transparent" }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={() => {
                    drawingRef.current = false;
                    setDraft(null);
                }}
                onDoubleClick={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
                data-sketch-layer
            >
                <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none">
                    {shapes.map((shape) => {
                        if (isEmptySketchShape(shape)) return null;
                        if (shape.shape === "rect") {
                            const x = Math.min(shape.from.x, shape.to.x);
                            const y = Math.min(shape.from.y, shape.to.y);
                            const width = Math.abs(shape.to.x - shape.from.x);
                            const height = Math.abs(shape.to.y - shape.from.y);
                            return <rect key={shape.id} x={x} y={y} width={width} height={height} fill="none" stroke={SKETCH_COLOR} strokeWidth={0.004} vectorEffect="non-scaling-stroke" rx={0.006} />;
                        }
                        const head = arrowHead(shape, size);
                        return (
                            <g key={shape.id}>
                                <line x1={shape.from.x} y1={shape.from.y} x2={shape.to.x} y2={shape.to.y} stroke={SKETCH_COLOR} strokeWidth={0.004} vectorEffect="non-scaling-stroke" />
                                <polygon points={`${head.tip.x},${head.tip.y} ${head.p1.x},${head.p1.y} ${head.p2.x},${head.p2.y}`} fill={SKETCH_COLOR} />
                            </g>
                        );
                    })}
                    {draft && !isEmptySketchShape(draft) ? (
                        draft.shape === "rect" ? (
                            <rect
                                x={Math.min(draft.from.x, draft.to.x)}
                                y={Math.min(draft.from.y, draft.to.y)}
                                width={Math.abs(draft.to.x - draft.from.x)}
                                height={Math.abs(draft.to.y - draft.from.y)}
                                fill="none"
                                stroke={SKETCH_DRAFT_COLOR}
                                strokeWidth={0.004}
                                vectorEffect="non-scaling-stroke"
                                strokeDasharray="4 3"
                            />
                        ) : (
                            <line x1={draft.from.x} y1={draft.from.y} x2={draft.to.x} y2={draft.to.y} stroke={SKETCH_DRAFT_COLOR} strokeWidth={0.004} vectorEffect="non-scaling-stroke" strokeDasharray="4 3" />
                        )
                    ) : null}
                </svg>
                {!hasShapes && !draft ? (
                    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 text-center" data-sketch-empty>
                        <MousePointerSquareDashed className="size-5 opacity-40" />
                        <span className="text-xs font-medium opacity-70">{t("canvas.sketch.emptyTitle")}</span>
                        <span className="max-w-[240px] text-[11px] leading-4 opacity-50">{t("canvas.sketch.emptyHint", { min: SKETCH_MIN_DRAG_PX })}</span>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

export function sketchNodeDefinition(): CanvasNodeDefinition {
    return {
        type: SKETCH_NODE_TYPE,
        title: i18n.t("canvas.nodeTypes.sketch"),
        icon: <Square className="size-4" />,
        description: i18n.t("canvas.sketch.description"),
        minimapColor: "#14b8a6",
        defaultSize: { width: 460, height: 320 },
        defaultMetadata: { sketch: { shapes: [] } },
        hidePanel: true,
        // 草图是纯手绘内容：始终可交互，不需要已有的 interactionToggle 状态位。
        interactionToggle: false,
        transparentBackground: true,
        Content: ({ ctx }) => <SketchView ctx={ctx} />,
    };
}

let registered = false;
export function registerSketchNode() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions([sketchNodeDefinition()], "builtin");
}
