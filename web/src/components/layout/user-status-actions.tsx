import type { CSSProperties } from "react";
import { Dropdown, Tooltip } from "antd";
import { Keyboard, Palette, Puzzle, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { VersionReleaseModal } from "@/components/layout/version-release-modal";
import { changeAppLocale, type AppLocale } from "@/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import { ACCENT_PRESETS, accentIdOf, accentValueOf } from "@/lib/theme-accent";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

type UserStatusActionsProps = {
    showConfig?: boolean;
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
    onOpenPlugins?: () => void;
};

function AccentPicker({ className, style }: { className: string; style?: CSSProperties }) {
    const { t } = useTranslation();
    const accent = useThemeStore((state) => state.accent);
    const setAccent = useThemeStore((state) => state.setAccent);
    const items = ACCENT_PRESETS.map((preset) => ({
        key: preset.id,
        label: (
            <span className="inline-flex items-center gap-2">
                <span className="size-3 shrink-0 rounded-full border border-black/15 dark:border-white/25" style={preset.value ? { background: preset.value } : { background: "linear-gradient(135deg,#fafaf9 50%,#1c1917 50%)" }} />
                <span>{t(`topNav.accent.${preset.id}`)}</span>
            </span>
        ),
    }));
    const label = t("topNav.accent.label");
    return (
        <Dropdown menu={{ items, selectable: true, selectedKeys: [accentIdOf(accent)], onClick: ({ key }) => setAccent(accentValueOf(key)) }} trigger={["click"]} placement="bottomRight">
            <button type="button" className={className} style={style} aria-label={label} title={label}>
                <Palette className="size-4" />
            </button>
        </Dropdown>
    );
}

export function UserStatusActions({ showConfig = true, variant = "default", onOpenShortcuts, onOpenPlugins }: UserStatusActionsProps) {
    const { i18n, t } = useTranslation();
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const canvasTheme = canvasThemes[theme];
    const naturalIconClass = "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-stone-600 transition-colors hover:bg-black/5 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white [&_svg]:size-4";
    const iconStyle: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;
    const versionStyle = iconStyle;
    const locale = i18n.resolvedLanguage as AppLocale;
    const nextLocale = locale === "zh-CN" ? "en-US" : "zh-CN";
    const languageLabel = t("topNav.switchLanguage", { language: t(nextLocale === "zh-CN" ? "locale.zhCN" : "locale.enUS") });

    return (
        <div className="inline-flex shrink-0 items-center gap-1">
            {onOpenPlugins ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenPlugins} aria-label={t("topNav.plugins")} title={t("topNav.plugins")}>
                    <Puzzle className="size-4" />
                </button>
            ) : null}
                        {showConfig ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => openConfigDialog(false)} aria-label={t("navigation.config")} title={t("navigation.config")}>
                    <Settings2 className="size-4" />
                </button>
            ) : null}
            <Tooltip title={languageLabel} mouseEnterDelay={0.2}>
                <button type="button" className={`${naturalIconClass} text-[11px] font-semibold tracking-tight`} style={iconStyle} onClick={() => void changeAppLocale(nextLocale)} aria-label={languageLabel}>
                    {locale === "zh-CN" ? "中" : "EN"}
                </button>
            </Tooltip>
            <AccentPicker className={naturalIconClass} style={iconStyle} />
            <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={naturalIconClass} style={iconStyle} aria-label={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")} title={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")} />
            {/* The canvas toolbar keeps only icons — the version chip is page furniture there,
                and the library page + settings dialog already expose it. */}
            {variant === "canvas" ? null : <VersionReleaseModal style={versionStyle} />}

            {onOpenShortcuts ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenShortcuts} aria-label={t("topNav.shortcuts")} title={t("topNav.shortcuts")}>
                    <Keyboard className="size-4" />
                </button>
            ) : null}
        </div>
    );
}
