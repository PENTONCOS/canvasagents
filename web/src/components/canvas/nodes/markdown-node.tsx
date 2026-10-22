// A1: Markdown 节点。正文写在 metadata.content（与 Text 节点同一字段），
// 因此刷新后随画布持久化，Agent 快照（canvas_get_state 预览 / canvas_get_node 全文）也能读到。
// 渲染用项目已有的 streamdown（Agent 会话同款），标题/列表/代码块都由它负责，
// 这里只补画布内的编辑态、空状态和计数状态栏。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Pencil } from "lucide-react";
import { Streamdown } from "streamdown";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { MARKDOWN_NODE_TYPE, isMarkdownBlank, markdownDocStats } from "@/lib/canvas/markdown-node-utils";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import type { CanvasNodeContext, CanvasNodeDefinition } from "@/types/canvas-plugin";

function MarkdownView({ ctx }: { ctx: CanvasNodeContext }) {
    const { t } = useTranslation();
    const content = typeof ctx.node.metadata?.content === "string" ? ctx.node.metadata.content : "";
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(content);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const blank = isMarkdownBlank(editing ? draft : content);
    const stats = useMemo(() => markdownDocStats(editing ? draft : content), [content, draft, editing]);

    // 非编辑态始终跟随节点数据（Agent / 其他窗口写入后立刻可见）。
    useEffect(() => {
        if (!editing) setDraft(content);
    }, [content, editing]);

    useEffect(() => {
        if (!editing) return;
        const textarea = textareaRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    }, [editing]);

    const commit = useCallback(() => {
        setEditing(false);
        if (draft !== content) ctx.updateMetadata({ content: draft });
    }, [content, ctx, draft]);

    const cancel = useCallback(() => {
        setDraft(content);
        setEditing(false);
    }, [content]);

    const controlClass = "flex h-6 items-center gap-1 rounded border border-stone-300 bg-white/80 px-1.5 text-[10px] font-medium text-stone-600 shadow-sm transition hover:bg-white dark:border-stone-700 dark:bg-stone-900/80 dark:text-stone-300 dark:hover:bg-stone-900";

    return (
        <div className="flex h-full w-full flex-col overflow-hidden" style={{ color: ctx.theme.node.text }}>
            <div className="flex shrink-0 items-center justify-between gap-2 border-b px-2 py-1" style={{ borderColor: ctx.theme.node.stroke }}>
                <span className="flex min-w-0 items-center gap-1 text-[10px]" style={{ color: ctx.theme.node.muted }}>
                    <FileText className="size-3 shrink-0" />
                    <span className="truncate">{t("canvas.markdown.label")}</span>
                </span>
                <div className="flex shrink-0 items-center gap-1" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
                    {editing ? (
                        <>
                            <button type="button" className={controlClass} onClick={cancel} onPointerDown={(event) => event.stopPropagation()}>
                                {t("canvas.markdown.cancel")}
                            </button>
                            <button type="button" className={controlClass} style={{ borderColor: "#2f80ff", color: "#2f80ff" }} onClick={commit} onPointerDown={(event) => event.stopPropagation()}>
                                {t("canvas.markdown.done")}
                            </button>
                        </>
                    ) : (
                        <>
                            <span className="text-[10px] tabular-nums" style={{ color: ctx.theme.node.muted }}>
                                {t("canvas.markdown.statLine", { lines: stats.lines, characters: stats.characters })}
                            </span>
                            <button type="button" className={controlClass} onClick={() => setEditing(true)} onPointerDown={(event) => event.stopPropagation()} data-markdown-edit>
                                <Pencil className="size-3" />
                                {t("canvas.markdown.edit")}
                            </button>
                        </>
                    )}
                </div>
            </div>

            {editing ? (
                <div className="flex min-h-0 flex-1 flex-col">
                    <textarea
                        ref={textareaRef}
                        value={draft}
                        spellCheck={false}
                        placeholder={t("canvas.markdown.placeholder")}
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={commit}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") {
                                event.stopPropagation();
                                cancel();
                            }
                            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                                event.preventDefault();
                                commit();
                            }
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        onWheel={(event) => event.stopPropagation()}
                        className="thin-scrollbar min-h-0 flex-1 resize-none whitespace-pre-wrap break-words border-none bg-transparent p-3 font-mono text-xs leading-5 outline-none select-text"
                        style={{ color: ctx.theme.node.text }}
                        data-markdown-textarea
                    />
                    <div className="shrink-0 border-t px-3 py-1 text-[10px]" style={{ borderColor: ctx.theme.node.stroke, color: ctx.theme.node.muted }}>
                        {t("canvas.markdown.editHint")}
                    </div>
                </div>
            ) : blank ? (
                <button
                    type="button"
                    className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 p-4 text-center"
                    onClick={() => setEditing(true)}
                    onPointerDown={(event) => event.stopPropagation()}
                    data-markdown-empty
                >
                    <Pencil className="size-5 opacity-50" />
                    <span className="text-xs font-medium">{t("canvas.markdown.emptyTitle")}</span>
                    <span className="max-w-[260px] text-[11px] leading-4 opacity-70">{t("canvas.markdown.emptyHint")}</span>
                </button>
            ) : (
                <div
                    className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-2 select-text"
                    onWheel={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => {
                        event.stopPropagation();
                        setEditing(true);
                    }}
                    title={t("canvas.markdown.doubleClickHint")}
                    data-markdown-preview
                >
                    <div className="agent-streamdown canvas-markdown text-xs leading-5">
                        <Streamdown mode="static" className="canvas-markdown-body" controls={{ code: { copy: false, download: false }, table: false, mermaid: false, image: false }} linkSafety={{ enabled: false }}>
                            {content}
                        </Streamdown>
                    </div>
                </div>
            )}
        </div>
    );
}

export function markdownNodeDefinition(): CanvasNodeDefinition {
    return {
        type: MARKDOWN_NODE_TYPE,
        title: i18n.t("canvas.nodeTypes.markdown"),
        icon: <FileText className="size-4" />,
        description: i18n.t("canvas.markdown.description"),
        minimapColor: "#14b8a6",
        defaultSize: { width: 420, height: 320 },
        defaultMetadata: { content: "" },
        // 正文就是资源本体：投喂/引用时按 text 处理，与其他文本节点一致。
        resource: (node) => {
            const content = typeof node.metadata?.content === "string" ? node.metadata.content : "";
            return content.trim() ? { kind: "text", text: content } : null;
        },
        // 编辑/预览都在节点内完成，不再弹下方面板。
        hidePanel: true,
        Content: ({ ctx }) => <MarkdownView ctx={ctx} />,
    };
}

let registered = false;
export function registerMarkdownNode() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions([markdownNodeDefinition()], "builtin");
}
