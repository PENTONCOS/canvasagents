// M6: pure helpers for the node stage badge. Each stage has a distinct color and an i18n key
// under canvas.stage.*; unknown values are dropped so a stale canvas renders without a badge.
import type { CanvasNodeStage } from "@/types/canvas";

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
