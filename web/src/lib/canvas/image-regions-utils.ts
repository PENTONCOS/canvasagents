// M7: pure helpers for the image structure layer. Everything here is DOM-free so it can be unit
// tested directly (see tests/image-regions.test.ts) and reused by the image-regions node. Region
// bboxes always live in the source image's pixel space; every write clamps them inside the image.
import type { CSSProperties } from "react";

import type { CanvasImageRegion, CanvasImageRegionFont, CanvasImageRegionType, CanvasNodeRegionsMetadata } from "@/types/canvas";

// Canonical region kinds. Anything the parser reports that is not listed here normalizes to
// "unknown" so the overlay never renders an undefined color.
export const REGION_TYPES: CanvasImageRegionType[] = ["title", "subtitle", "body", "button", "label", "logo", "image", "unknown"];

// Overlay color per region kind, shared by the box border and the region text.
export const REGION_TYPE_COLOR: Record<CanvasImageRegionType, string> = {
    title: "#6366f1",
    subtitle: "#8b5cf6",
    body: "#0ea5e9",
    button: "#f97316",
    label: "#14b8a6",
    logo: "#eab308",
    image: "#22c55e",
    unknown: "#94a3b8",
};

// Preset font families offered in the region editor; the values are stored as-is in metadata.
export const REGION_FONT_FAMILIES = ["PingFang SC", "Helvetica Neue", "Arial", "Georgia", "Menlo", "Times New Roman", "Courier New", "system-ui"];

export const REGION_FONT_SIZE_MIN = 8;
export const REGION_FONT_SIZE_MAX = 200;
export const REGION_FONT_SIZE_STEP = 1;

export const REGION_DEFAULT_FONT_FAMILY = REGION_FONT_FAMILIES[0];
export const REGION_DEFAULT_FONT_SIZE_PX = 16;
export const REGION_DEFAULT_FONT_WEIGHT: NonNullable<CanvasImageRegionFont["weight"]> = "regular";
export const REGION_DEFAULT_ALIGN: NonNullable<CanvasImageRegionFont["align"]> = "left";

export const REGION_MIN_SIZE = 4;

export type RegionBounds = { width: number; height: number };
export type RegionResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const REGION_RESIZE_HANDLES: RegionResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

function finite(value: unknown, fallback: number) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positive(value: unknown): number | undefined {
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    return Number.isFinite(number) && number > 0 ? Math.round(number) : undefined;
}

// Normalizes a parser-reported kind to a known region type, defaulting to "unknown".
export function normalizeRegionType(value: unknown): CanvasImageRegionType {
    return typeof value === "string" && (REGION_TYPES as string[]).includes(value) ? (value as CanvasImageRegionType) : "unknown";
}

function normalizeFont(raw: unknown): CanvasImageRegionFont | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const source = raw as Record<string, unknown>;
    const font: CanvasImageRegionFont = {};
    const sizePx = positive(source.sizePx);
    if (sizePx !== undefined) font.sizePx = sizePx;
    if (source.weight === "regular" || source.weight === "bold") font.weight = source.weight;
    if (source.align === "left" || source.align === "center" || source.align === "right") font.align = source.align;
    if (typeof source.family === "string" && source.family.trim()) font.family = source.family.trim();
    return Object.keys(font).length ? font : undefined;
}

// Rounds a bbox to integers and clamps it inside the image so x >= 0, y >= 0, x + w <= width, y + h <= height.
export function clampRegionBbox(bbox: { x: number; y: number; w: number; h: number }, bounds: RegionBounds) {
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    const w = clamp(Math.round(bbox.w), REGION_MIN_SIZE, width);
    const h = clamp(Math.round(bbox.h), REGION_MIN_SIZE, height);
    const x = clamp(Math.round(bbox.x), 0, width - w);
    const y = clamp(Math.round(bbox.y), 0, height - h);
    return { x, y, w, h };
}

function resolveBounds(raw: Record<string, unknown>, width?: number, height?: number): RegionBounds {
    return {
        width: positive(width) ?? positive(raw.width) ?? Number.MAX_SAFE_INTEGER,
        height: positive(height) ?? positive(raw.height) ?? Number.MAX_SAFE_INTEGER,
    };
}

// Maps a /image/parse payload into CanvasImageRegion[]: unknown types become "unknown", missing
// text/confidence are defaulted, bboxes are rounded and clamped inside the image dimensions.
export function normalizeRegions(raw: unknown, width?: number, height?: number): CanvasImageRegion[] {
    const container = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
    const list = Array.isArray(raw) ? raw : Array.isArray(container?.regions) ? (container?.regions as unknown[]) : [];
    const source = container ?? {};
    const bounds = resolveBounds(source, width, height);

    return list.flatMap((item, index) => {
        if (!item || typeof item !== "object") return [];
        const entry = item as Record<string, unknown>;
        const bboxRaw = entry.bbox && typeof entry.bbox === "object" ? (entry.bbox as Record<string, unknown>) : {};
        const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : `region-${index + 1}`;
        const confidence = typeof entry.confidence === "number" && Number.isFinite(entry.confidence) ? clamp(entry.confidence, 0, 1) : undefined;
        const region: CanvasImageRegion = {
            id,
            type: normalizeRegionType(entry.type),
            bbox: clampRegionBbox(
                {
                    x: finite(bboxRaw.x, 0),
                    y: finite(bboxRaw.y, 0),
                    w: finite(bboxRaw.w, 0) || REGION_MIN_SIZE,
                    h: finite(bboxRaw.h, 0) || REGION_MIN_SIZE,
                },
                bounds,
            ),
            text: typeof entry.text === "string" ? entry.text : "",
        };
        if (confidence !== undefined) region.confidence = confidence;
        const font = normalizeFont(entry.font);
        if (font) region.font = font;
        return [region];
    });
}

// Drag: offset the box by (dx, dy) while keeping it fully inside the image bounds.
export function moveRegionBbox(bbox: { x: number; y: number; w: number; h: number }, dx: number, dy: number, bounds: RegionBounds) {
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    const w = clamp(Math.round(bbox.w), REGION_MIN_SIZE, width);
    const h = clamp(Math.round(bbox.h), REGION_MIN_SIZE, height);
    return {
        x: clamp(Math.round(bbox.x + dx), 0, width - w),
        y: clamp(Math.round(bbox.y + dy), 0, height - h),
        w,
        h,
    };
}

// Resize: move only the edges addressed by the handle, keeping the box inside the image and no
// smaller than minSize on either axis.
export function resizeRegionBbox(bbox: { x: number; y: number; w: number; h: number }, handle: RegionResizeHandle, dx: number, dy: number, bounds: RegionBounds, minSize = REGION_MIN_SIZE) {
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    const min = Math.max(1, Math.round(minSize));
    let left = bbox.x;
    let top = bbox.y;
    let right = bbox.x + bbox.w;
    let bottom = bbox.y + bbox.h;

    if (handle.includes("w")) left = clamp(bbox.x + dx, 0, right - min);
    if (handle.includes("e")) right = clamp(bbox.x + bbox.w + dx, left + min, width);
    if (handle.includes("n")) top = clamp(bbox.y + dy, 0, bottom - min);
    if (handle.includes("s")) bottom = clamp(bbox.y + bbox.h + dy, top + min, height);

    return {
        x: Math.round(left),
        y: Math.round(top),
        w: Math.round(right - left),
        h: Math.round(bottom - top),
    };
}

// Maps one region to its overlay style: the box geometry in image pixels plus the resolved text
// font and kind color.
export function regionStyle(region: CanvasImageRegion): CSSProperties {
    const font = region.font;
    return {
        left: region.bbox.x,
        top: region.bbox.y,
        width: region.bbox.w,
        height: region.bbox.h,
        fontFamily: font?.family || REGION_DEFAULT_FONT_FAMILY,
        fontSize: font?.sizePx ?? REGION_DEFAULT_FONT_SIZE_PX,
        fontWeight: font?.weight === "bold" ? 700 : 400,
        textAlign: font?.align || REGION_DEFAULT_ALIGN,
        color: REGION_TYPE_COLOR[region.type] || REGION_TYPE_COLOR.unknown,
    };
}

// Font patch used by the editor steppers; values are clamped to the supported range.
export function normalizeFontSize(value: unknown): number {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number)) return REGION_DEFAULT_FONT_SIZE_PX;
    return clamp(Math.round(number), REGION_FONT_SIZE_MIN, REGION_FONT_SIZE_MAX);
}

// Export the structure layer as JSON text with a stable key order so diffs stay readable.
export function regionsToExport(meta?: CanvasNodeRegionsMetadata | null): string {
    const regions = (meta?.regions || []).map((region) => ({
        id: region.id,
        type: region.type,
        bbox: { x: region.bbox.x, y: region.bbox.y, w: region.bbox.w, h: region.bbox.h },
        text: region.text,
        confidence: region.confidence ?? null,
        font: {
            sizePx: region.font?.sizePx ?? null,
            weight: region.font?.weight ?? null,
            align: region.font?.align ?? null,
            family: region.font?.family ?? null,
        },
    }));

    return JSON.stringify(
        {
            source: meta?.source || "",
            width: meta?.width ?? null,
            height: meta?.height ?? null,
            engine: meta?.engine || "",
            parsedAt: meta?.parsedAt ?? null,
            regions,
        },
        null,
        2,
    );
}

// Immutable edit of a single region; returns a fresh metadata object for ctx.updateMetadata.
export function patchRegion(meta: CanvasNodeRegionsMetadata | undefined, regionId: string, patch: Partial<CanvasImageRegion>): CanvasNodeRegionsMetadata {
    const regions = (meta?.regions || []).map((region) => (region.id === regionId ? { ...region, ...patch, bbox: patch.bbox ? { ...patch.bbox } : region.bbox } : region));
    return { ...meta, regions };
}
