import type { ReactNode } from "react";
import { Brush, Camera, Copy, FileText, Grid2x2, Lock, LockOpen, Maximize2, Palette, Scissors, Sparkles, Upload, ZoomIn } from "lucide-react";

import type { CanvasNodeData } from "@/types/canvas";
import i18n from "@/i18n";

export type ImageNodeActionToolId = "copyPrompt" | "reversePrompt" | "replace" | "resize" | "maskEdit" | "crop" | "split" | "upscale" | "superResolve" | "angle" | "view" | "psEdit";
export type ImageQuickToolId = "info" | "delete" | "saveAsset" | "download" | ImageNodeActionToolId;

export type ImageToolHandlers = {
    onUpload: (node: CanvasNodeData) => void;
    onToggleFreeResize: (node: CanvasNodeData) => void;
    onMaskEdit: (node: CanvasNodeData) => void;
    // Opens the embedded PS editor on *this* image; saving writes back to the same node (no new node).
    onPsEdit: (node: CanvasNodeData) => void;
    onCrop: (node: CanvasNodeData) => void;
    onSplit: (node: CanvasNodeData) => void;
    onUpscale: (node: CanvasNodeData) => void;
    onSuperResolve: (node: CanvasNodeData) => void;
    onAngle: (node: CanvasNodeData) => void;
    onViewImage: (node: CanvasNodeData) => void;
    onCopyPrompt: (node: CanvasNodeData) => void;
    onReversePrompt: (node: CanvasNodeData) => void;
};

export type ImageToolDefinition = {
    id: ImageNodeActionToolId;
    defaultVisible: boolean;
    label: string | ((node: CanvasNodeData) => string);
    title: string | ((node: CanvasNodeData) => string);
    icon: (node: CanvasNodeData) => ReactNode;
    active?: (node: CanvasNodeData) => boolean;
    run: (node: CanvasNodeData, handlers: ImageToolHandlers) => void;
};

export type ImageQuickToolsConfig = {
    ids: ImageQuickToolId[];
    showLabels: boolean;
};

// Bumped from v7 when "psEdit" was added: stored lists are filtered against the known ids and are not
// merged back with the defaults, so a v7 list would hide the new tool forever. Reading a fresh key
// falls back to `defaultImageQuickToolIds`, which includes psEdit; the cost is that a user's custom
// toolbar order/visibility resets once (a merge would instead re-enable tools they deliberately hid).
export const IMAGE_QUICK_TOOLS_STORAGE_KEY = "canvas-image-quick-tools-v8";

const defaultBaseToolIds: ImageQuickToolId[] = ["info", "delete", "saveAsset", "download"];

export const imageToolDefinitions: ImageToolDefinition[] = [
    {
        id: "copyPrompt",
        defaultVisible: true,
        label: () => i18n.t("canvas.imageTools.copyPrompt"),
        title: () => i18n.t("canvas.imageTools.copyPromptTitle"),
        icon: () => <Copy className="size-4" />,
        run: (node, handlers) => handlers.onCopyPrompt(node),
    },
    {
        id: "reversePrompt",
        defaultVisible: true,
        label: () => i18n.t("canvas.imageTools.reversePrompt"),
        title: () => i18n.t("canvas.imageTools.reversePromptTitle"),
        icon: () => <FileText className="size-4" />,
        run: (node, handlers) => handlers.onReversePrompt(node),
    },
    {
        id: "replace",
        defaultVisible: true,
        label: () => i18n.t("canvas.imageTools.replace"),
        title: () => i18n.t("canvas.imageTools.replace"),
        icon: () => <Upload className="size-4" />,
        run: (node, handlers) => handlers.onUpload(node),
    },
    {
        id: "resize",
        defaultVisible: false,
        label: (node) => i18n.t(node.metadata?.freeResize ? "canvas.imageTools.free" : "canvas.imageTools.locked"),
        title: (node) => i18n.t(node.metadata?.freeResize ? "canvas.imageTools.lockTitle" : "canvas.imageTools.freeTitle"),
        icon: (node) => (node.metadata?.freeResize ? <LockOpen className="size-4" /> : <Lock className="size-4" />),
        active: (node) => Boolean(node.metadata?.freeResize),
        run: (node, handlers) => handlers.onToggleFreeResize(node),
    },
    {
        id: "maskEdit",
        defaultVisible: true,
        label: () => i18n.t("canvas.imageTools.mask"),
        title: () => i18n.t("canvas.imageTools.maskTitle"),
        icon: () => <Brush className="size-4" />,
        run: (node, handlers) => handlers.onMaskEdit(node),
    },
    {
        id: "psEdit",
        defaultVisible: true,
        label: () => i18n.t("canvas.imageTools.psEdit"),
        title: () => i18n.t("canvas.imageTools.psEditTitle"),
        icon: () => <Palette className="size-4" />,
        run: (node, handlers) => handlers.onPsEdit(node),
    },
    {
        id: "crop",
        defaultVisible: true,
        label: () => i18n.t("canvas.imageTools.crop"),
        title: () => i18n.t("canvas.imageTools.cropTitle"),
        icon: () => <Scissors className="size-4" />,
        run: (node, handlers) => handlers.onCrop(node),
    },
    {
        id: "split",
        defaultVisible: true,
        label: () => i18n.t("canvas.imageTools.split"),
        title: () => i18n.t("canvas.imageTools.splitTitle"),
        icon: () => <Grid2x2 className="size-4" />,
        run: (node, handlers) => handlers.onSplit(node),
    },
    {
        id: "upscale",
        defaultVisible: true,
        label: () => i18n.t("canvas.imageTools.upscale"),
        title: () => i18n.t("canvas.imageTools.upscaleTitle"),
        icon: () => <ZoomIn className="size-4" />,
        run: (node, handlers) => handlers.onUpscale(node),
    },
    {
        id: "superResolve",
        defaultVisible: false,
        label: () => i18n.t("canvas.imageTools.superResolve"),
        title: () => i18n.t("canvas.imageTools.superResolveTitle"),
        icon: () => <Sparkles className="size-4" />,
        run: (node, handlers) => handlers.onSuperResolve(node),
    },
    {
        id: "angle",
        defaultVisible: false,
        label: () => i18n.t("canvas.imageTools.angle"),
        title: () => i18n.t("canvas.imageTools.angleTitle"),
        icon: () => <Camera className="size-4" />,
        run: (node, handlers) => handlers.onAngle(node),
    },
    {
        id: "view",
        defaultVisible: true,
        label: () => i18n.t("canvas.imageTools.view"),
        title: () => i18n.t("canvas.imageTools.viewTitle"),
        icon: () => <Maximize2 className="size-4" />,
        run: (node, handlers) => handlers.onViewImage(node),
    },
];

export const defaultImageQuickToolIds: ImageQuickToolId[] = [...defaultBaseToolIds, ...imageToolDefinitions.filter((tool) => tool.defaultVisible).map((tool) => tool.id)];

export function buildImageToolbarTools(node: CanvasNodeData, handlers: ImageToolHandlers) {
    return imageToolDefinitions.map((tool) => ({
        id: tool.id,
        label: resolveToolText(tool.label, node),
        title: resolveToolText(tool.title, node),
        icon: tool.icon(node),
        active: tool.active?.(node),
        onClick: () => tool.run(node, handlers),
    }));
}

export function normalizeImageQuickToolIds(value: unknown[]) {
    const allIds: ImageQuickToolId[] = [...defaultBaseToolIds, ...imageToolDefinitions.map((tool) => tool.id)];
    const ids = new Set(allIds);
    return allIds.filter((id) => value.includes(id) && ids.has(id));
}

export function readImageQuickToolsConfig(value: unknown): ImageQuickToolsConfig {
    if (Array.isArray(value)) return { ids: normalizeImageQuickToolIds(value), showLabels: false };
    if (!value || typeof value !== "object") return { ids: defaultImageQuickToolIds, showLabels: false };
    const data = value as Partial<ImageQuickToolsConfig>;
    return {
        ids: Array.isArray(data.ids) ? normalizeImageQuickToolIds(data.ids) : defaultImageQuickToolIds,
        showLabels: data.showLabels === true,
    };
}

function resolveToolText(value: string | ((node: CanvasNodeData) => string), node: CanvasNodeData) {
    return typeof value === "function" ? value(node) : value;
}
