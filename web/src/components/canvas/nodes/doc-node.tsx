// F4: 分节文档节点（对齐参考产品的 Spec Doc：左边目录、右边一节一节往下排）。
// 正文写在 metadata.content（Markdown 子集：`#` / `##` 开新节），刷新后随画布持久化，
// Agent 快照与投喂也按 text 资源读得到。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, ListTree } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { DOC_NODE_TYPE, docSectionLabel, docStats, splitDocSections } from "@/lib/canvas/doc-node-utils";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import type { CanvasNodeContext, CanvasNodeDefinition } from "@/types/canvas-plugin";

function DocView({ ctx }: { ctx: CanvasNodeContext }) {
    const { t } = useTranslation();
    const content = typeof ctx.node.metadata?.content === "string" ? ctx.node.metadata.content : "";
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(content);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const scrollerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!editing) setDraft(content);
    }, [content, editing]);

    useEffect(() => {
        if (!editing) return;
        const textarea = textareaRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    }, [editing]);

    const sections = useMemo(() => splitDocSections(editing ? draft : content), [content, draft, editing]);
    const stats = useMemo(() => docStats(sections), [sections]);

    const commit = useCallback(() => {
        setEditing(false);
        if (draft !== content) ctx.updateMetadata({ content: draft });
    }, [content, ctx, draft]);

    const scrollToSection = (index: number) => {
        const el = scrollerRef.current?.querySelector<HTMLElement>(`[data-doc-section="${index}"]`);
        el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };

    const controlClass = "flex h-6 items-center gap-1 rounded border border-stone-300 bg-white/80 px-1.5 text-[10px] font-medium text-stone-600 shadow-sm transition hover:bg-white dark:border-stone-700 dark:bg-stone-900/80 dark:text-stone-300 dark:hover:bg-stone-900";

    return (
        <div className="flex h-full w-full flex-col overflow-hidden" style={{ color: ctx.theme.node.text }}>
            <div className="flex shrink-0 items-center justify-between gap-2 border-b px-2 py-1" style={{ borderColor: ctx.theme.node.stroke }}>
                <span className="flex min-w-0 items-center gap-1 text-[10px]" style={{ color: ctx.theme.node.muted }}>
                    <FileText className="size-3 shrink-0" />
                    <span className="truncate">{t("canvas.doc.label", { defaultValue: "文档" })}</span>
                    {stats.sections ? <span className="tabular-nums" data-doc-stats>{t("canvas.doc.stats", { sections: stats.sections, chars: stats.chars, defaultValue: "{{sections}} 节 · {{chars}} 字" })}</span> : null}
                </span>
                <div className="flex shrink-0 items-center gap-1" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
                    {editing ? (
                        <>
                            <button type="button" className={controlClass} onClick={() => { setDraft(content); setEditing(false); }}>{t("canvas.doc.cancel", { defaultValue: "取消" })}</button>
                            <button type="button" className={controlClass} onClick={commit}>{t("canvas.doc.save", { defaultValue: "完成" })}</button>
                        </>
                    ) : (
                        <button type="button" className={controlClass} onClick={() => setEditing(true)}>{t("canvas.doc.edit", { defaultValue: "编辑" })}</button>
                    )}
                </div>
            </div>

            {editing ? (
                <textarea
                    ref={textareaRef}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                    spellCheck={false}
                    placeholder={t("canvas.doc.placeholder", { defaultValue: "## 背景\n写背景…\n\n## 方案\n写方案…" })}
                    className="thin-scrollbar min-h-0 flex-1 resize-none bg-transparent px-3 py-2 text-xs leading-5 outline-none"
                />
            ) : sections.length ? (
                <div className="flex min-h-0 flex-1 overflow-hidden">
                    <div className="thin-scrollbar w-32 shrink-0 overflow-auto border-r px-2 py-2 text-[11px]" style={{ borderColor: ctx.theme.node.stroke }}>
                        <div className="mb-1 flex items-center gap-1" style={{ color: ctx.theme.node.muted }}>
                            <ListTree className="size-3" />
                            {t("canvas.doc.outline", { defaultValue: "目录" })}
                        </div>
                        {sections.map((section, index) => (
                            <button
                                key={section.id}
                                type="button"
                                onClick={() => scrollToSection(index)}
                                className="block w-full truncate rounded px-1 py-0.5 text-left transition hover:bg-black/5 dark:hover:bg-white/10"
                                style={{ color: section.title ? ctx.theme.node.text : ctx.theme.node.muted }}
                                title={docSectionLabel(section, index)}
                            >
                                {index + 1}. {docSectionLabel(section, index)}
                            </button>
                        ))}
                    </div>
                    <div ref={scrollerRef} className="thin-scrollbar min-h-0 flex-1 overflow-auto px-3 py-2">
                        {sections.map((section, index) => (
                            <section key={section.id} data-doc-section={index} className="mb-3 last:mb-0">
                                {section.title ? <h3 className="mb-1 text-sm font-semibold">{section.title}</h3> : null}
                                {section.body ? <p className="whitespace-pre-wrap break-words text-xs leading-5 opacity-90">{section.body}</p> : null}
                            </section>
                        ))}
                    </div>
                </div>
            ) : (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 text-center text-xs" style={{ color: ctx.theme.node.muted }}>
                    <p>{t("canvas.doc.empty", { defaultValue: "还没有内容" })}</p>
                    <button type="button" className={controlClass} onClick={() => setEditing(true)}>{t("canvas.doc.start", { defaultValue: "开始写" })}</button>
                </div>
            )}
        </div>
    );
}

export function docNodeDefinition(): CanvasNodeDefinition {
    return {
        type: DOC_NODE_TYPE,
        title: i18n.t("canvas.nodeTypes.doc"),
        icon: <FileText className="size-4" />,
        description: i18n.t("canvas.doc.description", { defaultValue: "带目录的分节文档（`##` 开新节）" }),
        minimapColor: "#0ea5e9",
        defaultSize: { width: 720, height: 420 },
        defaultMetadata: { status: "idle", content: "" },
        resource: (node) => {
            const content = typeof node.metadata?.content === "string" ? node.metadata.content : "";
            return content.trim() ? { kind: "text", text: content } : null;
        },
        hidePanel: true,
        Content: ({ ctx }) => <DocView ctx={ctx} />,
    };
}

let registered = false;
export function registerDocNode() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions([docNodeDefinition()], "builtin");
}
