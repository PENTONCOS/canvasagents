import { ChevronRight, FolderTree, MessageSquare } from "lucide-react";
import { Dropdown, Tooltip } from "antd";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { toWindowTabLabel } from "@/lib/agent/agent-windows";

/**
 * I2 三层导航：项目 › 画布 › 会话。
 *
 * 三级都必须在画布页可见并且能跳，否则「项目层」只是列表页上的一行字：
 * 人在画布里干到一半想换画布，还得先退回列表。会话这一级点击就打开会话面板。
 */
export function CanvasProjectNav({ canvasId, canvasTitle, onOpenSessions }: { canvasId: string; canvasTitle: string; onOpenSessions: () => void }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const groups = useCanvasStore((state) => state.groups);
    const projects = useCanvasStore((state) => state.projects);
    const windows = useAgentStore((state) => state.windows);
    const activeWindowId = useAgentStore((state) => state.activeWindowId);

    const current = projects.find((project) => project.id === canvasId);
    const group = groups.find((item) => item.id === current?.groupId);
    const siblings = group ? projects.filter((project) => project.groupId === group.id) : current ? [current] : [];
    const activeIndex = windows.findIndex((window) => window.id === activeWindowId);
    const sessionLabel = activeIndex >= 0 ? toWindowTabLabel(windows[activeIndex], activeIndex) : t("canvas.nav.session");

    const enterProject = (groupId: string) => {
        const first = projects.find((project) => project.groupId === groupId);
        navigate(first ? `/canvas/${first.id}` : "/canvas");
    };
    const itemClass = "flex max-w-[14rem] items-center gap-1 truncate rounded px-1.5 py-0.5 transition hover:bg-black/5 dark:hover:bg-white/10";

    return (
        <nav
            data-testid="canvas-project-nav"
            className="flex items-center gap-1 border-b px-3 py-1 text-[11px]"
            style={{ borderColor: theme.toolbar.border, color: theme.node.text, background: theme.toolbar.panel }}
        >
            <FolderTree className="size-3.5 shrink-0 opacity-60" />
            <Dropdown
                trigger={["click"]}
                disabled={!groups.length}
                menu={{ items: groups.map((item) => ({ key: item.id, label: item.title })), onClick: ({ key }) => enterProject(key) }}
            >
                <button type="button" className={itemClass} aria-label={t("canvas.nav.switchProject")} title={t("canvas.nav.switchProject")}>
                    {group?.title || t("canvas.nav.projects")}
                </button>
            </Dropdown>
            <ChevronRight className="size-3 shrink-0 opacity-40" />
            <Dropdown
                trigger={["click"]}
                disabled={siblings.length < 2}
                menu={{ items: siblings.map((item) => ({ key: item.id, label: item.title })), onClick: ({ key }) => navigate(`/canvas/${key}`) }}
            >
                <button type="button" className={itemClass} aria-label={t("canvas.nav.switchCanvas")} title={t("canvas.nav.switchCanvas")}>
                    {canvasTitle}
                </button>
            </Dropdown>
            <ChevronRight className="size-3 shrink-0 opacity-40" />
            <Tooltip title={t("canvas.nav.openSessions")}>
                <button type="button" className={itemClass} onClick={onOpenSessions} aria-label={t("canvas.nav.openSessions")}>
                    <MessageSquare className="size-3 shrink-0 opacity-60" />
                    {sessionLabel}
                </button>
            </Tooltip>
        </nav>
    );
}
