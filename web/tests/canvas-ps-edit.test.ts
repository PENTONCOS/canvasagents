// "Edit this image in PS" must (a) be reachable from any image node's toolbar, and (b) write the
// exported bitmap back into that same node — same id, still an image node, never a new node. These
// tests pin the pure parts of that contract plus the tool wiring, without a browser.
import { describe, expect, test } from "bun:test";

import { PS_SAVE_AS_NODE_GAP_PX, applyPsEditSave, buildPsEditMetadata, buildPsSaveAsNodeMetadata, psSaveAsNodePosition } from "@/lib/canvas/canvas-node-ps-edit";
import { IMAGE_QUICK_TOOLS_STORAGE_KEY, buildImageToolbarTools, defaultImageQuickToolIds, imageToolDefinitions, normalizeImageQuickToolIds, readImageQuickToolsConfig, type ImageToolHandlers } from "@/components/canvas/canvas-image-toolbar-tools";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import en from "@/i18n/locales/en-US";
import zh from "@/i18n/locales/zh-CN";

const dataUrl = "data:image/png;base64,AAAA";
const savedAt = 1792200000000;

function imageNode(overrides: Partial<CanvasNodeData> = {}): CanvasNodeData {
    return {
        id: "image-1",
        type: "image",
        title: "Hero",
        position: { x: 0, y: 0 },
        width: 320,
        height: 200,
        metadata: { content: "data:image/png;base64,OLD", storageKey: "image:old", status: "success", naturalWidth: 320, naturalHeight: 200 },
        ...overrides,
    } as CanvasNodeData;
}

describe("the PS-edit entry lives on the image node toolbar", () => {
    test("the tool definition exists, is visible by default, and its copy comes from i18n", () => {
        const tool = imageToolDefinitions.find((item) => item.id === "psEdit");
        expect(tool).toBeDefined();
        expect(tool?.defaultVisible).toBe(true);
        expect(tool?.label({} as CanvasNodeData)).toBe(zh.canvas.imageTools.psEdit);
    });

    test("the default quick tools include psEdit (so the bumped key shows it immediately)", () => {
        expect(defaultImageQuickToolIds).toContain("psEdit");
        expect(IMAGE_QUICK_TOOLS_STORAGE_KEY).toBe("canvas-image-quick-tools-v8");
    });

    test("clicking psEdit calls onPsEdit and leaves every other handler alone", () => {
        const calls: string[] = [];
        const handlers = {
            onUpload: () => calls.push("upload"),
            onToggleFreeResize: () => calls.push("resize"),
            onMaskEdit: () => calls.push("mask"),
            onPsEdit: () => calls.push("psEdit"),
            onCrop: () => calls.push("crop"),
            onSplit: () => calls.push("split"),
            onUpscale: () => calls.push("upscale"),
            onSuperResolve: () => calls.push("superResolve"),
            onAngle: () => calls.push("angle"),
            onViewImage: () => calls.push("view"),
            onCopyPrompt: () => calls.push("copyPrompt"),
            onReversePrompt: () => calls.push("reversePrompt"),
        } satisfies ImageToolHandlers;
        const node = imageNode();

        const tool = buildImageToolbarTools(node, handlers).find((item) => item.id === "psEdit");
        expect(tool?.title).toBe(zh.canvas.imageTools.psEditTitle);
        tool?.onClick();

        expect(calls).toEqual(["psEdit"]);
    });
});

describe("quick-tools config versus a freshly added tool", () => {
    test("a stored list is filtered by known ids (so a new tool needs a new storage key)", () => {
        expect(normalizeImageQuickToolIds(["info", "psEdit", "unknown"])).toEqual(["info", "psEdit"]);
        // v7 时代的列表没有 psEdit：过滤后不会有它 —— 这就是 bump 到 v8 的原因。
        expect(normalizeImageQuickToolIds(["info", "download"])).not.toContain("psEdit");
    });

    test("a missing config falls back to the defaults, psEdit included", () => {
        expect(readImageQuickToolsConfig(null).ids).toContain("psEdit");
        expect(readImageQuickToolsConfig({ quit: true }).ids).toEqual(defaultImageQuickToolIds);
    });
});

describe("a save writes back to the same node", () => {
    test("keeps the id and type, creates no node, and never mutates its input array", () => {
        const before = [imageNode(), imageNode({ id: "image-2" })];
        const snapshot = JSON.stringify(before);

        const after = applyPsEditSave(before, "image-1", dataUrl, savedAt);

        expect(after).toHaveLength(2);
        expect(after[0]?.id).toBe("image-1");
        expect(after[0]?.type).toBe(CanvasNodeType.Image);
        expect(after[0]?.title).toBe("Hero");
        expect(after[0]?.position).toEqual({ x: 0, y: 0 });
        expect(after[1]).toBe(before[1]);
        expect(JSON.stringify(before)).toBe(snapshot);
    });

    test("replaces the content and leaves a ps-edit record behind", () => {
        const metadata = buildPsEditMetadata(imageNode().metadata, dataUrl, savedAt);

        expect(metadata.content).toBe(dataUrl);
        expect(metadata.history).toHaveLength(1);
        expect(metadata.history?.[0]?.kind).toBe("ps-edit");
        expect(metadata.history?.[0]?.at).toBe(savedAt);
    });

    test("keeps an existing regions layer and appends to the history instead of replacing it", () => {
        const regions = { source: "image:old", width: 320, height: 200, items: [{ id: "r1", text: "Heading", bbox: { x: 1, y: 2, width: 3, height: 4 } }] };
        const metadata = buildPsEditMetadata({ ...imageNode().metadata, regions, history: [{ kind: "region-edit", at: savedAt - 1000 }] }, dataUrl, savedAt);

        // Structure survives the save; only its parse timestamp is bumped to the save time.
        expect(metadata.regions).toEqual({ ...regions, parsedAt: savedAt });
        expect(metadata.regions?.items).toEqual(regions.items);
        expect(metadata.history?.map((record) => record.kind)).toEqual(["region-edit", "ps-edit"]);
    });

    test("a fresh storage handle overrides the base64 blob to keep project data small", () => {
        const fresh = { content: "blob:edited", storageKey: "image:edited", naturalWidth: 800, naturalHeight: 600, bytes: 1234, mimeType: "image/png", status: "success" };
        const metadata = buildPsEditMetadata(imageNode().metadata, dataUrl, savedAt, fresh);

        expect(metadata.content).toBe("blob:edited");
        expect(metadata.storageKey).toBe("image:edited");
        expect(metadata.naturalWidth).toBe(800);
    });

    test("a batch image node mirrors the write into its primary entry", () => {
        const images = [
            { id: "a", content: "old-a", storageKey: "image:a" },
            { id: "b", content: "old-b", storageKey: "image:b" },
        ];
        const metadata = buildPsEditMetadata({ ...imageNode().metadata, images, primaryImageId: "a" }, dataUrl, savedAt);

        expect(metadata.images?.[0]?.content).toBe(dataUrl);
        expect(metadata.images?.[1]?.content).toBe("old-b");
    });
});

describe("both locales expose the same keys", () => {
    test("psEdit and psEditTitle exist and are non-empty in zh and en", () => {
        for (const locale of [zh, en]) {
            expect(locale.canvas.imageTools.psEdit.length).toBeGreaterThan(0);
            expect(locale.canvas.imageTools.psEditTitle.length).toBeGreaterThan(0);
        }
        expect(Object.keys(zh.canvas.imageTools).sort()).toEqual(Object.keys(en.canvas.imageTools).sort());
    });
});

// "Save as a new node" is the explicit alternative to save-back: the exported bitmap becomes its OWN
// image node next to the source, and the source node keeps its pixels.
describe("save as a new image node", () => {
    test("the copy lands to the right of its source on the same row", () => {
        const node = imageNode({ position: { x: 100, y: 40 }, width: 320 });
        expect(psSaveAsNodePosition(node)).toEqual({ x: 100 + 320 + PS_SAVE_AS_NODE_GAP_PX, y: 40 });
    });

    test("placing the copy leaves the source node untouched", () => {
        const node = imageNode({ position: { x: 10, y: 20 }, width: 200 });
        const before = JSON.parse(JSON.stringify(node));
        psSaveAsNodePosition(node);
        expect(node).toEqual(before);
    });

    test("the copy keeps the fresh artifact handle and stamps the PS engine", () => {
        const fresh = { content: "blob:new", storageKey: "image:new", status: "success" as const, naturalWidth: 512, naturalHeight: 256, bytes: 2048, mimeType: "image/png" };
        const metadata = buildPsSaveAsNodeMetadata(fresh, savedAt);

        expect(metadata.content).toBe("blob:new");
        expect(metadata.storageKey).toBe("image:new");
        expect(metadata.naturalWidth).toBe(512);
        expect(metadata.editor?.engine).toBe("miniPaint");
        expect(metadata.editor?.lastSavedAt).toBe(savedAt);
    });

    test("the copy carries no edit history: it is created, not edited", () => {
        const metadata = buildPsSaveAsNodeMetadata({ content: "blob:new" }, savedAt);
        expect(metadata.history).toBeUndefined();
    });
});
