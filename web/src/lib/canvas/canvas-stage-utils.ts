// M6: pure helpers for the node stage badge. Each stage has a distinct color and an i18n key
// under canvas.stage.*; unknown values are dropped so a stale canvas renders without a badge.
import type { CanvasNodeMetadata, CanvasNodeStage } from "@/types/canvas";

export const CANVAS_NODE_STAGES: CanvasNodeStage[] = ["requirement", "design", "code", "service", "test", "runtime"];

export const STAGE_COLOR: Record<CanvasNodeStage, string> = {
    requirement: "#f59e0b",
    design: "#8b5cf6",
    code: "#10b981",
    service: "#0ea5e9",
    test: "#ec4899",
    runtime: "#f97316",
};

export function normalizeStage(value: unknown): CanvasNodeStage | undefined {
    return typeof value === "string" && (CANVAS_NODE_STAGES as string[]).includes(value) ? (value as CanvasNodeStage) : undefined;
}

export function stageColor(stage: CanvasNodeStage): string {
    return STAGE_COLOR[stage];
}

export function stageLabelKey(stage: unknown): string | null {
    const normalized = normalizeStage(stage);
    return normalized ? `canvas.stage.${normalized}` : null;
}

// Assigning a stage by hand. Returns a fresh metadata object so callers can drop it straight into a
// node update; passing `undefined` removes the key entirely (no stray `stage: undefined` left on
// the node), which lands the node back in the timeline's "unassigned" bucket.
export function withNodeStage(metadata: CanvasNodeMetadata | undefined, stage: CanvasNodeStage | undefined): CanvasNodeMetadata {
    const next: CanvasNodeMetadata = { ...metadata };
    if (stage) next.stage = stage;
    else delete next.stage;
    return next;
}
