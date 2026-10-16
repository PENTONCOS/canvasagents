// M7: image structure node. Parses an image into a structure layer (title/body/button boxes with
// text and font hints) through the agent bridge and renders editable overlays on top of the image.
// Edits only touch metadata.regions; the source image pixels are never modified.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

import { saveAs } from "file-saver";
import { AlertCircle, Download, Image as ImageIcon, Layers, Loader2, ScanText } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { isAbsoluteRepoPath } from "@/lib/canvas/code-node-utils";
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
    moveRegionBbox,
    normalizeFontSize,
    normalizeRegions,
    patchRegion,
    regionStyle,
    regionsToExport,
    resizeRegionBbox,
    type RegionResizeHandle,
} from "@/lib/canvas/image-regions-utils";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { parseImageRegions, type AgentImageParseBody } from "@/services/api/canvas-agent";
import { useAgentStore } from "@/stores/use-agent-store";
import type { CanvasImageRegion, CanvasImageRegionBbox, CanvasImageRegionFont, CanvasNodeRegionsMetadata } from "@/types/canvas";
import type { CanvasNodeContext, CanvasNodeDefinition } from "@/types/canvas-plugin";

export const IMAGE_REGIONS_NODE_TYPE = "image-regions";

const CONTROL_CLASS = "shrink-0 rounded border border-stone-300 bg-transparent px-1.5 py-1 text-[11px] text-stone-600 hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800";
const FIELD_CLASS = "w-full min-w-0 rounded border border-stone-300 bg-transparent px-1.5 py-1 text-[11px] text-stone-700 outline-none dark:border-stone-700 dark:text-stone-200";
const HANDLE_VISUAL_SIZE = 10;
const MAX_REGIONS = 200;
const DATA_URL_PATTERN = /^data:[^;,]*;base64,([\s\S]+)$/;

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

type ParseStatus = "idle" | "parsing" | "ready" | "error";
type DragMode = "move" | "resize";
type DragState = { regionId: string; mode: DragMode; handle: RegionResizeHandle; startX: number; startY: number; startBbox: CanvasImageRegionBbox };

function errorMessage(cause: unknown) {
    return cause instanceof Error ? cause.message : String(cause);
}

function dataUrlBase64(value: string) {
    const match = DATA_URL_PATTERN.exec(value);
    return match ? match[1] : value.trim();
}

function parseLang() {
    return i18n.language?.startsWith("zh") ? "zh-Hans" : "en-US";
}

// URL sources are downloaded and converted to base64 so the bridge receives a single payload shape.
async function urlToBase64(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status}`);
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = typeof reader.result === "string" ? reader.result : "";
            const match = DATA_URL_PATTERN.exec(result);
            if (match) resolve(match[1]);
            else reject(new Error("data-url"));
        };
        reader.onerror = () => reject(reader.error instanceof Error ? reader.error : new Error("read-failed"));
        reader.readAsDataURL(blob);
    });
}

function resolveFont(region: CanvasImageRegion): Required<CanvasImageRegionFont> {
    return {
        sizePx: region.font?.sizePx ?? REGION_DEFAULT_FONT_SIZE_PX,
        weight: region.font?.weight ?? "regular",
        align: region.font?.align ?? "left",
        family: region.font?.family || REGION_DEFAULT_FONT_FAMILY,
    };
}

function ImageRegionsView({ ctx }: { ctx: CanvasNodeContext }) {
    const { t } = useTranslation();
    const agentUrl = useAgentStore((state) => state.url);
    const agentToken = useAgentStore((state) => state.token);
    const hasAgent = Boolean(agentUrl && agentToken);

    const meta: CanvasNodeRegionsMetadata | undefined = ctx.node.metadata?.regions;
    const source = meta?.source || ctx.node.metadata?.content || "";
    const regions = meta?.regions || [];
    const selectedId = meta?.selectedRegionId || "";
    const selected = regions.find((region) => region.id === selectedId) || null;

    const [status, setStatus] = useState<ParseStatus>(regions.length ? "ready" : "idle");
    const [error, setError] = useState("");
    const [elapsedMs, setElapsedMs] = useState<number | null>(null);
    const [dragging, setDragging] = useState(false);

    const stageRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<DragState | null>(null);
    const metaRef = useRef(meta);
    metaRef.current = meta;

    const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
    useEffect(() => {
        const element = stageRef.current;
        if (!element) return;
        const update = () => setStageSize({ width: element.clientWidth, height: element.clientHeight });
        update();
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const natural = useMemo(
        () => ({
            width: meta?.width && meta.width > 0 ? meta.width : stageSize.width || ctx.node.width,
            height: meta?.height && meta.height > 0 ? meta.height : stageSize.height || ctx.node.height,
        }),
        [ctx.node.height, ctx.node.width, meta?.height, meta?.width, stageSize.height, stageSize.width],
    );

    const displayScale = useMemo(() => {
        if (!natural.width || !natural.height || !stageSize.width || !stageSize.height) return 1;
        return Math.min(stageSize.width / natural.width, stageSize.height / natural.height);
    }, [natural.height, natural.width, stageSize.height, stageSize.width]);

    const bounds = useMemo(() => ({ width: natural.width, height: natural.height }), [natural.height, natural.width]);
    const pointerScale = Math.max(0.0001, ctx.scale * displayScale);

    const writeRegions = useCallback(
        (next: CanvasNodeRegionsMetadata) => {
            ctx.updateMetadata({ regions: next });
        },
        [ctx],
    );

    const selectRegion = useCallback(
        (regionId: string) => {
            writeRegions({ ...(metaRef.current ?? {}), selectedRegionId: regionId });
        },
        [writeRegions],
    );

    const updateRegion = useCallback(
        (regionId: string, patch: Partial<CanvasImageRegion>) => {
            writeRegions(patchRegion(metaRef.current, regionId, patch));
        },
        [writeRegions],
    );

    const runParse = useCallback(async () => {
        if (!source) {
            setStatus("error");
            setError(i18n.t("canvas.regions.noSource"));
            return;
        }
        if (!hasAgent) {
            setStatus("error");
            setError(i18n.t("canvas.regions.notConnected"));
            return;
        }
        setStatus("parsing");
        setError("");
        const startedAt = Date.now();
        try {
            const body: AgentImageParseBody = { options: { lang: parseLang(), maxRegions: MAX_REGIONS } };
            if (isAbsoluteRepoPath(source)) body.path = source;
            else if (source.startsWith("data:")) body.image = dataUrlBase64(source);
            else body.image = await urlToBase64(source);
            const response = await parseImageRegions(agentUrl, agentToken, body);
            const parsed = normalizeRegions(response, response.width, response.height);
            const width = response.width && response.width > 0 ? Math.round(response.width) : natural.width;
            const height = response.height && response.height > 0 ? Math.round(response.height) : natural.height;
            writeRegions({ source, width, height, engine: response.engine || "", parsedAt: Date.now(), regions: parsed, selectedRegionId: undefined });
            setElapsedMs(Date.now() - startedAt);
            setStatus("ready");
        } catch (cause) {
            setStatus("error");
            setError(errorMessage(cause));
        }
    }, [agentToken, agentUrl, hasAgent, natural.height, natural.width, source, writeRegions]);

    const exportJson = useCallback(() => {
        const text = regionsToExport(metaRef.current);
        saveAs(new Blob([text], { type: "application/json" }), `${ctx.node.title || "regions"}.json`);
    }, [ctx.node.title]);

    const beginDrag = useCallback((event: ReactPointerEvent, region: CanvasImageRegion, mode: DragMode, handle: RegionResizeHandle) => {
        event.stopPropagation();
        event.preventDefault();
        selectRegion(region.id);
        dragRef.current = { regionId: region.id, mode, handle, startX: event.clientX, startY: event.clientY, startBbox: { ...region.bbox } };
        setDragging(true);
    }, [selectRegion]);

    useEffect(() => {
        if (!dragging) return;
        const onMove = (event: PointerEvent) => {
            const drag = dragRef.current;
            if (!drag) return;
            const dx = (event.clientX - drag.startX) / pointerScale;
            const dy = (event.clientY - drag.startY) / pointerScale;
            const next = drag.mode === "move" ? moveRegionBbox(drag.startBbox, dx, dy, bounds) : resizeRegionBbox(drag.startBbox, drag.handle, dx, dy, bounds, REGION_MIN_SIZE);
            updateRegion(drag.regionId, { bbox: next });
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
    }, [bounds, dragging, pointerScale, updateRegion]);

    const handleSize = HANDLE_VISUAL_SIZE / Math.max(0.0001, displayScale);
    const displayWidth = natural.width * displayScale;
    const displayHeight = natural.height * displayScale;

    return (
        <div className="flex h-full w-full flex-col overflow-hidden bg-white text-stone-700 dark:bg-stone-900 dark:text-stone-200">
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-stone-200 px-2 py-1.5 dark:border-stone-800">
                <Layers className="size-3.5 shrink-0 text-stone-500 dark:text-stone-400" />
                <span className="min-w-0 truncate text-[11px] font-medium">{t("canvas.regions.title")}</span>
                {status === "parsing" ? <Loader2 className="size-3 shrink-0 animate-spin text-stone-400" /> : null}
                {meta?.engine ? (
                    <span className="shrink-0 rounded bg-stone-100 px-1 py-0.5 text-[10px] text-stone-600 dark:bg-stone-800 dark:text-stone-300">{t("canvas.regions.engine", { engine: meta.engine })}</span>
                ) : null}
                {elapsedMs != null ? <span className="shrink-0 text-[10px] text-stone-400 dark:text-stone-500">{t("canvas.regions.elapsed", { ms: elapsedMs })}</span> : null}
                <span className="shrink-0 text-[10px] text-stone-500 dark:text-stone-400">{t("canvas.regions.regionCount", { count: regions.length })}</span>
                <span className="min-w-0 flex-1" />
                <button type="button" onClick={() => void runParse()} disabled={status === "parsing" || !source} title={t("canvas.regions.parse")} className={`${CONTROL_CLASS} flex items-center gap-1`}>
                    <ScanText className="size-3.5" />
                    {status === "parsing" ? t("canvas.regions.parsing") : status === "error" ? t("canvas.regions.retry") : t("canvas.regions.parse")}
                </button>
                <button type="button" onClick={exportJson} disabled={!regions.length} title={t("canvas.regions.export")} className={CONTROL_CLASS}>
                    <Download className="size-3.5" />
                </button>
            </div>

            <div className="flex min-h-0 flex-1">
                <div ref={stageRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-stone-100 dark:bg-stone-950">
                    {source ? (
                        <div className="absolute" style={{ left: (stageSize.width - displayWidth) / 2, top: (stageSize.height - displayHeight) / 2, width: displayWidth, height: displayHeight }}>
                            <div className="absolute left-0 top-0" style={{ width: natural.width, height: natural.height, transform: `scale(${displayScale})`, transformOrigin: "top left" }}>
                                <img src={source} alt="" draggable={false} className="absolute inset-0 h-full w-full select-none object-fill" />
                                {regions.map((region) => {
                                    const color = REGION_TYPE_COLOR[region.type] || REGION_TYPE_COLOR.unknown;
                                    const isSelected = region.id === selectedId;
                                    return (
                                        <div
                                            key={region.id}
                                            onPointerDown={(event) => beginDrag(event, region, "move", "se")}
                                            className={`absolute cursor-move ${isSelected ? "z-10" : ""}`}
                                            style={{ ...regionStyle(region), borderColor: color, borderStyle: "solid", borderWidth: isSelected ? 2 : 1, background: `${color}1a`, lineHeight: 1.15 }}
                                        >
                                            <span className="block h-full w-full overflow-hidden" style={{ whiteSpace: "pre-wrap" }}>
                                                {region.text}
                                            </span>
                                            {isSelected
                                                ? REGION_RESIZE_HANDLES.map((handle) => (
                                                      <span
                                                          key={handle}
                                                          onPointerDown={(event) => beginDrag(event, region, "resize", handle)}
                                                          className="absolute rounded-sm border border-white bg-stone-700"
                                                          style={{ ...HANDLE_POSITION[handle], width: handleSize, height: handleSize, transform: "translate(-50%, -50%)", cursor: HANDLE_CURSOR[handle] }}
                                                      />
                                                  ))
                                                : null}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ) : (
                        <div className="flex h-full w-full items-center justify-center px-4 text-center text-[11px] text-stone-400 dark:text-stone-500">{t("canvas.regions.noSource")}</div>
                    )}

                    {status === "error" && error ? (
                        <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-center gap-1.5 rounded border border-red-300 bg-red-50 px-2 py-1 text-[11px] text-red-600 dark:border-red-800 dark:bg-red-950/60 dark:text-red-300">
                            <AlertCircle className="size-3.5 shrink-0" />
                            <span className="min-w-0 flex-1 truncate" title={error}>
                                {error || t("canvas.regions.parseFailed")}
                            </span>
                        </div>
                    ) : null}

                    {!regions.length && status !== "parsing" && source ? (
                        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-[11px] text-stone-500 dark:text-stone-400">
                            <span className="flex items-center gap-1.5 rounded bg-white/80 px-2 py-1 dark:bg-stone-900/80">
                                <ImageIcon className="size-3.5" />
                                {t("canvas.regions.empty")}
                            </span>
                        </div>
                    ) : null}
                </div>

                {selected ? (
                    <div className="flex w-[190px] shrink-0 flex-col gap-2 overflow-auto border-l border-stone-200 p-2 dark:border-stone-800">
                        <div className="flex items-center gap-1.5">
                            <span className="size-2 shrink-0 rounded-sm" style={{ background: REGION_TYPE_COLOR[selected.type] || REGION_TYPE_COLOR.unknown }} />
                            <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{t(`canvas.regions.types.${selected.type}`)}</span>
                            {selected.confidence != null ? <span className="shrink-0 text-[10px] text-stone-400 dark:text-stone-500">{Math.round(selected.confidence * 100)}%</span> : null}
                        </div>

                        <label className="flex flex-col gap-1 text-[10px] text-stone-500 dark:text-stone-400">
                            {t("canvas.regions.propertyText")}
                            <textarea
                                value={selected.text}
                                onChange={(event) => updateRegion(selected.id, { text: event.target.value })}
                                placeholder={t("canvas.regions.textPlaceholder")}
                                rows={3}
                                className={`${FIELD_CLASS} resize-none`}
                            />
                        </label>

                        <label className="flex flex-col gap-1 text-[10px] text-stone-500 dark:text-stone-400">
                            {t("canvas.regions.propertyFont")}
                            <select value={resolveFont(selected).family} onChange={(event) => updateRegion(selected.id, { font: { ...resolveFont(selected), family: event.target.value } })} className={FIELD_CLASS}>
                                {REGION_FONT_FAMILIES.map((family) => (
                                    <option key={family} value={family}>
                                        {family}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className="flex flex-col gap-1 text-[10px] text-stone-500 dark:text-stone-400">
                            {t("canvas.regions.propertySize")}
                            <span className="flex items-center gap-1">
                                <button type="button" className={CONTROL_CLASS} onClick={() => updateRegion(selected.id, { font: { ...resolveFont(selected), sizePx: normalizeFontSize(resolveFont(selected).sizePx - REGION_FONT_SIZE_STEP) } })}>
                                    -
                                </button>
                                <input
                                    type="number"
                                    min={REGION_FONT_SIZE_MIN}
                                    max={REGION_FONT_SIZE_MAX}
                                    step={REGION_FONT_SIZE_STEP}
                                    value={resolveFont(selected).sizePx}
                                    onChange={(event) => updateRegion(selected.id, { font: { ...resolveFont(selected), sizePx: normalizeFontSize(event.target.value) } })}
                                    className={`${FIELD_CLASS} text-center`}
                                />
                                <button type="button" className={CONTROL_CLASS} onClick={() => updateRegion(selected.id, { font: { ...resolveFont(selected), sizePx: normalizeFontSize(resolveFont(selected).sizePx + REGION_FONT_SIZE_STEP) } })}>
                                    +
                                </button>
                            </span>
                        </label>

                        <label className="flex flex-col gap-1 text-[10px] text-stone-500 dark:text-stone-400">
                            {t("canvas.regions.propertyWeight")}
                            <select
                                value={resolveFont(selected).weight}
                                onChange={(event) => updateRegion(selected.id, { font: { ...resolveFont(selected), weight: event.target.value === "bold" ? "bold" : "regular" } })}
                                className={FIELD_CLASS}
                            >
                                <option value="regular">{t("canvas.regions.weightRegular")}</option>
                                <option value="bold">{t("canvas.regions.weightBold")}</option>
                            </select>
                        </label>

                        <div className="flex flex-col gap-1 text-[10px] text-stone-500 dark:text-stone-400">
                            {t("canvas.regions.propertyAlign")}
                            <div className="flex items-center overflow-hidden rounded border border-stone-300 dark:border-stone-700">
                                {(["left", "center", "right"] as const).map((align) => (
                                    <button
                                        key={align}
                                        type="button"
                                        onClick={() => updateRegion(selected.id, { font: { ...resolveFont(selected), align } })}
                                        className={`flex-1 px-1 py-1 text-[10px] ${resolveFont(selected).align === align ? "bg-stone-200 text-stone-800 dark:bg-stone-700 dark:text-stone-100" : "text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"}`}
                                    >
                                        {t(`canvas.regions.align${align === "left" ? "Left" : align === "center" ? "Center" : "Right"}`)}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="text-[10px] leading-4 text-stone-400 dark:text-stone-500">{t("canvas.regions.selectedHint")}</div>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

export function imageRegionsNodeDefinition(): CanvasNodeDefinition {
    return {
        type: IMAGE_REGIONS_NODE_TYPE,
        title: i18n.t("canvas.nodeTypes.imageRegions"),
        icon: <Layers className="size-4" />,
        description: i18n.t("canvas.regions.description"),
        minimapColor: "#0ea5e9",
        defaultSize: { width: 420, height: 320 },
        defaultMetadata: { regions: {} },
        hidePanel: true,
        Content: ({ ctx }) => <ImageRegionsView ctx={ctx} />,
    };
}

let registered = false;
export function registerImageRegionsNode() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions([imageRegionsNodeDefinition()], "builtin");
}
