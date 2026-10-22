import { useEffect, useState } from "react";
import { AlertCircle, Clock, Loader2, Pencil, SquarePlus, X } from "lucide-react";
import { Button, Input, Modal, Popconfirm, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { AgentPanelTabs } from "./agent-panel-tabs";
import { AGENT_WINDOW_LIMIT, deriveWindowStatus, toWindowTabHint, toWindowTabLabel, type AgentWindowStatus } from "@/lib/agent/agent-windows";
import { canvasThemes } from "@/lib/canvas-theme";
import { useAgentStore } from "@/stores/use-agent-store";
import { useThemeStore } from "@/stores/use-theme-store";

function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

function statusIcon(status: AgentWindowStatus) {
    if (status === "running") return <Loader2 className="size-3.5 animate-spin" />;
    if (status === "queued") return <Clock className="size-3.5" />;
    if (status === "error") return <AlertCircle className="size-3.5 text-red-500" />;
    return null;
}

/** 会话窗切换条：切换 / 新建 / 关闭当前窗，并接管 ⌘1..9 与 ⌘T。 */
export function AgentWindowTabs() {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const windows = useAgentStore((state) => state.windows);
    const activeWindowId = useAgentStore((state) => state.activeWindowId);
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const addWindow = useAgentStore((state) => state.addWindow);
    const removeWindow = useAgentStore((state) => state.removeWindow);
    const selectWindow = useAgentStore((state) => state.selectWindow);
    const renameWindow = useAgentStore((state) => state.renameWindow);
    const [renaming, setRenaming] = useState(false);
    const [renameDraft, setRenameDraft] = useState("");

    const active = windows.find((window) => window.id === activeWindowId) ?? windows[0];
    const atLimit = windows.length >= AGENT_WINDOW_LIMIT;
    // 只剩一个窗时，关窗只会换成一个空白窗，看起来「点了没反应」，所以要先说清楚。
    const isLastWindow = windows.length <= 1;
    const newWindowLabel = atLimit ? t("agent.window.limit", { count: AGENT_WINDOW_LIMIT }) : t("agent.window.new");

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (!panelOpen) return;
            if (!event.metaKey && !event.ctrlKey) return;
            if (event.altKey || event.shiftKey) return;
            if (isEditableTarget(event.target)) return;
            const key = event.key.toLowerCase();
            if (key === "t") {
                event.preventDefault();
                addWindow();
                return;
            }
            if (key >= "1" && key <= "9") {
                const target = windows[Number(key) - 1];
                if (!target) return;
                event.preventDefault();
                selectWindow(target.id);
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [addWindow, panelOpen, selectWindow, windows]);

    if (!active) return null;

    const closeActive = () => removeWindow(active.id);
    const openRename = () => {
        // 改名只改标题本身，不要把「1:」这种序号前缀带进输入框。
        setRenameDraft(active.title?.trim() || toWindowTabLabel(active, windows.indexOf(active)));
        setRenaming(true);
    };
    const commitRename = () => {
        const next = renameDraft.trim();
        // 清空等于恢复默认标题（「会话 N」），不给 store 写空字符串。
        renameWindow(active.id, next);
        setRenaming(false);
    };

    return (
        <>
        <AgentPanelTabs
            variant="windows"
            label={t("agent.window.section")}
            value={activeWindowId}
            theme={theme}
            items={windows.map((window, index) => {
                // 状态以切片实时推导（status 字段只是快照，queued 标记不一定走到投影）。
                const status = deriveWindowStatus(window);
                const statusText = t(`agent.window.status.${status}`);
                // 只靠颜色/转圈分不出「在跑」与「排队」，悬停提示也必须能读出状态。
                const parts = [toWindowTabHint(window, index), statusText];
                if (window.unread) parts.push(t("agent.window.unread", { count: window.unread }));
                return {
                    value: window.id,
                    label: toWindowTabLabel(window, index),
                    icon: statusIcon(status),
                    dot: Boolean(window.unread),
                    hint: parts.join(" · "),
                    status,
                    // 空闲不往标签里加字：既有用例按 `会话 N` 精确匹配 tab 文案。
                    statusLabel: status === "idle" ? undefined : statusText,
                };
            })}
            onChange={(id) => selectWindow(id)}
            right={
                <>
                    <Tooltip title={t("agent.window.rename")} placement="bottom">
                        <Button size="small" type="text" className="!h-8 !w-8 !min-w-8 !px-0" aria-label={t("agent.window.rename")} style={{ color: theme.node.muted }} icon={<Pencil className="size-3.5" />} onClick={openRename} />
                    </Tooltip>
                    <Tooltip title={newWindowLabel} placement="bottom">
                        <Button size="small" type="text" className="!h-8 !w-8 !min-w-8 !px-0 @min-[560px]:!w-auto @min-[560px]:!min-w-0 @min-[560px]:!px-[7px]" aria-label={newWindowLabel} disabled={atLimit} icon={<SquarePlus className="size-3.5" />} onClick={() => addWindow()}>
                            <span className="hidden @min-[560px]:inline">{t("agent.window.newShort")}</span>
                        </Button>
                    </Tooltip>
                    {active.status === "running" ? (
                        <Popconfirm title={t("agent.window.closeConfirm")} okText={t("agent.window.close")} cancelText={t("common.cancel")} onConfirm={closeActive}>
                            <Button size="small" type="text" className="!h-8 !w-8 !min-w-8 !px-0" aria-label={t("agent.window.close")} style={{ color: theme.node.muted }} icon={<X className="size-3.5" />} />
                        </Popconfirm>
                    ) : isLastWindow ? (
                        <Popconfirm title={t("agent.window.closeLast")} okText={t("agent.window.close")} cancelText={t("common.cancel")} onConfirm={closeActive}>
                            <Button size="small" type="text" className="!h-8 !w-8 !min-w-8 !px-0" aria-label={t("agent.window.close")} style={{ color: theme.node.muted }} icon={<X className="size-3.5" />} />
                        </Popconfirm>
                    ) : (
                        <Tooltip title={t("agent.window.close")} placement="bottom">
                            <Button size="small" type="text" className="!h-8 !w-8 !min-w-8 !px-0" aria-label={t("agent.window.close")} style={{ color: theme.node.muted }} icon={<X className="size-3.5" />} onClick={closeActive} />
                        </Tooltip>
                    )}
                </>
            }
        />
        <Modal
            open={renaming}
            title={t("agent.window.renameTitle")}
            okText={t("common.save")}
            cancelText={t("common.cancel")}
            onOk={commitRename}
            onCancel={() => setRenaming(false)}
            destroyOnHidden
        >
            <Input
                autoFocus
                maxLength={24}
                value={renameDraft}
                placeholder={t("agent.window.renamePlaceholder")}
                onChange={(event) => setRenameDraft(event.target.value)}
                onPressEnter={commitRename}
            />
        </Modal>
        </>
    );
}
