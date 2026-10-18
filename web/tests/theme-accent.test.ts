import { expect, test } from "bun:test";

import { ACCENT_PRESETS, DEFAULT_ACCENT_ID, accentIdOf, accentValueOf } from "../src/lib/theme-accent";

test("accentValueOf maps a preset id to its hex value", () => {
    expect(accentValueOf("violet")).toBe("#8b5cf6");
    expect(accentValueOf("blue")).toBe("#3b82f6");
});

test("the default preset carries no color so the theme keeps its own", () => {
    expect(accentValueOf(DEFAULT_ACCENT_ID)).toBe("");
});

test("accentIdOf normalizes an unknown or empty value back to the default preset", () => {
    expect(accentIdOf("")).toBe(DEFAULT_ACCENT_ID);
    expect(accentIdOf("#ff00ff")).toBe(DEFAULT_ACCENT_ID);
    expect(accentIdOf("#10b981")).toBe("emerald");
});

test("accentIdOf and accentValueOf round-trip every preset", () => {
    for (const preset of ACCENT_PRESETS) {
        expect(accentIdOf(accentValueOf(preset.id))).toBe(preset.id);
    }
});

test("preset ids are unique and every colored preset uses a distinct hex", () => {
    const ids = ACCENT_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    const colors = ACCENT_PRESETS.map((preset) => preset.value).filter(Boolean);
    expect(new Set(colors).size).toBe(colors.length);
});
