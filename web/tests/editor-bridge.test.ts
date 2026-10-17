import { expect, test } from "bun:test";

import {
    DEFAULT_EDITOR_TIMEOUT_MS,
    EDITOR_BRIDGE_SCRIPT,
    EDITOR_ENGINE,
    EDITOR_ENGINE_NAME,
    EDITOR_ENGINE_VERSION,
    EDITOR_IFRAME_SRC,
    EDITOR_IFRAME_TO_PARENT_KINDS,
    EDITOR_MESSAGE_CHANNEL,
    EDITOR_PARENT_TO_IFRAME_KINDS,
    MESSAGES,
    buildEditorSavePatch,
    editorMessage,
    isEditorMessage,
    requestWithTimeout,
} from "../src/lib/canvas/editor-bridge";
import enUS from "../src/i18n/locales/en-US";
import zhCN from "../src/i18n/locales/zh-CN";

const keyPaths = (value: unknown, prefix = ""): string[] =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key)) : prefix ? [prefix] : [];

// --- protocol constants ----------------------------------------------------------------------

test("protocol constants cover both directions and stay in sync with the guard", () => {
    expect(MESSAGES.channel).toBe(EDITOR_MESSAGE_CHANNEL);
    expect(EDITOR_PARENT_TO_IFRAME_KINDS).toEqual(["ping", "load-image", "export-image"]);
    expect(EDITOR_IFRAME_TO_PARENT_KINDS).toEqual(["ready", "pong", "loaded", "exported", "error"]);
    expect(MESSAGES.ping).toBe("ping");
    expect(MESSAGES.pong).toBe("pong");
    expect(MESSAGES.ready).toBe("ready");
    expect(MESSAGES.loadImage).toBe("load-image");
    expect(MESSAGES.loaded).toBe("loaded");
    expect(MESSAGES.exportImage).toBe("export-image");
    expect(MESSAGES.exported).toBe("exported");
    expect(MESSAGES.error).toBe("error");
    // Every named constant resolves to a kind the guard accepts.
    for (const kind of [MESSAGES.ping, MESSAGES.pong, MESSAGES.ready, MESSAGES.loadImage, MESSAGES.loaded, MESSAGES.exportImage, MESSAGES.exported, MESSAGES.error]) {
        expect(isEditorMessage({ channel: EDITOR_MESSAGE_CHANNEL, kind })).toBe(true);
    }
});

test("engine descriptor and iframe source are the pinned self-hosted miniPaint build", () => {
    expect(EDITOR_ENGINE_NAME).toBe("miniPaint");
    expect(EDITOR_ENGINE_VERSION).toBe("4.14.3");
    expect(EDITOR_ENGINE).toEqual({ name: "miniPaint", version: "4.14.3" });
    expect(EDITOR_IFRAME_SRC).toBe("/minipaint/index.html");
    expect(DEFAULT_EDITOR_TIMEOUT_MS).toBeGreaterThan(0);
});

test("editorMessage stamps the channel and keeps caller fields", () => {
    expect(editorMessage(MESSAGES.ping, { id: "r1" })).toEqual({ channel: EDITOR_MESSAGE_CHANNEL, kind: "ping", id: "r1" });
    expect(editorMessage(MESSAGES.loadImage, { src: "data:image/png;base64,AA" })).toEqual({ channel: EDITOR_MESSAGE_CHANNEL, kind: "load-image", src: "data:image/png;base64,AA" });
    expect(editorMessage(MESSAGES.error).kind).toBe("error");
});

// --- pipe guard ------------------------------------------------------------------------------

test("isEditorMessage accepts every well-formed message kind", () => {
    expect(isEditorMessage({ channel: EDITOR_MESSAGE_CHANNEL, kind: "ping", id: "1" })).toBe(true);
    expect(isEditorMessage({ channel: EDITOR_MESSAGE_CHANNEL, kind: "pong", id: "1" })).toBe(true);
    expect(isEditorMessage({ channel: EDITOR_MESSAGE_CHANNEL, kind: "ready", strategy: "engine", message: "{}" })).toBe(true);
    expect(isEditorMessage({ channel: EDITOR_MESSAGE_CHANNEL, kind: "load-image", src: "data:image/png;base64,AA" })).toBe(true);
    expect(isEditorMessage({ channel: EDITOR_MESSAGE_CHANNEL, kind: "loaded", id: "2", strategy: "file-open-handler" })).toBe(true);
    expect(isEditorMessage({ channel: EDITOR_MESSAGE_CHANNEL, kind: "export-image", id: "3" })).toBe(true);
    expect(isEditorMessage({ channel: EDITOR_MESSAGE_CHANNEL, kind: "exported", id: "3", dataUrl: "data:image/png;base64,AA" })).toBe(true);
    expect(isEditorMessage({ channel: EDITOR_MESSAGE_CHANNEL, kind: "error", id: "4", message: "export-empty" })).toBe(true);
});

test("isEditorMessage rejects foreign, malformed, and mistyped payloads", () => {
    expect(isEditorMessage(null)).toBe(false);
    expect(isEditorMessage(undefined)).toBe(false);
    expect(isEditorMessage("ping")).toBe(false);
    expect(isEditorMessage(42)).toBe(false);
    expect(isEditorMessage([])).toBe(false);
    expect(isEditorMessage({})).toBe(false);
    expect(isEditorMessage({ kind: "ping" })).toBe(false);
    expect(isEditorMessage({ channel: "other:channel", kind: "ping" })).toBe(false);
    expect(isEditorMessage({ channel: EDITOR_MESSAGE_CHANNEL })).toBe(false);
    expect(isEditorMessage({ channel: EDITOR_MESSAGE_CHANNEL, kind: "not-a-kind" })).toBe(false);
    expect(isEditorMessage({ channel: EDITOR_MESSAGE_CHANNEL, kind: 5 })).toBe(false);
    expect(isEditorMessage({ channel: EDITOR_MESSAGE_CHANNEL, kind: "exported", dataUrl: 7 })).toBe(false);
    expect(isEditorMessage({ channel: EDITOR_MESSAGE_CHANNEL, kind: "ping", id: {} })).toBe(false);
});

// --- timeout wrapper -------------------------------------------------------------------------

test("requestWithTimeout resolves with the underlying value before the deadline", async () => {
    await expect(requestWithTimeout(Promise.resolve("ok"), 1000)).resolves.toBe("ok");
});

test("requestWithTimeout propagates the original rejection", async () => {
    let caught: unknown = null;
    try {
        await requestWithTimeout(Promise.reject(new Error("bridge-failed")), 1000);
    } catch (cause) {
        caught = cause;
    }
    expect(caught instanceof Error).toBe(true);
    expect((caught as Error).message).toBe("bridge-failed");
});

test("requestWithTimeout rejects with the timeout error when the promise never settles", async () => {
    const never = new Promise<string>(() => undefined);
    const startedAt = Date.now();
    let caught: unknown = null;
    try {
        await requestWithTimeout(never, 10, "editor-timeout");
    } catch (cause) {
        caught = cause;
    }
    expect(caught instanceof Error).toBe(true);
    expect((caught as Error).message).toBe("editor-timeout");
    expect(Date.now() - startedAt).toBeLessThan(1000);
});

// --- artifact / structure write-back ----------------------------------------------------------

test("buildEditorSavePatch writes the artifact and bumps the structure timestamp", () => {
    const patch = buildEditorSavePatch({ regions: { source: "old.png", regions: [{ id: "r1", type: "title", bbox: { x: 0, y: 0, w: 10, h: 10 }, text: "Hi" }] } }, "data:image/png;base64,NEW", 1234);
    expect(patch.content).toBe("data:image/png;base64,NEW");
    expect(patch.editor).toEqual({ engine: "miniPaint", version: "4.14.3", lastSavedAt: 1234 });
    expect(patch.regions?.source).toBe("old.png");
    expect(patch.regions?.parsedAt).toBe(1234);
    expect(patch.regions?.regions?.length).toBe(1);
});

test("buildEditorSavePatch omits the structure layer when the node has none", () => {
    const patch = buildEditorSavePatch(undefined, "data:image/png;base64,NEW", 99);
    expect(patch.content).toBe("data:image/png;base64,NEW");
    expect("regions" in patch).toBe(false);
    expect(patch.editor?.engine).toBe("miniPaint");
});

// --- injected bridge script -------------------------------------------------------------------

test("the injected bridge script re-declares the channel and probes miniPaint instead of assuming it", () => {
    expect(EDITOR_BRIDGE_SCRIPT).toContain(EDITOR_MESSAGE_CHANNEL);
    expect(EDITOR_BRIDGE_SCRIPT).toContain("window.parent.postMessage");
    expect(EDITOR_BRIDGE_SCRIPT).toContain("typeof window.FileOpen.file_open_data_url_handler");
    expect(EDITOR_BRIDGE_SCRIPT).toContain("window.Layers");
    expect(EDITOR_BRIDGE_SCRIPT).toContain("canvas_minipaint");
    for (const kind of ["ping", "pong", "ready", "load-image", "loaded", "export-image", "exported", "error"]) {
        expect(EDITOR_BRIDGE_SCRIPT).toContain(`"${kind}"`);
    }
});

// --- i18n key alignment --------------------------------------------------------------------------

test("canvas.editor keys exist on both locales with identical paths", () => {
    const en = keyPaths((enUS as Record<string, unknown>).canvas).filter((path) => path === "editor" || path.startsWith("editor.") || path.startsWith("nodeTypes.editor"));
    const zh = keyPaths((zhCN as Record<string, unknown>).canvas).filter((path) => path === "editor" || path.startsWith("editor.") || path.startsWith("nodeTypes.editor"));
    expect(en.length).toBe(21);
    expect(en).toEqual(zh);
    expect(en).toContain("nodeTypes.editor");
    expect(en).toContain("editor.engine");
    expect(en).toContain("editor.openImage");
    expect(en).toContain("editor.saveBack");
    expect(en).toContain("editor.saveAsNode");
    expect(en).toContain("editor.saveAsNodeTitle");
    expect(en).toContain("editor.fullscreen");
    expect(en).toContain("editor.exitFullscreen");
    expect(en).toContain("editor.savedAsNode");
    expect(en).toContain("editor.retry");
});

test("canvas namespace key path sets are exactly equal across locales", () => {
    const en = keyPaths((enUS as Record<string, unknown>).canvas).sort();
    const zh = keyPaths((zhCN as Record<string, unknown>).canvas).sort();
    expect(en).toEqual(zh);
});
