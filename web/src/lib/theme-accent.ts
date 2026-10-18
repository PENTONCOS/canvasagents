// G9：用户可选强调色（accent）。theme = light/dark 之外再给一层「强调色」。
// 取值是单个 hex，明暗两种主题共用一套（选色尽量取中间调，两边都不糊）。
// 空串 = 跟随主题默认（不写 CSS 变量）。
export type AccentPreset = { id: string; value: string };

export const ACCENT_PRESETS: AccentPreset[] = [
    { id: "default", value: "" },
    { id: "violet", value: "#8b5cf6" },
    { id: "blue", value: "#3b82f6" },
    { id: "emerald", value: "#10b981" },
    { id: "amber", value: "#f59e0b" },
    { id: "rose", value: "#f43f5e" },
];

export const DEFAULT_ACCENT_ID = "default";

export function accentValueOf(id: string): string {
    return ACCENT_PRESETS.find((preset) => preset.id === id)?.value ?? "";
}

export function accentIdOf(value: string): string {
    return ACCENT_PRESETS.find((preset) => preset.value === (value || ""))?.id ?? DEFAULT_ACCENT_ID;
}
