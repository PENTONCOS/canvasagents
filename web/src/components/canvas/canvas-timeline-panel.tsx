// M3: stage timeline panel. A toggleable overlay (rendered on the canvas page, outside the node
// layer) that lists the pipeline stages horizontally, shows how many nodes each one holds, and lets
// the user focus a node through the canvas' existing selection mechanism.
import { useMemo } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { stageColor, stageLabelKey } from "@/lib/canvas/canvas-stage-utils";
import { buildStageTimeline, computeStageProgress, nextActionHint } from "@/lib/canvas/canvas-timeline-utils";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, CanvasNodeStage } from "@/types/canvas";

type CanvasTimelinePanelProps = {
    nodes: CanvasNodeData[];
    selectedNodeIds: Set<string>;
    onFocusNode: (nodeId: string) => void;
    onClose: () => void;
};

function stageLabel(stage: CanvasNodeStage, translate: (key: string) => string): string {
    const key = stageLabelKey(stage);
    return key ? translate(key) : stage;
}

export function CanvasTimelinePanel({ nodes, selectedNodeIds, onFocusNode, onClose }: CanvasTimelinePanelProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    const timeline = useMemo(() => buildStageTimeline(nodes), [nodes]);
    const progress = useMemo(() => computeStageProgress(timeline), [timeline]);
    const hint = useMemo(() => nextActionHint(timeline), [timeline]);
    const percent = Math.round(progress.completionRatio * 100);

    return (
        <div className="pointer-events-auto absolute left-1/2 top-20 z-[70] w-[min(880px,calc(100vw-2rem))] -translate-x-1/2" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} data-canvas-timeline-panel>
            <div className="overflow-hidden rounded-xl border shadow-2xl backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}>
                <div className="flex items-center gap-3 border-b px-3 py-2" style={{ borderColor: theme.toolbar.border }}>
                    <span className="text-sm font-semibold" style={{ color: theme.node.text }}>
                        {t("canvas.timeline.title")}
                    </span>
                    <span className="text-xs tabular-nums" style={{ color: theme.node.muted }}>
                        {t("canvas.timeline.progress", { filled: progress.filledCount, total: progress.total })}
                    </span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full" style={{ background: theme.node.fill }}>
                        <div className="h-full rounded-full transition-all" style={{ width: `${percent}%`, background: theme.node.activeStroke }} />
                    </div>
                    <span className="w-9 text-right text-xs tabular-nums" style={{ color: theme.node.muted }}>
                        {percent}%
                    </span>
                    <button type="button" className="grid size-6 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.muted }} onClick={onClose} aria-label={t("canvas.timeline.close")}>
                        <X className="size-3.5" />
                    </button>
                </div>

                <div className="flex gap-2 overflow-x-auto px-3 py-2.5">
                    {timeline.stages.map((entry) => {
                        const color = stageColor(entry.stage);
                        const empty = entry.count === 0;
                        return (
                            <div
                                key={entry.stage}
                                className="flex w-32 shrink-0 flex-col gap-1.5 rounded-lg border px-2 py-1.5"
                                style={{ borderColor: empty ? theme.toolbar.border : color, borderStyle: empty ? "dashed" : "solid", background: empty ? "transparent" : `${color}14` }}
                            >
                                <div className="flex items-center gap-1.5">
                                    <span className="size-2 shrink-0 rounded-full" style={{ background: color, opacity: empty ? 0.4 : 1 }} />
                                    <span className="truncate text-xs font-medium" style={{ color: theme.node.text }}>
                                        {stageLabel(entry.stage, t)}
                                    </span>
                                    <span className="ml-auto text-[11px] tabular-nums" style={{ color: theme.node.muted }}>
                                        {entry.count}
                                    </span>
                                </div>
                                {empty ? (
                                    <span className="text-[11px]" style={{ color: theme.node.faint }}>
                                        {t("canvas.timeline.todo")}
                                    </span>
                                ) : (
                                    <div className="flex flex-col gap-0.5">
                                        {entry.nodes.map((node) => {
                                            const selected = selectedNodeIds.has(node.id);
                                            return (
                                                <button
                                                    key={node.id}
                                                    type="button"
                                                    className="truncate rounded px-1 py-0.5 text-left text-[11px] transition"
                                                    style={{ color: theme.node.text, background: selected ? theme.toolbar.activeBg : "transparent" }}
                                                    title={node.title || t("canvas.node.untitled")}
                                                    onClick={() => onFocusNode(node.id)}
                                                >
                                                    {node.title || t("canvas.node.untitled")}
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                    {timeline.unassigned.length > 0 ? (
                        <div className="flex w-32 shrink-0 flex-col gap-1.5 rounded-lg border px-2 py-1.5" style={{ borderColor: theme.toolbar.border, borderStyle: "dotted" }}>
                            <div className="flex items-center gap-1.5">
                                <span className="size-2 shrink-0 rounded-full" style={{ background: theme.node.faint }} />
                                <span className="truncate text-xs font-medium" style={{ color: theme.node.muted }}>
                                    {t("canvas.timeline.unassigned")}
                                </span>
                                <span className="ml-auto text-[11px] tabular-nums" style={{ color: theme.node.muted }}>
                                    {timeline.unassigned.length}
                                </span>
                            </div>
                            <div className="flex flex-col gap-0.5">
                                {timeline.unassigned.map((node) => {
                                    const selected = selectedNodeIds.has(node.id);
                                    return (
                                        <button
                                            key={node.id}
                                            type="button"
                                            className="truncate rounded px-1 py-0.5 text-left text-[11px] transition"
                                            style={{ color: theme.node.muted, background: selected ? theme.toolbar.activeBg : "transparent" }}
                                            title={node.title || t("canvas.node.untitled")}
                                            onClick={() => onFocusNode(node.id)}
                                        >
                                            {node.title || t("canvas.node.untitled")}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    ) : null}
                </div>

                <div className="border-t px-3 py-1.5 text-xs" style={{ borderColor: theme.toolbar.border, color: theme.node.muted }}>
                    {hint ? t("canvas.timeline.next", { stage: stageLabel(hint.stage, t) }) : t("canvas.timeline.complete")}
                </div>
            </div>
        </div>
    );
}
