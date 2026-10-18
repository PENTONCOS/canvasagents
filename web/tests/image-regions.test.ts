import { expect, test } from "bun:test";

import {
    REGION_FONT_FAMILIES,
    REGION_FONT_SIZE_MAX,
    REGION_FONT_SIZE_MIN,
    REGION_FONT_SIZE_STEP,
    REGION_MIN_SIZE,
    REGION_TYPE_COLOR,
    REGION_TYPES,
    imageContainRect,
    moveRegionBbox,
    normalizeFontSize,
    normalizeRegions,
    patchRegion,
    regionStyle,
    regionsToExport,
    resizeRegionBbox,
} from "../src/lib/canvas/image-regions-utils";
import enUS from "../src/i18n/locales/en-US";
import zhCN from "../src/i18n/locales/zh-CN";

const keyPaths = (value: unknown, prefix = ""): string[] =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key)) : prefix ? [prefix] : [];

test("normalizes a clean parse payload and rounds bbox values", () => {
    const raw = {
        ok: true,
        width: 800,
        height: 600,
        engine: "paddle",
        regions: [{ id: "r1", type: "title", bbox: { x: 10.4, y: 20.6, w: 100.2, h: 40.5 }, text: "Hello", confidence: 0.93, font: { sizePx: 24, weight: "bold", align: "center", family: "Georgia" } }],
    };
    expect(normalizeRegions(raw)).toEqual([{ id: "r1", type: "title", bbox: { x: 10, y: 21, w: 100, h: 41 }, text: "Hello", confidence: 0.93, font: { sizePx: 24, weight: "bold", align: "center", family: "Georgia" } }]);
});

test("normalizes dirty payloads: unknown types, missing fields, and out-of-bounds boxes", () => {
    const raw = {
        width: 100,
        height: 50,
        regions: [{ type: "mystery", bbox: { x: -20, y: -5, w: 500, h: 500 }, text: 123 }, null, { id: "e", bbox: {} }, { id: "f", bbox: { x: 90, y: 45, w: 40, h: 40 }, text: "ok", confidence: 5, font: { sizePx: -3, weight: "heavy", align: "justify" } }],
    };
    expect(normalizeRegions(raw)).toEqual([
        { id: "region-1", type: "unknown", bbox: { x: 0, y: 0, w: 100, h: 50 }, text: "" },
        { id: "e", type: "unknown", bbox: { x: 0, y: 0, w: REGION_MIN_SIZE, h: REGION_MIN_SIZE }, text: "" },
        { id: "f", type: "unknown", bbox: { x: 60, y: 10, w: 40, h: 40 }, text: "ok", confidence: 1 },
    ]);
});

test("normalizeRegions accepts a plain array and derives nothing when bounds are absent", () => {
    expect(normalizeRegions([{ id: "a", type: "body", bbox: { x: 0, y: 0, w: 10, h: 10 }, text: "b" }])).toEqual([{ id: "a", type: "body", bbox: { x: 0, y: 0, w: 10, h: 10 }, text: "b" }]);
    expect(normalizeRegions({ nothing: true })).toEqual([]);
    expect(normalizeRegions(null)).toEqual([]);
});

test("moveRegionBbox clamps the box inside the image bounds", () => {
    const bounds = { width: 100, height: 100 };
    expect(moveRegionBbox({ x: 10, y: 10, w: 50, h: 50 }, 5, 7, bounds)).toEqual({ x: 15, y: 17, w: 50, h: 50 });
    expect(moveRegionBbox({ x: 10, y: 10, w: 50, h: 50 }, 1000, 1000, bounds)).toEqual({ x: 50, y: 50, w: 50, h: 50 });
    expect(moveRegionBbox({ x: 10, y: 10, w: 50, h: 50 }, -1000, -1000, bounds)).toEqual({ x: 0, y: 0, w: 50, h: 50 });
});

test("resizeRegionBbox clamps edges and enforces the minimum size", () => {
    const bounds = { width: 100, height: 100 };
    expect(resizeRegionBbox({ x: 10, y: 10, w: 50, h: 50 }, "se", 1000, 1000, bounds)).toEqual({ x: 10, y: 10, w: 90, h: 90 });
    expect(resizeRegionBbox({ x: 10, y: 10, w: 50, h: 50 }, "nw", -1000, -1000, bounds)).toEqual({ x: 0, y: 0, w: 60, h: 60 });
    expect(resizeRegionBbox({ x: 10, y: 10, w: 50, h: 50 }, "se", -1000, -1000, bounds, 20)).toEqual({ x: 10, y: 10, w: 20, h: 20 });
    expect(resizeRegionBbox({ x: 80, y: 80, w: 15, h: 15 }, "w", 100, 0, bounds, 4)).toEqual({ x: 91, y: 80, w: 4, h: 15 });
    expect(resizeRegionBbox({ x: 20, y: 20, w: 30, h: 30 }, "e", 5, 8, bounds)).toEqual({ x: 20, y: 20, w: 35, h: 30 });
});

test("regionStyle maps bbox, font, and type color into overlay style", () => {
    expect(regionStyle({ id: "r", type: "title", bbox: { x: 1, y: 2, w: 3, h: 4 }, text: "" })).toEqual({
        left: 1,
        top: 2,
        width: 3,
        height: 4,
        fontFamily: REGION_FONT_FAMILIES[0],
        fontSize: 16,
        fontWeight: 400,
        textAlign: "left",
        color: REGION_TYPE_COLOR.title,
    });
    expect(regionStyle({ id: "r", type: "button", bbox: { x: 0, y: 0, w: 10, h: 10 }, text: "", font: { sizePx: 32, weight: "bold", align: "right", family: "Menlo" } })).toEqual({
        left: 0,
        top: 0,
        width: 10,
        height: 10,
        fontFamily: "Menlo",
        fontSize: 32,
        fontWeight: 700,
        textAlign: "right",
        color: REGION_TYPE_COLOR.button,
    });
});

test("regionsToExport is deterministic with a stable key order", () => {
    const meta = {
        source: "data:image/png;base64,AAAA",
        width: 100,
        height: 50,
        engine: "paddle",
        parsedAt: 123,
        regions: [{ id: "r1", type: "title" as const, bbox: { x: 1, y: 2, w: 3, h: 4 }, text: "Hi", confidence: 0.5, font: { sizePx: 20, weight: "bold" as const, align: "center" as const, family: "Arial" } }],
    };
    const expected = JSON.stringify(
        {
            source: "data:image/png;base64,AAAA",
            width: 100,
            height: 50,
            engine: "paddle",
            parsedAt: 123,
            regions: [{ id: "r1", type: "title", bbox: { x: 1, y: 2, w: 3, h: 4 }, text: "Hi", confidence: 0.5, font: { sizePx: 20, weight: "bold", align: "center", family: "Arial" } }],
        },
        null,
        2,
    );
    expect(regionsToExport(meta)).toBe(expected);
    expect(regionsToExport(meta)).toBe(regionsToExport(meta));
    expect(Object.keys(JSON.parse(regionsToExport(meta)))).toEqual(["source", "width", "height", "engine", "parsedAt", "regions"]);
});

test("regionsToExport fills absent metadata with stable nulls", () => {
    const parsed = JSON.parse(regionsToExport(undefined));
    expect(parsed).toEqual({ source: "", width: null, height: null, engine: "", parsedAt: null, regions: [] });
    expect(JSON.parse(regionsToExport({ regions: [{ id: "a", type: "body", bbox: { x: 0, y: 0, w: 1, h: 1 }, text: "" }] })).regions[0].font).toEqual({ sizePx: null, weight: null, align: null, family: null });
});

test("font presets and size range stay coherent", () => {
    expect(REGION_FONT_FAMILIES.length).toBeGreaterThanOrEqual(5);
    for (const family of REGION_FONT_FAMILIES) {
        expect(typeof family).toBe("string");
        expect(family.trim().length).toBeGreaterThan(0);
    }
    expect(REGION_FONT_FAMILIES).toContain("PingFang SC");
    expect(REGION_FONT_FAMILIES).toContain("Helvetica Neue");
    expect(REGION_FONT_FAMILIES).toContain("Arial");
    expect(REGION_FONT_FAMILIES).toContain("Georgia");
    expect(REGION_FONT_FAMILIES).toContain("Menlo");
    expect(REGION_FONT_SIZE_MIN).toBeLessThan(REGION_FONT_SIZE_MAX);
    expect(REGION_FONT_SIZE_STEP).toBeGreaterThan(0);
    expect(normalizeFontSize(-100)).toBe(REGION_FONT_SIZE_MIN);
    expect(normalizeFontSize(100000)).toBe(REGION_FONT_SIZE_MAX);
    expect(normalizeFontSize("24")).toBe(24);
});

test("region types and colors cover every kind", () => {
    for (const type of REGION_TYPES) expect(REGION_TYPE_COLOR[type]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(REGION_TYPES).toContain("unknown");
});

test("patchRegion updates one region immutably and keeps the rest", () => {
    const meta = {
        regions: [
            { id: "a", type: "title" as const, bbox: { x: 0, y: 0, w: 10, h: 10 }, text: "a" },
            { id: "b", type: "body" as const, bbox: { x: 1, y: 1, w: 10, h: 10 }, text: "b" },
        ],
        selectedRegionId: "a",
    };
    const next = patchRegion(meta, "b", { text: "changed", bbox: { x: 5, y: 5, w: 20, h: 20 } });
    expect(next.regions?.[0]).toEqual(meta.regions[0]);
    expect(next.regions?.[1]).toEqual({ id: "b", type: "body", bbox: { x: 5, y: 5, w: 20, h: 20 }, text: "changed" });
    expect(next.regions).not.toBe(meta.regions);
    expect(next.selectedRegionId).toBe("a");
});

test("zh-CN and en-US keep the canvas key paths aligned after the regions addition", () => {
    const zh = keyPaths(zhCN.canvas).sort();
    const en = keyPaths(enUS.canvas).sort();
    expect(zh).toEqual(en);
    expect(zh.length).toBeGreaterThan(572);
    expect(zh).toContain("regions.parse");
    expect(zh).toContain("regions.types.unknown");
    expect(zh).toContain("nodeTypes.imageRegions");
});

test("imageContainRect centres a landscape image inside a portrait box", () => {
    // 800x400 natural into a 300x300 box: limited by width, so scale 0.375 and 75px of vertical slack.
    expect(imageContainRect({ width: 300, height: 300 }, { width: 800, height: 400 })).toEqual({ scale: 0.375, offsetX: 0, offsetY: 75, width: 300, height: 150 });
});

test("imageContainRect letters the long axis and never upscales past the container", () => {
    const rect = imageContainRect({ width: 200, height: 100 }, { width: 100, height: 100 });
    expect(rect.scale).toBe(1);
    expect(rect.width).toBe(100);
    expect(rect.height).toBe(100);
    expect(rect.offsetX).toBe(50);
    expect(rect.offsetY).toBe(0);
});

test("imageContainRect degrades safely when a dimension is unknown", () => {
    expect(imageContainRect({ width: 0, height: 0 }, { width: 100, height: 50 })).toEqual({ scale: 1, offsetX: 0, offsetY: 0, width: 100, height: 50 });
    expect(imageContainRect({ width: 300, height: 200 }, { width: 0, height: 0 })).toEqual({ scale: 1, offsetX: 0, offsetY: 0, width: 0, height: 0 });
});
