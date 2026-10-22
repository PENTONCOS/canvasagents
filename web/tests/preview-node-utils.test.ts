import { describe, expect, test } from "bun:test";

import { classifyPreviewFailure, normalizePreviewUrl, resolvePreviewFailure } from "@/lib/canvas/preview-node-utils";

describe("preview node utils (A2) — URL normalization", () => {
    test("empty input reports empty instead of falling back to localhost", () => {
        expect(normalizePreviewUrl("")).toEqual({ url: "", problem: "empty" });
        expect(normalizePreviewUrl("   ")).toEqual({ url: "", problem: "empty" });
    });

    test("explicit http/https URLs are kept as-is", () => {
        expect(normalizePreviewUrl("https://example.com/docs?a=1")).toEqual({ url: "https://example.com/docs?a=1", problem: null });
        expect(normalizePreviewUrl("http://localhost:5173")).toEqual({ url: "http://localhost:5173", problem: null });
    });

    test("scheme-less input gains a scheme; local hosts get http", () => {
        expect(normalizePreviewUrl("localhost:5173")).toEqual({ url: "http://localhost:5173", problem: null });
        expect(normalizePreviewUrl("127.0.0.1:3000/app")).toEqual({ url: "http://127.0.0.1:3000/app", problem: null });
        expect(normalizePreviewUrl("192.168.1.20")).toEqual({ url: "http://192.168.1.20", problem: null });
        expect(normalizePreviewUrl("172.20.0.5:8080")).toEqual({ url: "http://172.20.0.5:8080", problem: null });
        expect(normalizePreviewUrl("example.com")).toEqual({ url: "https://example.com", problem: null });
    });

    test("script and local-file schemes are rejected", () => {
        for (const raw of ["javascript:alert(1)", "data:text/html,<h1>x</h1>", "file:///etc/passwd", "vbscript:msgbox", "blob:https://a/b", "about:blank"]) {
            expect(normalizePreviewUrl(raw)).toEqual({ url: "", problem: "unsupported" });
        }
    });

    test("non-web schemes with // are rejected", () => {
        expect(normalizePreviewUrl("ftp://example.com")).toEqual({ url: "", problem: "unsupported" });
        expect(normalizePreviewUrl("ws://example.com")).toEqual({ url: "", problem: "unsupported" });
    });

    test("garbage input does not throw", () => {
        expect(normalizePreviewUrl("http://")).toEqual({ url: "", problem: "unsupported" });
        expect(normalizePreviewUrl("/relative/path").problem).not.toBe(null);
    });
});

describe("preview node utils (A2) — failure resolution", () => {
    test("a loaded frame never reports failure", () => {
        expect(resolvePreviewFailure({ loaded: true, failed: false, elapsedMs: 99999 })).toBeNull();
        expect(resolvePreviewFailure({ loaded: true, failed: true, elapsedMs: 99999 })).toBeNull();
    });

    test("onError reports unreachable immediately", () => {
        expect(resolvePreviewFailure({ loaded: false, failed: true, elapsedMs: 10 })).toBe("unreachable");
    });

    test("no onLoad before the timeout stays silent, then times out", () => {
        expect(resolvePreviewFailure({ loaded: false, failed: false, elapsedMs: 500 })).toBeNull();
        expect(resolvePreviewFailure({ loaded: false, failed: false, elapsedMs: 12000 })).toBe("timeout");
        expect(resolvePreviewFailure({ loaded: false, failed: false, elapsedMs: 12000, timeoutMs: 30000 })).toBeNull();
    });

    test("probe status does not gate the error card", () => {
        // 探测说不可达、但 iframe 还没超时：仍然不报错（no-cors 探测会误判）。
        expect(resolvePreviewFailure({ loaded: false, failed: false, elapsedMs: 2000 })).toBeNull();
    });

    test("timeout copy is refined by an already-known probe result", () => {
        expect(classifyPreviewFailure("timeout", "reachable")).toBe("blocked");
        expect(classifyPreviewFailure("timeout", "unreachable")).toBe("unreachable");
        expect(classifyPreviewFailure("timeout", "unknown")).toBe("timeout");
        // 明确失败/已判定被拦的情况不受探测影响。
        expect(classifyPreviewFailure("unreachable", "reachable")).toBe("unreachable");
        expect(classifyPreviewFailure("blocked", "unknown")).toBe("blocked");
    });
});
