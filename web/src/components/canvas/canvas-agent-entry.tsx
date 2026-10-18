// G9：画布右下角常驻的助手入口。面板收起时露出来，点一下新建一个会话窗并展开面板。
// 未读数 / 运行中状态直接读 store，保证和面板头部的 tab 角标一致。
import { Bot } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useAgentStore } from "@/stores/use-agent-store";
import { useThemeStore } from "@/stores/use-theme-store";

export function CanvasAgentEntry() {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const accent = useThemeStore((state) => state.accent);
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const unread = useAgentStore((state) => state.windows.reduce((sum, item) => sum + item.unread, 0));
    const running = useAgentStore((state) => state.windows.some((item) => item.status === "running"));

    // 面板展开时它就在旁边，藏起来避免压住面板。
    if (panelOpen) return null;

    const label = t("agent.entry.open");
    return (
        <button
            type="button"
            className="fixed bottom-5 right-5 z-40 grid size-11 place-items-center rounded-full shadow-lg transition-transform hover:scale-105"
            style={{ background: theme.node.panel, border: `1px solid ${accent || theme.node.stroke}`, color: theme.node.text }}
            aria-label={label}
            title={label}
            onClick={() => {
                useAgentStore.getState().addWindow();
                useAgentStore.getState().openPanel();
            }}
        >
            <Bot className="size-5" />
            {unread > 0 ? (
                <span className="absolute -right-1 -top-1 grid min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold" style={{ background: accent || theme.node.activeStroke, color: theme.node.panel }}>
                    {unread > 99 ? "99+" : unread}
                </span>
            ) : null}
            {running ? <span className="absolute -bottom-0.5 -right-0.5 size-3 animate-pulse rounded-full bg-emerald-500" /> : null}
        </button>
    );
}
