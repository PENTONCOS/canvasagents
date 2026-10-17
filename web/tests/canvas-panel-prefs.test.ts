import { expect, test } from "bun:test";

import { canvasPanelPrefStorageKey, readCanvasPanelOpen, writeCanvasPanelOpen, type PanelPrefStorage } from "../src/lib/canvas/canvas-panel-prefs";

// In-memory stand-in for localStorage so the pref logic is testable without a DOM.
function memoryStorage(seed: Record<string, string> = {}) {
    const map = new Map(Object.entries(seed));
    const storage: PanelPrefStorage = {
        getItem: (key: string) => (map.has(key) ? String(map.get(key)) : null),
        setItem: (key: string, value: string) => {
            map.set(key, value);
        },
    };
    return { storage, map };
}

test("panel prefs default to closed", () => {
    const { storage } = memoryStorage();
    expect(readCanvasPanelOpen("timeline", storage)).toBe(false);
    expect(readCanvasPanelOpen("journal", storage)).toBe(false);
});

test("a written pref reads back and lives under a namespaced key", () => {
    const { storage, map } = memoryStorage();
    writeCanvasPanelOpen("timeline", true, storage);
    expect(readCanvasPanelOpen("timeline", storage)).toBe(true);
    expect(canvasPanelPrefStorageKey("timeline")).toBe("canvas-panel-open:timeline");
    expect(map.get(canvasPanelPrefStorageKey("timeline"))).toBe("1");
});

test("the two panels keep independent values and closing writes an explicit 0", () => {
    const { storage, map } = memoryStorage();
    writeCanvasPanelOpen("timeline", true, storage);
    writeCanvasPanelOpen("timeline", false, storage);
    writeCanvasPanelOpen("journal", true, storage);
    expect(readCanvasPanelOpen("timeline", storage)).toBe(false);
    expect(readCanvasPanelOpen("journal", storage)).toBe(true);
    expect(map.size).toBe(2);
});

test("a storage-less environment reads closed instead of throwing", () => {
    expect(readCanvasPanelOpen("timeline", null)).toBe(false);
    expect(() => writeCanvasPanelOpen("timeline", true, null)).not.toThrow();
});

test("an unexpected stored value counts as closed", () => {
    const { storage } = memoryStorage({ "canvas-panel-open:timeline": "yes", "canvas-panel-open:journal": "" });
    expect(readCanvasPanelOpen("timeline", storage)).toBe(false);
    expect(readCanvasPanelOpen("journal", storage)).toBe(false);
});
