// Visibility prefs for the canvas overlay panels (timeline / journal). They live in localStorage —
// the same convention as the canvas-agent UI prefs (panel width, bridge endpoint) — so a reload keeps
// whatever the user last chose. Default is closed: a first visit never opens an overlay nobody asked
// for. The storage is injectable so the logic stays testable without a DOM.
export type CanvasPanelPrefKey = "timeline" | "journal";

const STORAGE_PREFIX = "canvas-panel-open:";

// The slice of Storage this module uses; tests pass a plain in-memory stub.
export type PanelPrefStorage = Pick<Storage, "getItem" | "setItem">;

// Resolved lazily per call so importing this module never touches `window` (bun tests have no DOM).
function activeStorage(): PanelPrefStorage | null {
    return typeof window === "undefined" ? null : window.localStorage;
}

export function canvasPanelPrefStorageKey(key: CanvasPanelPrefKey): string {
    return `${STORAGE_PREFIX}${key}`;
}

export function readCanvasPanelOpen(key: CanvasPanelPrefKey, storage: PanelPrefStorage | null = activeStorage()): boolean {
    return storage?.getItem(canvasPanelPrefStorageKey(key)) === "1";
}

export function writeCanvasPanelOpen(key: CanvasPanelPrefKey, open: boolean, storage: PanelPrefStorage | null = activeStorage()): void {
    if (!storage) return;
    storage.setItem(canvasPanelPrefStorageKey(key), open ? "1" : "0");
}
