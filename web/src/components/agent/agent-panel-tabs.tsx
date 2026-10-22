import type { ReactNode } from "react";
import { Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";

export type AgentPanelTabItem<T extends string> = {
    value: T;
    label: string;
    icon?: ReactNode;
    /** 数量角标。windows 形态表示未读条数，tabs 形态表示该类内容的条目数。 */
    count?: number;
    /** 未读小红点，用在 windows 形态。 */
    dot?: boolean;
    /** 覆盖默认 tooltip（例如会话窗要带快捷键和未读数）。 */
    hint?: string;
    /** 会话窗状态（running / queued / idle / error），渲染成 data-status 供样式与端到端断言使用。 */
    status?: string;
    /**
     * 状态文字（运行中 / 排队中 / 空闲）。
     * 只靠转圈和颜色分不出「在跑」与「排队」，尤其色弱和窄面板下，所以要有文字。
     * 空闲态刻意不传：既有用例按 tab 文案 `会话 N` 做精确断言，空闲不该往标签里塞字。
     */
    statusLabel?: string;
};

type AgentPanelTabsProps<T extends string> = {
    value: T;
    items: AgentPanelTabItem<T>[];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    leading?: ReactNode;
    right?: ReactNode;
    onChange: (value: T) => void;
    /**
     * windows：会话窗切换条（灰底 + 胶囊），与下面的内容 tab 在视觉上分层；
     * tabs：面板内容 tab（下划线）。
     */
    variant?: "tabs" | "windows";
    /** 分区标题，例如「会话窗」；只用于 windows 形态。 */
    label?: string;
};

export function AgentPanelTabs<T extends string>({ value, items, theme, leading, right, onChange, variant = "tabs", label }: AgentPanelTabsProps<T>) {
    const { t } = useTranslation();
    const isWindows = variant === "windows";
    return (
        <div className="@container border-b px-2" style={{ borderColor: theme.node.stroke, background: isWindows ? theme.node.fill : undefined }}>
            {/* 窄面板下右侧动作（含驱动切换）会把 tab 压成 0 宽，导致 tab 被 leading 图标挡住、点不动。
                这里允许换行：空间不够时右侧动作掉到第二行，tab 始终可点。 */}
            <div className={`flex flex-wrap items-center gap-1 ${isWindows ? "h-10" : "min-h-12 py-1 @min-[560px]:h-12 @min-[560px]:flex-nowrap @min-[560px]:py-0"}`}>
                {label ? (
                    <span className="shrink-0 pl-1 pr-1.5 text-[11px] font-medium tracking-wide" style={{ color: theme.node.muted }}>
                        {label}
                    </span>
                ) : null}
                {leading ? <div className="flex shrink-0 items-center">{leading}</div> : null}
                <nav
                    className={isWindows ? "flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" : "@container flex min-w-0 flex-1 basis-[9rem] items-center justify-center gap-0.5 overflow-hidden text-sm @min-[560px]:gap-3"}
                    role="tablist"
                    aria-label={isWindows ? t("agent.window.section") : t("agent.panel.content")}
                >
                    {items.map((item) => {
                        const active = value === item.value;
                        // 两种形态的数量语义不同，提示文案必须分开写，避免把「3 条历史」读成「3 条未读」。
                        const tooltip = item.hint ?? (isWindows && item.count ? t("agent.window.unread", { count: item.count }) : item.count ? `${item.label} (${item.count})` : item.label);
                        return (
                            <Tooltip key={item.value} title={tooltip} placement="bottom">
                                <button
                                    type="button"
                                    role="tab"
                                    aria-label={tooltip}
                                    aria-selected={active}
                                    data-status={item.status}
                                    className={
                                        isWindows
                                            ? `inline-flex h-7 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs transition hover:brightness-[0.98] ${active ? "font-medium shadow-sm" : ""}`
                                            : `inline-flex h-12 min-w-8 shrink-0 items-center justify-center gap-1.5 border-b-2 px-1.5 transition @min-[560px]:px-0.5 ${active ? "font-medium" : "font-normal"}`
                                    }
                                    style={
                                        isWindows
                                            ? { background: active ? theme.node.panel : "transparent", color: active ? theme.node.text : theme.node.muted, border: `1px solid ${active ? theme.node.stroke : "transparent"}` }
                                            : { borderColor: active ? theme.node.text : "transparent", color: active ? theme.node.text : theme.node.muted }
                                    }
                                    onClick={() => onChange(item.value)}
                                >
                                    {item.icon ? <span className="agent-panel-tab-icon">{item.icon}</span> : null}
                                    <span className={item.icon && !isWindows ? "hidden @min-[400px]:inline" : undefined}>{item.label}</span>
                                    {isWindows && item.statusLabel ? <span data-window-status-label={item.status} className="shrink-0 text-[10px] leading-none opacity-70">{item.statusLabel}</span> : null}
                                    {item.dot ? <span className="size-1.5 shrink-0 rounded-full bg-red-500" /> : null}
                                    {!isWindows && item.count ? <span className="text-[10px] font-normal leading-none tabular-nums opacity-60">{item.count > 99 ? "99+" : item.count}</span> : null}
                                </button>
                            </Tooltip>
                        );
                    })}
                </nav>
                {right ? <div className="flex shrink-0 items-center gap-1">{right}</div> : null}
            </div>
        </div>
    );
}
