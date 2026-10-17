// Canvas Journal "operations" panel: a presentational, controlled overlay that lists the recorded
// operations and offers "jump back to this step". Everything it renders arrives as props (entries,
// the projected undo/redo timeline, node titles) and everything it reacts to leaves through props
// (onJump / onClose); it never touches a store. The index/reachability math is delegated to the pure
// helpers in lib/canvas/canvas-journal-steps so a row can be honest about whether its snapshot is
// still reachable: a step whose snapshot has fallen out of the retained window is labelled as a record
// only and cannot be clicked, and a redacted patch value renders as an object reference — a data URL
// is never placed in the DOM.
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { flattenJournalPatch, journalActorLabelKey, journalCommitId, journalEntryChangeCount, orderJournalForPanel, resolveJournalLocation, resolveJournalTarget, type CanvasHistoryTimeline } from "@/lib/canvas/canvas-journal-steps";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasJournalEntry } from "@/types/canvas";

type CanvasJournalPanelProps = {
    entries: CanvasJournalEntry[];
    timeline: CanvasHistoryTimeline;
    nodeTitles: Record<string, string>;
    onJump: (commitId: string) => void;
    onClose: () => void;
};

// Local clock as HH:mm:ss. Built by hand so the row time is stable regardless of the runtime locale.
function formatClock(at: number): string {
    const date = new Date(at);
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function CanvasJournalPanel({ entries, timeline, nodeTitles, onJump, onClose }: CanvasJournalPanelProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});

    // Newest first and capped; `hidden` is how many recorded operations are not rendered.
    const ordered = useMemo(() => orderJournalForPanel(entries), [entries]);

    const toggle = (id: string) => setExpanded((previous) => ({ ...previous, [id]: previous[id] !== true }));

    return (
        <div className="pointer-events-auto absolute left-5 top-20 z-[70] flex w-[min(440px,calc(100vw-2rem))] flex-col" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} data-canvas-journal-panel>
            <div className="flex max-h-[min(32rem,calc(100vh-8rem))] flex-col overflow-hidden rounded-xl border shadow-2xl backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}>
                <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: theme.toolbar.border }}>
                    <span className="text-sm font-semibold" style={{ color: theme.node.text }}>
                        {t("canvas.journal.panelTitle")}
                    </span>
                    <span className="truncate text-[11px]" style={{ color: theme.node.faint }}>
                        {t("canvas.journal.panelHint")}
                    </span>
                    <button
                        type="button"
                        className="ml-auto grid size-6 shrink-0 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10"
                        style={{ color: theme.node.muted }}
                        onClick={onClose}
                        aria-label={t("canvas.journal.panelTitle")}
                    >
                        <X className="size-3.5" />
                    </button>
                </div>

                {ordered.entries.length === 0 ? (
                    <div className="px-3 py-6 text-center text-xs" style={{ color: theme.node.faint }}>
                        {t("canvas.journal.panelEmpty")}
                    </div>
                ) : (
                    <div className="flex flex-col gap-1 overflow-y-auto px-2 py-2" data-canvas-journal-list>
                        {ordered.entries.map((entry) => {
                            const commitId = journalCommitId(entry);
                            const location = resolveJournalLocation(timeline, commitId);
                            const target = resolveJournalTarget(entry, nodeTitles, t("canvas.node.untitled"));
                            const changeCount = journalEntryChangeCount(entry);
                            const hasPatch = entry.patch !== undefined && entry.patch !== null;
                            const isOpen = hasPatch && expanded[entry.id] === true;
                            const patch = isOpen ? flattenJournalPatch(entry.patch) : null;
                            return (
                                <div key={entry.id} className="rounded-lg border px-2 py-1.5" style={{ borderColor: location.status === "current" ? theme.node.activeStroke : theme.toolbar.border }}>
                                    <div className="flex items-center gap-1.5 text-[11px]">
                                        <button
                                            type="button"
                                            className="grid size-4 shrink-0 place-items-center rounded transition disabled:opacity-30 hover:bg-black/5 dark:hover:bg-white/10"
                                            style={{ color: theme.node.muted }}
                                            onClick={() => toggle(entry.id)}
                                            disabled={!hasPatch}
                                            aria-label={entry.id}
                                            data-canvas-journal-toggle
                                        >
                                            {isOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                                        </button>
                                        <span className="shrink-0 tabular-nums" style={{ color: theme.node.muted }}>
                                            {formatClock(entry.at)}
                                        </span>
                                        <span className="shrink-0 rounded-full px-1.5 py-0.5" style={{ background: theme.toolbar.activeBg, color: theme.node.muted }} data-canvas-journal-actor>
                                            {t(journalActorLabelKey(entry.actor))}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate" style={{ color: theme.node.text }} title={t(entry.summary.key, { ...entry.summary.params })}>
                                            {t(entry.summary.key, { ...entry.summary.params })}
                                        </span>
                                    </div>
                                    <div className="mt-1 flex items-center gap-1.5 text-[11px]">
                                        <span className="min-w-0 flex-1 truncate" style={{ color: theme.node.faint }} title={target.label}>
                                            {target.label}
                                        </span>
                                        <span className="shrink-0 tabular-nums" style={{ color: theme.node.muted }}>
                                            {t("canvas.journal.panelChangeCount", { count: changeCount })}
                                        </span>
                                        {location.status === "current" ? (
                                            <span className="shrink-0 rounded-full px-1.5 py-0.5" style={{ background: theme.toolbar.activeBg, color: theme.toolbar.activeText }} data-canvas-journal-current>
                                                {t("canvas.journal.panelCurrent")}
                                            </span>
                                        ) : location.status === "out-of-window" ? (
                                            <span className="shrink-0" style={{ color: theme.node.faint }} data-canvas-journal-out-of-window>
                                                {t("canvas.journal.panelOutOfWindow")}
                                            </span>
                                        ) : (
                                            <button
                                                type="button"
                                                className="shrink-0 rounded-full px-1.5 py-0.5 transition hover:bg-black/5 dark:hover:bg-white/10"
                                                style={{ color: theme.toolbar.item }}
                                                onClick={() => {
                                                    if (commitId) onJump(commitId);
                                                }}
                                                data-canvas-journal-jump
                                            >
                                                {t("canvas.journal.panelJump")}
                                            </button>
                                        )}
                                    </div>
                                    {isOpen && patch ? (
                                        <div className="mt-1 flex flex-col gap-0.5 rounded border-t pt-1 text-[10px]" style={{ borderColor: theme.toolbar.border }} data-canvas-journal-patch>
                                            {patch.lines.map((line, index) => (
                                                <div key={`${line.path}:${index}`} className="flex items-baseline gap-1.5">
                                                    <span className="max-w-[45%] shrink-0 truncate" style={{ color: theme.node.muted }}>
                                                        {line.path}
                                                    </span>
                                                    {"ref" in line && line.ref ? (
                                                        <span className="min-w-0 flex-1 truncate" style={{ color: theme.node.faint }}>
                                                            {t("canvas.journal.panelLargeRef", { len: line.ref.len })}
                                                        </span>
                                                    ) : (
                                                        <span className="min-w-0 flex-1 truncate" style={{ color: theme.node.text }}>
                                                            {line.text}
                                                        </span>
                                                    )}
                                                </div>
                                            ))}
                                            {patch.truncated ? (
                                                <div className="truncate" style={{ color: theme.node.faint }}>
                                                    {t("canvas.journal.panelTruncated")}
                                                </div>
                                            ) : null}
                                        </div>
                                    ) : null}
                                </div>
                            );
                        })}
                    </div>
                )}

                {ordered.hidden > 0 ? (
                    <div className="border-t px-3 py-1.5 text-[11px]" style={{ borderColor: theme.toolbar.border, color: theme.node.faint }} data-canvas-journal-hidden>
                        {t("canvas.journal.panelHidden", { count: ordered.hidden })}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
