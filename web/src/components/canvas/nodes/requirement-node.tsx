// A4: 需求便签。一句话需求独立成节点，可以并排摆多条。
// 与 Text 节点的区别：有固定的「需求 #N」标签、琥珀色侧条，正文只允许一句话，
// 新建后直接进入编辑态并聚焦，回车或失焦保存（走 onBlur 这一条真实提交路径）。
import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardList, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { REQUIREMENT_NODE_TYPE, normalizeRequirementDraft, requirementContent, requirementOrdinal } from "@/lib/canvas/requirement-node-utils";
import type { CanvasNodeContext, CanvasNodeDefinition } from "@/types/canvas-plugin";

function RequirementView({ ctx }: { ctx: CanvasNodeContext }) {
    const { t } = useTranslation();
    const content = requirementContent(ctx.node);
    // 空白便签（刚创建）直接进入编辑态：新建后不需要再点一下才能写字。
    const [editing, setEditing] = useState(() => !content.trim());
    const [draft, setDraft] = useState(content);
    const inputRef = useRef<HTMLInputElement>(null);
    // Esc 取消时不要把草稿写回去：失焦提交与取消共用 onBlur，用这个标记区分。
    const cancelRef = useRef(false);
    const ordinal = requirementOrdinal(ctx.getNodes(), ctx.node.id);

    // 非编辑态跟随节点数据，Agent 或其他窗口写入后立刻可见。
    useEffect(() => {
        if (!editing) setDraft(content);
    }, [content, editing]);

    useEffect(() => {
        if (!editing) return;
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }, [editing]);

    const commit = useCallback(() => {
        const next = normalizeRequirementDraft(draft);
        setEditing(false);
        if (next !== content) ctx.updateMetadata({ content: next });
    }, [content, ctx, draft]);

    const cancel = useCallback(() => {
        cancelRef.current = true;
        setDraft(content);
        setEditing(false);
    }, [content]);

    const startEditing = useCallback(() => {
        cancelRef.current = false;
        setDraft(content);
        setEditing(true);
    }, [content]);

    const controlClass = "flex h-6 items-center gap-1 rounded border border-stone-300 bg-white/80 px-1.5 text-[10px] font-medium text-stone-600 shadow-sm transition hover:bg-white dark:border-stone-700 dark:bg-stone-900/80 dark:text-stone-300 dark:hover:bg-stone-900";

    return (
        <div className="flex h-full w-full flex-col overflow-hidden" style={{ color: ctx.theme.node.text, borderLeft: "3px solid #f59e0b" }} data-requirement-note data-requirement-index={ordinal || undefined}>
            <div className="flex shrink-0 items-center justify-between gap-2 border-b px-2 py-1" style={{ borderColor: ctx.theme.node.stroke }}>
                <span className="flex min-w-0 items-center gap-1 text-[10px]" style={{ color: ctx.theme.node.muted }}>
                    <ClipboardList className="size-3 shrink-0" style={{ color: "#f59e0b" }} />
                    <span className="shrink-0 truncate rounded px-1 py-0.5 font-medium" style={{ background: "#f59e0b22", color: "#b45309" }} data-requirement-tag>
                        {ordinal ? t("canvas.requirement.tag", { index: ordinal }) : t("canvas.requirement.label")}
                    </span>
                </span>
                {!editing ? (
                    <div className="flex shrink-0 items-center gap-1" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
                        <button type="button" className={controlClass} onClick={startEditing} onPointerDown={(event) => event.stopPropagation()} data-requirement-edit>
                            <Pencil className="size-3" />
                            {t("canvas.requirement.edit")}
                        </button>
                    </div>
                ) : null}
            </div>

            {editing ? (
                <div className="flex min-h-0 flex-1 flex-col justify-center px-3">
                    <input
                        ref={inputRef}
                        value={draft}
                        spellCheck={false}
                        placeholder={t("canvas.requirement.placeholder")}
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={() => {
                            if (cancelRef.current) {
                                cancelRef.current = false;
                                return;
                            }
                            commit();
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") {
                                event.stopPropagation();
                                cancel();
                                return;
                            }
                            // 单行需求：回车走失焦，提交路径与鼠标点走开保持一致。
                            if (event.key === "Enter") {
                                event.preventDefault();
                                event.currentTarget.blur();
                            }
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        className="w-full border-none bg-transparent text-sm leading-6 outline-none select-text"
                        style={{ color: ctx.theme.node.text }}
                        data-requirement-input
                    />
                    <span className="mt-1 text-[10px]" style={{ color: ctx.theme.node.muted }}>
                        {t("canvas.requirement.editHint")}
                    </span>
                </div>
            ) : content.trim() ? (
                <div
                    className="flex min-h-0 flex-1 cursor-text items-center px-3 text-sm leading-6 select-text"
                    onDoubleClick={(event) => {
                        event.stopPropagation();
                        startEditing();
                    }}
                    title={t("canvas.requirement.doubleClickHint")}
                    data-requirement-text
                >
                    <span className="thin-scrollbar line-clamp-2 overflow-y-auto break-words">{content}</span>
                </div>
            ) : (
                <button
                    type="button"
                    className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-3 text-center"
                    onClick={startEditing}
                    onPointerDown={(event) => event.stopPropagation()}
                    data-requirement-empty
                >
                    <Pencil className="size-4 opacity-50" />
                    <span className="text-xs font-medium">{t("canvas.requirement.emptyTitle")}</span>
                    <span className="text-[11px] leading-4 opacity-70">{t("canvas.requirement.emptyHint")}</span>
                </button>
            )}
        </div>
    );
}

export function requirementNodeDefinition(): CanvasNodeDefinition {
    return {
        type: REQUIREMENT_NODE_TYPE,
        title: i18n.t("canvas.nodeTypes.requirement"),
        icon: <ClipboardList className="size-4" />,
        description: i18n.t("canvas.requirement.description"),
        minimapColor: "#f59e0b",
        defaultSize: { width: 340, height: 120 },
        defaultMetadata: { status: "idle", content: "" },
        // 正文就是资源本体：框选投喂时按文本交给 Agent。
        resource: (node) => {
            const text = requirementContent(node);
            return text.trim() ? { kind: "text", text } : null;
        },
        // 编辑全在节点内完成，不弹下方面板。
        hidePanel: true,
        Content: ({ ctx }) => <RequirementView ctx={ctx} />,
    };
}

let registered = false;
export function registerRequirementNode() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions([requirementNodeDefinition()], "builtin");
}
