// M3: pure helpers that turn a flat node list into a readable pipeline timeline. Nodes are bucketed
// by their metadata.stage (see canvas-stage-utils) while preserving the caller's input order, so the
// UI can render "requirement -> design -> code -> service -> test -> runtime" and highlight gaps.
import { CANVAS_NODE_HISTORY_LIMIT, normalizeNodeEditLimit, normalizeNodeHistory } from "@/lib/canvas/canvas-node-history";
import { CANVAS_NODE_STAGES, normalizeStage } from "@/lib/canvas/canvas-stage-utils";
import type { CanvasNodeEditKind, CanvasNodeStage } from "@/types/canvas";

// Minimal structural input: any canvas node carrying an id, an optional title, and an optional
// metadata.stage / metadata.history. CanvasNodeData satisfies this shape, and tests can build plain
// objects.
export type CanvasTimelineInputNode = {
    id: string;
    title?: string;
    metadata?: { stage?: unknown; history?: unknown };
};

// A node as it appears inside a timeline bucket. The stage is normalized, so a bucketed node always
// has one; `unassigned` entries keep the normalized value (undefined) for completeness.
export type CanvasTimelineNode = {
    id: string;
    title: string;
    stage: CanvasNodeStage | undefined;
};

export type CanvasTimelineStage = {
    stage: CanvasNodeStage;
    nodes: CanvasTimelineNode[];
    count: number;
};

export type CanvasTimeline = {
    stages: CanvasTimelineStage[];
    unassigned: CanvasTimelineNode[];
};

export type CanvasStageProgressEntry = {
    stage: CanvasNodeStage;
    count: number;
    filled: boolean;
};

export type CanvasStageProgress = {
    stages: CanvasStageProgressEntry[];
    filledCount: number;
    total: number;
    completionRatio: number;
};

export type CanvasNextActionHint = {
    stage: CanvasNodeStage;
};

function toTimelineNode(node: CanvasTimelineInputNode): CanvasTimelineNode {
    return {
        id: node.id,
        title: typeof node.title === "string" ? node.title : "",
        stage: normalizeStage(node.metadata?.stage),
    };
}

// Buckets nodes by stage while preserving the input order inside every bucket (stable by
// construction: iterate the source once and push). Nodes with an unknown/missing stage land in
// `unassigned`; a valid stage that is absent from stageOrder is treated as unassigned too.
export function buildStageTimeline(nodes: readonly CanvasTimelineInputNode[] = [], stageOrder: readonly CanvasNodeStage[] = CANVAS_NODE_STAGES): CanvasTimeline {
    const order = stageOrder.length > 0 ? stageOrder : CANVAS_NODE_STAGES;
    const buckets = new Map<CanvasNodeStage, CanvasTimelineNode[]>();
    for (const stage of order) buckets.set(stage, []);

    const unassigned: CanvasTimelineNode[] = [];
    for (const node of nodes) {
        if (!node || typeof node.id !== "string" || !node.id) continue;
        const entry = toTimelineNode(node);
        const bucket = entry.stage ? buckets.get(entry.stage) : undefined;
        if (bucket) bucket.push(entry);
        else unassigned.push(entry);
    }

    const stages = order.map((stage) => {
        const list = buckets.get(stage) ?? [];
        return { stage, nodes: list, count: list.length };
    });

    return { stages, unassigned };
}

// A stage counts as "filled" once it holds at least one node. The completion ratio is the share of
// filled stages over the total stage count; an empty timeline scores 0 (never NaN).
export function computeStageProgress(timeline: CanvasTimeline): CanvasStageProgress {
    const stages = timeline.stages.map((entry) => ({ stage: entry.stage, count: entry.count, filled: entry.count > 0 }));
    const total = stages.length;
    const filledCount = stages.filter((entry) => entry.filled).length;
    const completionRatio = total > 0 ? filledCount / total : 0;
    return { stages, filledCount, total, completionRatio };
}

// Points at the earliest stage that still has no nodes, or null when every stage is filled. The hint
// carries only the stage: a stage is empty by definition here, so a node count would always read 0,
// and the panel header already reports stage coverage.
export function nextActionHint(timeline: CanvasTimeline): CanvasNextActionHint | null {
    const empty = timeline.stages.find((entry) => entry.count === 0);
    if (!empty) return null;
    return { stage: empty.stage };
}

// Phase 3: one edit that happened to one node, flattened out of metadata.history for the timeline's
// activity list. `nodeId` is what the UI focuses when the row is clicked; `nodeTitle` falls back to
// the caller's untitled label. `stage` is the node's current normalized stage, kept for context.
export type CanvasNodeActivityEvent = {
    nodeId: string;
    nodeTitle: string;
    stage: CanvasNodeStage | undefined;
    kind: CanvasNodeEditKind;
    at: number;
    engine?: string;
    version?: string;
    summary?: string;
};

// How many activity rows the timeline keeps by default (newest first).
export const CANVAS_NODE_ACTIVITY_LIMIT = CANVAS_NODE_HISTORY_LIMIT;

// Flattens every node's metadata.history into a single event stream, newest first, so the timeline
// can show "this image was edited" independently of stage progress.
// Determinism: primary key is `at` descending; ties break on `nodeId` ascending; remaining ties keep
// the stream order (node order in the input, then record order inside a node) thanks to a stable
// sort. Dirty records (non-array history, missing/non-finite `at`, unknown `kind`) are dropped.
export function buildNodeActivity(nodes: readonly CanvasTimelineInputNode[] = [], limit: number = CANVAS_NODE_ACTIVITY_LIMIT): CanvasNodeActivityEvent[] {
    const max = normalizeNodeEditLimit(limit, CANVAS_NODE_ACTIVITY_LIMIT);
    if (max <= 0) return [];

    const events: CanvasNodeActivityEvent[] = [];
    for (const node of nodes) {
        if (!node || typeof node.id !== "string" || !node.id) continue;
        const nodeTitle = typeof node.title === "string" ? node.title : "";
        const stage = normalizeStage(node.metadata?.stage);
        for (const record of normalizeNodeHistory(node.metadata?.history)) {
            events.push({ nodeId: node.id, nodeTitle, stage, kind: record.kind, at: record.at, engine: record.engine, version: record.version, summary: record.summary });
        }
    }

    events.sort((left, right) => right.at - left.at || (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0));
    return events.slice(0, max);
}

// Deterministic Graphviz DOT export of the timeline. Stage ids are fixed and edges follow stage
// order, so the same timeline always yields byte-identical output.
export function timelineToDot(timeline: CanvasTimeline): string {
    const lines = ["digraph timeline {", '  rankdir="LR";'];
    for (const entry of timeline.stages) {
        lines.push(`  stage_${entry.stage} [label="${entry.stage} (${entry.count})"];`);
    }
    if (timeline.unassigned.length > 0) {
        lines.push(`  unassigned [label="unassigned (${timeline.unassigned.length})"];`);
    }
    for (let index = 1; index < timeline.stages.length; index += 1) {
        lines.push(`  stage_${timeline.stages[index - 1].stage} -> stage_${timeline.stages[index].stage};`);
    }
    lines.push("}");
    return lines.join("\n");
}
