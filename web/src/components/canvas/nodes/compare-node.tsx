// F3: 对照块节点（对齐参考产品的「现在的问题 ↔ 方案」红绿并排块）。
// 两侧正文分别写在 metadata.problems / metadata.solutions，按行拆条渲染；
// 编辑在节点内完成，不弹下方面板，行为与 Markdown 节点一致。
import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { ArrowLeftRight, Columns2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { COMPARE_NODE_TYPE, compareStats, splitCompareItems } from "@/lib/canvas/compare-node-utils";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import type { CanvasNodeContext, CanvasNodeDefinition } from "@/types/canvas-plugin";

const PROBLEM_TONE = { bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.45)", text: "#b91c1c" };
const SOLUTION_TONE = { bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.45)", text: "#047857" };

function CompareView({ ctx }: { ctx: CanvasNodeContext }) {
    const { t } = useTranslation();
    const problems = typeof ctx.node.metadata?.problems === "string" ? ctx.node.metadata.problems : "";
    const solutions = typeof ctx.node.metadata?.solutions === "string" ? ctx.node.metadata.solutions : "";
    const [editing, setEditing] = useState(false);
    const [draftProblems, setDraftProblems] = useState(problems);
    const [draftSolutions, setDraftSolutions] = useState(solutions);

    useEffect(() => {
        if (!editing) {
            setDraftProblems(problems);
            setDraftSolutions(solutions);
        }
    }, [editing, problems, solutions]);

    const stats = useMemo(() => compareStats(editing ? draftProblems : problems, editing ? draftSolutions : solutions), [draftProblems, draftSolutions, editing, problems, solutions]);
    const problemItems = useMemo(() => splitCompareItems(editing ? draftProblems : problems), [draftProblems, editing, problems]);
    const solutionItems = useMemo(() => splitCompareItems(editing ? draftSolutions : solutions), [draftSolutions, editing, solutions]);

    const commit = useCallback(() => {
        setEditing(false);
        const patch: { problems?: string; solutions?: string } = {};
        if (draftProblems !== problems) patch.problems = draftProblems;
        if (draftSolutions !== solutions) patch.solutions = draftSolutions;
        if (Object.keys(patch).length) ctx.updateMetadata(patch);
    }, [ctx, draftProblems, draftSolutions, problems, solutions]);

    const controlClass = "flex h-6 items-center gap-1 rounded border border-stone-300 bg-white/80 px-1.5 text-[10px] font-medium text-stone-600 shadow-sm transition hover:bg-white dark:border-stone-700 dark:bg-stone-900/80 dark:text-stone-300 dark:hover:bg-stone-900";
    const stop = (event: SyntheticEvent) => event.stopPropagation();

    return (
        <div className="flex h-full w-full flex-col overflow-hidden" style={{ color: ctx.theme.node.text }}>
            <div className="flex shrink-0 items-center justify-between gap-2 border-b px-2 py-1" style={{ borderColor: ctx.theme.node.stroke }}>
                <span className="flex min-w-0 items-center gap-1 text-[10px]" style={{ color: ctx.theme.node.muted }}>
                    <Columns2 className="size-3 shrink-0" />
                    <span className="truncate">{t("canvas.compare.label", { defaultValue: "对照" })}</span>
                    {stats.problems || stats.solutions ? (
                        <span className="tabular-nums" data-compare-stats>
                            {stats.problems} ↔ {stats.solutions}
                        </span>
                    ) : null}
                    {stats.problems && stats.solutions && !stats.balanced ? (
                        <span className="text-amber-600 dark:text-amber-400">{t("canvas.compare.unbalanced", { defaultValue: "没配平" })}</span>
                    ) : null}
                </span>
                <div className="flex shrink-0 items-center gap-1" onPointerDown={stop} onMouseDown={stop}>
                    {editing ? (
                        <>
                            <button type="button" className={controlClass} onClick={() => { setDraftProblems(problems); setDraftSolutions(solutions); setEditing(false); }}>
                                {t("canvas.compare.cancel", { defaultValue: "取消" })}
                            </button>
                            <button type="button" className={controlClass} onClick={commit}>
                                {t("canvas.compare.save", { defaultValue: "完成" })}
                            </button>
                        </>
                    ) : (
                        <button type="button" className={controlClass} onClick={() => setEditing(true)}>
                            {t("canvas.compare.edit", { defaultValue: "编辑" })}
                        </button>
                    )}
                </div>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-hidden p-2">
                <CompareColumn
                    tone={PROBLEM_TONE}
                    title={t("canvas.compare.problems", { defaultValue: "现在的问题" })}
                    items={problemItems}
                    editing={editing}
                    value={draftProblems}
                    onChange={setDraftProblems}
                />
                <CompareColumn
                    tone={SOLUTION_TONE}
                    title={t("canvas.compare.solutions", { defaultValue: "方案" })}
                    items={solutionItems}
                    editing={editing}
                    value={draftSolutions}
                    onChange={setDraftSolutions}
                />
            </div>
            {!editing ? (
                <div className="flex shrink-0 items-center gap-1 border-t px-2 py-1 text-[10px]" style={{ borderColor: ctx.theme.node.stroke, color: ctx.theme.node.muted }}>
                    <ArrowLeftRight className="size-3" />
                    {t("canvas.compare.hint", { defaultValue: "双击编辑，一行一条" })}
                </div>
            ) : null}
        </div>
    );
}

function CompareColumn({ tone, title, items, editing, value, onChange }: {
    tone: { bg: string; border: string; text: string };
    title: string;
    items: string[];
    editing: boolean;
    value: string;
    onChange: (next: string) => void;
}) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (editing) textareaRef.current?.focus();
    }, [editing]);

    return (
        <div className="flex min-h-0 min-w-0 flex-col rounded-md border" style={{ background: tone.bg, borderColor: tone.border }}>
            <div className="shrink-0 px-2 py-1 text-[10px] font-medium" style={{ color: tone.text }}>{title}</div>
            {editing ? (
                <textarea
                    ref={textareaRef}
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                    spellCheck={false}
                    className="thin-scrollbar min-h-0 flex-1 resize-none bg-transparent px-2 pb-2 text-xs leading-5 outline-none"
                    style={{ color: "inherit" }}
                />
            ) : (
                <ul className="thin-scrollbar min-h-0 flex-1 overflow-auto px-2 pb-2 text-xs leading-5">
                    {items.length ? items.map((item, index) => (
                        <li key={`${index}-${item}`} className="flex gap-1.5 py-0.5">
                            <span className="shrink-0 tabular-nums opacity-50">{index + 1}</span>
                            <span className="min-w-0 break-words">{item}</span>
                        </li>
                    )) : <li className="opacity-50">—</li>}
                </ul>
            )}
        </div>
    );
}

export function compareNodeDefinition(): CanvasNodeDefinition {
    return {
        type: COMPARE_NODE_TYPE,
        title: i18n.t("canvas.nodeTypes.compare"),
        icon: <Columns2 className="size-4" />,
        description: i18n.t("canvas.compare.description", { defaultValue: "左问题右方案的红绿并排对照块" }),
        minimapColor: "#ef4444",
        defaultSize: { width: 620, height: 320 },
        defaultMetadata: { status: "idle", problems: "", solutions: "" },
        // 两侧正文都算这个节点的文本资源，投喂/引用时按 text 处理。
        resource: (node) => {
            const text = [node.metadata?.problems, node.metadata?.solutions].filter((item): item is string => typeof item === "string" && item.trim().length > 0).join("\n");
            return text.trim() ? { kind: "text", text } : null;
        },
        hidePanel: true,
        Content: ({ ctx }) => <CompareView ctx={ctx} />,
    };
}

let registered = false;
export function registerCompareNode() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions([compareNodeDefinition()], "builtin");
}
