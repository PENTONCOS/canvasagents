import { useEffect } from "react";
import { AlertCircle, Loader2, Plus, X } from "lucide-react";
import { Button, Popconfirm, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { AgentPanelTabs } from "./agent-panel-tabs";
import { AGENT_WINDOW_LIMIT, toWindowTabLabel, type AgentWindowStatus } from "@/lib/agent/agent-windows";
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

    const active = windows.find((window) => window.id === activeWindowId) ?? windows[0];
    const atLimit = windows.length >= AGENT_WINDOW_LIMIT;

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

    return (
        <AgentPanelTabs
            value={activeWindowId}
            theme={theme}
            items={windows.map((window, index) => ({
                value: window.id,
                label: toWindowTabLabel(window, index),
                icon: statusIcon(window.status),
                count: window.unread || undefined,
            }))}
            onChange={(id) => selectWindow(id)}
            right={
                <>
                    <Tooltip title={atLimit ? t("agent.window.new") : t("agent.window.new")} placement="bottom">
                        <Button size="small" type="text" className="!h-8 !w-8 !min-w-8 !px-0" aria-label={t("agent.window.new")} disabled={atLimit} icon={<Plus className="size-3.5" />} onClick={() => addWindow()} />
                    </Tooltip>
                    {active.status === "running" ? (
                        <Popconfirm title={t("agent.window.closeConfirm")} okText={t("agent.window.close")} cancelText={t("common.cancel")} onConfirm={closeActive}>
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
    );
}
