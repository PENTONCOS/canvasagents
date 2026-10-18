// Image-structure layer for the regular image node. Renders parsed region boxes directly over the
// node's own <img>, lets the user pick a region and edit its properties, and exposes the parse
// entry point. Mirrors the M7 image-regions node, but reuses the host image instead of drawing its
// own, so the structure layer works on the ordinary image node the same way it does on the dedicated
// one. Every edit stays inside metadata.regions: source pixels are never touched here.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

import { saveAs } from "file-saver";
import { AlertCircle, Download, Layers, Loader2, ScanText, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useImageRegions } from "@/components/canvas/use-image-regions";
import {
    REGION_DEFAULT_FONT_FAMILY,
    REGION_DEFAULT_FONT_SIZE_PX,
    REGION_FONT_FAMILIES,
    REGION_FONT_SIZE_MAX,
    REGION_FONT_SIZE_MIN,
    REGION_FONT_SIZE_STEP,
    REGION_MIN_SIZE,
    REGION_RESIZE_HANDLES,
    REGION_TYPE_COLOR,
    imageContainRect,
    moveRegionBbox,
    normalizeFontSize,
    resizeRegionBbox,
    type RegionResizeHandle,
} from "@/lib/canvas/image-regions-utils";
import type { CanvasImageRegion, CanvasImageRegionBbox, CanvasImageRegionFont } from "@/types/canvas";
import type { CanvasNodeContext } from "@/types/canvas-plugin";

const HANDLE_VISUAL_SIZE = 9;
const CONTROL_CLASS = "shrink-0 rounded border border-stone-300 bg-transparent px-1.5 py-0.5 text-[10px] text-stone-600 hover:bg-stone-100 disabled:opacity-40 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800";
const FIELD_CLASS = "w-full min-w-0 rounded border border-stone-300 bg-transparent px-1.5 py-0.5 text-[10px] text-stone-700 outline-none dark:border-stone-600 dark:text-stone-200";

const HANDLE_POSITION: Record<RegionResizeHandle, CSSProperties> = {
    nw: { left: 0, top: 0 },
    n: { left: "50%", top: 0 },
    ne: { left: "100%", top: 0 },
    e: { left: "100%", top: "50%" },
    se: { left: "100%", top: "100%" },
    s: { left: "50%", top: "100%" },
    sw: { left: 0, top: "100%" },
    w: { left: 0, top: "50%" },
};

const HANDLE_CURSOR: Record<RegionResizeHandle, string> = {
    nw: "nwse-resize",
    n: "ns-resize",
    ne: "nesw-resize",
    e: "ew-resize",
    se: "nwse-resize",
    s: "ns-resize",
    sw: "nesw-resize",
    w: "ew-resize",
};

type DragMode = "move" | "resize";
type DragState = { regionId: string; mode: DragMode; handle: RegionResizeHandle; startX: number; startY: number; startBbox: CanvasImageRegionBbox };

function resolveFont(region: CanvasImageRegion): Required<CanvasImageRegionFont> {
    return {
        sizePx: region.font?.sizePx ?? REGION_DEFAULT_FONT_SIZE_PX,
        weight: region.font?.weight ?? "regular",
        align: region.font?.align ?? "left",
        family: region.font?.family || REGION_DEFAULT_FONT_FAMILY,
    };
}

export type ImageNodeRegionsProps = {
    ctx: CanvasNodeContext | null;
    source: string;
    naturalWidth?: number;
    naturalHeight?: number;
};

export function ImageNodeRegions({ ctx, source, naturalWidth, naturalHeight }: ImageNodeRegionsProps) {
    const { t } = useTranslation();
    const rootRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<DragState | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [dragging, setDragging] = useState(false);

    const { meta, regions, selectedId, status, error, elapsedMs, canParse, parse, select, update, exportJson } = useImageRegions(ctx, source);

    useEffect(() => {
        const element = rootRef.current;
        if (!element) return;
        const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const interactive = Boolean(ctx?.isSelected);
    const canvasScale = ctx?.scale ?? 1;

    const natural = useMemo(() => {
        const width = meta?.width && meta.width > 0 ? meta.width : naturalWidth && naturalWidth > 0 ? naturalWidth : size.width;
        const height = meta?.height && meta.height > 0 ? meta.height : naturalHeight && naturalHeight > 0 ? naturalHeight : size.height;
        return { width, height };
    }, [meta?.height, meta?.width, naturalHeight, naturalWidth, size.height, size.width]);

    const contain = useMemo(() => imageContainRect(size, natural), [natural, size]);
    const bounds = useMemo(() => ({ width: natural.width, height: natural.height }), [natural.height, natural.width]);
    const pointerScale = Math.max(0.0001, canvasScale * contain.scale);

    const selected = useMemo(() => regions.find((region) => region.id === selectedId) || null, [regions, selectedId]);

    const beginDrag = useCallback(
        (event: ReactPointerEvent, region: CanvasImageRegion, mode: DragMode, handle: RegionResizeHandle) => {
            if (!interactive) return;
            event.stopPropagation();
            event.preventDefault();
            select(region.id);
            dragRef.current = { regionId: region.id, mode, handle, startX: event.clientX, startY: event.clientY, startBbox: { ...region.bbox } };
            setDragging(true);
        },
        [interactive, select],
    );

    useEffect(() => {
        if (!dragging) return;
        const onMove = (event: PointerEvent) => {
            const drag = dragRef.current;
            if (!drag) return;
            const dx = (event.clientX - drag.startX) / pointerScale;
            const dy = (event.clientY - drag.startY) / pointerScale;
            const next = drag.mode === "move" ? moveRegionBbox(drag.startBbox, dx, dy, bounds) : resizeRegionBbox(drag.startBbox, drag.handle, dx, dy, bounds, REGION_MIN_SIZE);
            update(drag.regionId, { bbox: next });
        };
        const onEnd = () => {
            dragRef.current = null;
            setDragging(false);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onEnd);
        window.addEventListener("pointercancel", onEnd);
        return () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onEnd);
            window.removeEventListener("pointercancel", onEnd);
        };
    }, [bounds, dragging, pointerScale, update]);

    if (!ctx) return null;

    const theme = ctx.theme;
    const handleSize = HANDLE_VISUAL_SIZE / Math.max(0.0001, contain.scale);
    const hasRegions = regions.length > 0;
    // The overlay root is pointer-events-none, so the entry must opt back in unconditionally:
    // hiding it with opacity alone still leaves it clickable, while a pointer-events toggle
    // would make a hover-revealed button visible but unclickable (measured in a real browser).
    const triggerClass = `pointer-events-auto absolute bottom-2 left-2 z-20 flex h-7 items-center gap-1 rounded-lg border px-2 text-[10px] font-medium opacity-0 shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition disabled:opacity-40 ${
        interactive ? "opacity-100" : "group-hover/node:opacity-100"
    }`;

    return (
        <div ref={rootRef} className="pointer-events-none absolute inset-0">
            {hasRegions && interactive && contain.width > 0 && contain.height > 0 ? (
                <div className="absolute" style={{ left: contain.offsetX, top: contain.offsetY, width: contain.width, height: contain.height }}>
                    {regions.map((region) => {
                        const color = REGION_TYPE_COLOR[region.type] || REGION_TYPE_COLOR.unknown;
                        const font = resolveFont(region);
                        const isSelected = region.id === selectedId;
                        const box: CSSProperties = {
                            left: region.bbox.x * contain.scale,
                            top: region.bbox.y * contain.scale,
                            width: region.bbox.w * contain.scale,
                            height: region.bbox.h * contain.scale,
                            fontFamily: font.family,
                            fontSize: font.sizePx * contain.scale,
                            fontWeight: font.weight === "bold" ? 700 : 400,
                            textAlign: font.align,
                            color,
                            borderColor: color,
                            borderStyle: "solid",
                            borderWidth: isSelected ? 2 : 1,
                            background: `${color}1a`,
                            lineHeight: 1.15,
                        };
                        return (
                            <div
                                key={region.id}
                                onPointerDown={(event) => beginDrag(event, region, "move", "se")}
                                onMouseDown={(event) => event.stopPropagation()}
                                className={`pointer-events-auto absolute cursor-move ${isSelected ? "z-10" : ""}`}
                                style={box}
                            >
                                <span className="block h-full w-full overflow-hidden" style={{ whiteSpace: "pre-wrap" }}>
                                    {region.text}
                                </span>
                                {isSelected
                                    ? REGION_RESIZE_HANDLES.map((handle) => (
                                          <span
                                              key={handle}
                                              onPointerDown={(event) => beginDrag(event, region, "resize", handle)}
                                              onMouseDown={(event) => event.stopPropagation()}
                                              className="pointer-events-auto absolute rounded-sm border border-white bg-stone-700"
                                              style={{ ...HANDLE_POSITION[handle], width: handleSize, height: handleSize, transform: "translate(-50%, -50%)", cursor: HANDLE_CURSOR[handle] }}
                                          />
                                      ))
                                    : null}
                            </div>
                        );
                    })}
                </div>
            ) : null}

            {interactive && selected ? (
                <div
                    className="pointer-events-auto absolute right-1 top-1 z-20 flex max-h-[calc(100%-0.5rem)] w-[178px] flex-col gap-1.5 overflow-auto rounded-lg border border-stone-200 bg-white/95 p-1.5 text-stone-700 shadow-lg backdrop-blur dark:border-stone-700 dark:bg-stone-900/95 dark:text-stone-200"
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <div className="flex items-center gap-1">
                        <span className="size-2 shrink-0 rounded-sm" style={{ background: REGION_TYPE_COLOR[selected.type] || REGION_TYPE_COLOR.unknown }} />
                        <span className="min-w-0 flex-1 truncate text-[10px] font-medium">{t(`canvas.regions.types.${selected.type}`)}</span>
                        {selected.confidence != null ? <span className="shrink-0 text-[9px] text-stone-400 dark:text-stone-500">{Math.round(selected.confidence * 100)}%</span> : null}
                        <button type="button" className={CONTROL_CLASS} title={t("canvas.regions.export")} onClick={() => saveAs(new Blob([exportJson()], { type: "application/json" }), `${ctx.node.title || "regions"}.json`)}>
                            <Download className="size-3" />
                        </button>
                        <button type="button" className={CONTROL_CLASS} title={t("canvas.regions.nodeClose")} onClick={() => select("")}>
                            <X className="size-3" />
                        </button>
                    </div>

                    <textarea value={selected.text} onChange={(event) => update(selected.id, { text: event.target.value })} placeholder={t("canvas.regions.textPlaceholder")} rows={2} className={`${FIELD_CLASS} resize-none`} />

                    <label className="flex items-center gap-1 text-[9px] text-stone-500 dark:text-stone-400">
                        <span className="w-7 shrink-0">{t("canvas.regions.propertyFont")}</span>
                        <select value={resolveFont(selected).family} onChange={(event) => update(selected.id, { font: { ...resolveFont(selected), family: event.target.value } })} className={FIELD_CLASS}>
                            {REGION_FONT_FAMILIES.map((family) => (
                                <option key={family} value={family}>
                                    {family}
                                </option>
                            ))}
                        </select>
                    </label>

                    <label className="flex items-center gap-1 text-[9px] text-stone-500 dark:text-stone-400">
                        <span className="w-7 shrink-0">{t("canvas.regions.propertySize")}</span>
                        <button type="button" className={CONTROL_CLASS} onClick={() => update(selected.id, { font: { ...resolveFont(selected), sizePx: normalizeFontSize(resolveFont(selected).sizePx - REGION_FONT_SIZE_STEP) } })}>
                            -
                        </button>
                        <input
                            type="number"
                            min={REGION_FONT_SIZE_MIN}
                            max={REGION_FONT_SIZE_MAX}
                            step={REGION_FONT_SIZE_STEP}
                            value={resolveFont(selected).sizePx}
                            onChange={(event) => update(selected.id, { font: { ...resolveFont(selected), sizePx: normalizeFontSize(event.target.value) } })}
                            className={`${FIELD_CLASS} text-center`}
                        />
                        <button type="button" className={CONTROL_CLASS} onClick={() => update(selected.id, { font: { ...resolveFont(selected), sizePx: normalizeFontSize(resolveFont(selected).sizePx + REGION_FONT_SIZE_STEP) } })}>
                            +
                        </button>
                    </label>

                    <div className="flex items-center gap-1 text-[9px] text-stone-500 dark:text-stone-400">
                        <span className="w-7 shrink-0">{t("canvas.regions.propertyAlign")}</span>
                        <div className="flex min-w-0 flex-1 items-center overflow-hidden rounded border border-stone-300 dark:border-stone-600">
                            {(["left", "center", "right"] as const).map((align) => (
                                <button
                                    key={align}
                                    type="button"
                                    onClick={() => update(selected.id, { font: { ...resolveFont(selected), align } })}
                                    className={`flex-1 px-1 py-0.5 text-[9px] ${resolveFont(selected).align === align ? "bg-stone-200 text-stone-800 dark:bg-stone-700 dark:text-stone-100" : "text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"}`}
                                >
                                    {t(`canvas.regions.align${align === "left" ? "Left" : align === "center" ? "Center" : "Right"}`)}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="flex items-center gap-1 text-[9px] text-stone-500 dark:text-stone-400">
                        <span className="w-7 shrink-0">{t("canvas.regions.propertyWeight")}</span>
                        <select value={resolveFont(selected).weight} onChange={(event) => update(selected.id, { font: { ...resolveFont(selected), weight: event.target.value === "bold" ? "bold" : "regular" } })} className={FIELD_CLASS}>
                            <option value="regular">{t("canvas.regions.weightRegular")}</option>
                            <option value="bold">{t("canvas.regions.weightBold")}</option>
                        </select>
                    </div>

                    <div className="text-[9px] leading-3 text-stone-400 dark:text-stone-500">{t("canvas.regions.selectedHint")}</div>
                </div>
            ) : null}

            {hasRegions ? (
                <div
                    className={`pointer-events-none absolute left-2 top-2 z-20 flex items-center gap-1 rounded-lg border px-1.5 py-1 text-[9px] opacity-0 shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition group-hover/node:opacity-100 ${interactive ? "opacity-100" : ""}`}
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                >
                    <Layers className="size-3" />
                    <span>{t("canvas.regions.regionCount", { count: regions.length })}</span>
                    {meta?.engine ? <span className="opacity-70">{meta.engine}</span> : null}
                    {elapsedMs != null ? <span className="opacity-70">{t("canvas.regions.elapsed", { ms: elapsedMs })}</span> : null}
                </div>
            ) : null}

            {status === "error" && error ? (
                <div className="pointer-events-none absolute inset-x-2 bottom-11 z-20 flex items-center gap-1.5 rounded border border-red-300 bg-red-50/95 px-2 py-1 text-[10px] text-red-600 dark:border-red-800 dark:bg-red-950/80 dark:text-red-300">
                    <AlertCircle className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate" title={error}>
                        {error}
                    </span>
                </div>
            ) : null}

            <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                    event.stopPropagation();
                    void parse();
                }}
                disabled={status === "parsing" || !canParse}
                className={triggerClass}
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                title={hasRegions ? t("canvas.regions.nodeReparse") : t("canvas.regions.nodeOpen")}
            >
                {status === "parsing" ? <Loader2 className="size-3 animate-spin" /> : <ScanText className="size-3" />}
                {hasRegions ? t("canvas.regions.nodeReparse") : t("canvas.regions.nodeOpen")}
            </button>
        </div>
    );
}
