import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AC_STATUS_COLOR } from "@/lib/delivery/ac-status";
import { useDeliveryStore } from "@/stores/use-delivery-store";
import { annotationRect, clampNormalized, type DeliveryAnnotation } from "@/types/delivery";

const ANNOTATION_COLOR = "#ef4444";

type Point = { x: number; y: number };

type Props = {
    nodeId: string;
    /** 节点在画布坐标系里的尺寸；圈注本身用 0..1 归一化，缩放不会跑位。 */
    size: { width: number; height: number };
    /** 进入圈注模式：可拖拽新增。关闭时只渲染已有圈注，不拦截点击。 */
    active: boolean;
};

function toNormalized(event: React.PointerEvent<HTMLDivElement>, element: HTMLDivElement): Point {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
        x: clampNormalized((event.clientX - rect.left) / rect.width),
        y: clampNormalized((event.clientY - rect.top) / rect.height),
    };
}

/** 圈注图层：矩形/箭头 + 编号。坐标归一化存储，渲染时再乘回节点尺寸。 */
export function CanvasAnnotationLayer({ nodeId, size, active }: Props) {
    const { t } = useTranslation();
    const annotations = useDeliveryStore((state) => state.annotations);
    const addAnnotation = useDeliveryStore((state) => state.addAnnotation);
    const ref = useRef<HTMLDivElement | null>(null);
    const [draft, setDraft] = useState<{ from: Point; to: Point; shape: "rect" | "arrow" } | null>(null);
    const drawing = useRef(false);

    const items = useMemo(() => Object.values(annotations).filter((annotation) => annotation.nodeId === nodeId), [annotations, nodeId]);

    const finish = (to: Point) => {
        if (!draft) return;
        const dx = Math.abs(draft.to.x - draft.from.x);
        const dy = Math.abs(draft.to.y - draft.from.y);
        // 误点（没有实际拖拽）不产生圈注，否则每次单击都多一条垃圾数据。
        if (dx * size.width < 6 && dy * size.height < 6) return;
        addAnnotation({ nodeId, shape: draft.shape, from: draft.from, to });
    };

    return (
        <div
            ref={ref}
            className="absolute inset-0 z-20"
            style={{ pointerEvents: active ? "auto" : "none", cursor: active ? "crosshair" : undefined }}
            data-annotation-layer={nodeId}
            onPointerDown={(event) => {
                if (!active || !ref.current) return;
                event.stopPropagation();
                event.preventDefault();
                drawing.current = true;
                const point = toNormalized(event, ref.current);
                const shape = event.shiftKey ? "arrow" : "rect";
                setDraft({ from: point, to: point, shape });
                event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
                if (!drawing.current || !draft || !ref.current) return;
                event.stopPropagation();
                setDraft({ ...draft, to: toNormalized(event, ref.current) });
            }}
            onPointerUp={(event) => {
                if (!drawing.current || !ref.current) return;
                event.stopPropagation();
                drawing.current = false;
                const to = toNormalized(event, ref.current);
                finish(to);
                setDraft(null);
            }}
        >
            <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none">
                {items.map((annotation) => (annotation.shape === "arrow" ? <ArrowMark key={annotation.id} annotation={annotation} /> : null))}
                {draft?.shape === "arrow" ? (
                    <line
                        x1={draft.from.x}
                        y1={draft.from.y}
                        x2={draft.to.x}
                        y2={draft.to.y}
                        stroke={ANNOTATION_COLOR}
                        strokeWidth={0.004}
                        vectorEffect="non-scaling-stroke"
                        strokeDasharray="4 3"
                    />
                ) : null}
            </svg>
            {items.map((annotation) => (annotation.shape === "rect" ? <RectMark key={annotation.id} annotation={annotation} size={size} /> : null))}
            {items.map((annotation) => (
                <NumberBadge key={`badge-${annotation.id}`} annotation={annotation} size={size} />
            ))}
            {draft && draft.shape === "rect" ? (
                <div
                    className="pointer-events-none absolute border-2 border-dashed"
                    style={{
                        borderColor: ANNOTATION_COLOR,
                        ...rectStyle(draft, size),
                    }}
                />
            ) : null}
            {active && items.length > 0 ? (
                <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                    {t("canvas.node.delivery.annotationHint")}
                </span>
            ) : null}
        </div>
    );
}

function rectStyle(annotation: Pick<DeliveryAnnotation, "from" | "to">, size: { width: number; height: number }) {
    const rect = annotationRect(annotation, size);
    return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

function RectMark({ annotation, size }: { annotation: DeliveryAnnotation; size: { width: number; height: number } }) {
    const rect = annotationRect(annotation, size);
    return (
        <div
            className="pointer-events-none absolute rounded-sm border-2"
            style={{ borderColor: annotation.acId ? AC_STATUS_COLOR.failing : ANNOTATION_COLOR, left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
            data-annotation-id={annotation.id}
        />
    );
}

function ArrowMark({ annotation }: { annotation: DeliveryAnnotation }) {
    return (
        <g data-annotation-id={annotation.id}>
            <line
                x1={annotation.from.x}
                y1={annotation.from.y}
                x2={annotation.to.x}
                y2={annotation.to.y}
                stroke={ANNOTATION_COLOR}
                strokeWidth={0.005}
                vectorEffect="non-scaling-stroke"
            />
            <circle cx={annotation.to.x} cy={annotation.to.y} r={0.012} fill={ANNOTATION_COLOR} vectorEffect="non-scaling-stroke" />
        </g>
    );
}

function NumberBadge({ annotation, size }: { annotation: DeliveryAnnotation; size: { width: number; height: number } }) {
    const rect = annotationRect(annotation, size);
    return (
        <span
            className="pointer-events-none absolute flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white shadow"
            style={{ background: ANNOTATION_COLOR, left: Math.max(0, rect.x - 10), top: Math.max(0, rect.y - 10) }}
        >
            {annotation.label}
        </span>
    );
}
