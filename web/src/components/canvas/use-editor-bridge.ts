// Phase 3 follow-up: the parent side of the embedded PS-mode editor bridge, extracted from the
// editor node so the standalone `editor` node and the "edit this image in PS" overlay on an image
// node share exactly one implementation. The iframe is same-origin, so after load we append the
// bridge script to its document and only treat the frame as ready once the injected script answers a
// ping. Engine entry points are probed at runtime inside that script (see lib/canvas/editor-bridge);
// this hook never assumes a global such as miniPaint's Layers/FileOpen exists.
import { useCallback, useEffect, useRef, useState } from "react";

import i18n from "@/i18n";
import { DEFAULT_EDITOR_TIMEOUT_MS, EDITOR_BRIDGE_SCRIPT, MESSAGES, editorMessage, isEditorMessage, requestWithTimeout, type EditorMessage, type EditorMessageKind } from "@/lib/canvas/editor-bridge";
import { randomId } from "@/lib/utils";

export type EditorBridgeStatus = "connecting" | "ready" | "error";

// The frame only counts as ready if the injected script answers within this window; slow/blocked
// frames fail loudly (surfaced as `error`) instead of leaving the UI spinning forever.
export const DEFAULT_EDITOR_READY_TIMEOUT_MS = 12000;
// Transient status lines (loading/loaded/saved) clear themselves so they do not pile up.
export const EDITOR_NOTICE_TIMEOUT_MS = 4000;

type PendingRequest = { resolve: (message: EditorMessage) => void; reject: (cause: unknown) => void };

export type UseEditorBridgeOptions = {
    // Image data URL (or remote URL) the editor should load.
    source: string;
    // Called with the exported bitmap after a successful export from the editor. The caller owns the
    // write-back; this hook only moves bytes across the frame boundary.
    onExport: (dataUrl: string, savedAt: number) => void | Promise<void>;
    readyTimeoutMs?: number;
};

export function editorErrorMessage(cause: unknown) {
    return cause instanceof Error ? cause.message : String(cause);
}

export function useEditorBridge({ source, onExport, readyTimeoutMs = DEFAULT_EDITOR_READY_TIMEOUT_MS }: UseEditorBridgeOptions) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const pendingRef = useRef(new Map<string, PendingRequest>());
    // Kept in a ref so an inline `onExport` arrow does not invalidate the callbacks below.
    const exportRef = useRef(onExport);
    // Same for the in-flight guard: `openImage`/`exportImage` stay identity-stable across renders so
    // a caller can put them in an effect dependency list without re-triggering a load on every state
    // change (which would clobber edits in progress).
    const busyRef = useRef(false);
    const [status, setStatus] = useState<EditorBridgeStatus>("connecting");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);

    useEffect(() => {
        exportRef.current = onExport;
    }, [onExport]);

    useEffect(() => {
        if (!notice) return;
        const timer = window.setTimeout(() => setNotice(""), EDITOR_NOTICE_TIMEOUT_MS);
        return () => window.clearTimeout(timer);
    }, [notice]);

    // Single message listener shared by every request; only messages coming from our own frame are
    // accepted and only ones passing the protocol guard are routed to a pending request.
    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            const frame = iframeRef.current;
            if (!frame || event.source !== frame.contentWindow) return;
            if (!isEditorMessage(event.data)) return;
            const message = event.data;
            const requestId = message.id || "";
            const pending = requestId ? pendingRef.current.get(requestId) : undefined;
            if (!pending) return;
            pendingRef.current.delete(requestId);
            if (message.kind === MESSAGES.error) pending.reject(new Error(message.message || "editor-error"));
            else pending.resolve(message);
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, []);

    const request = useCallback(async (kind: EditorMessageKind, fields: Omit<EditorMessage, "channel" | "kind" | "id"> = {}, timeoutMs: number = DEFAULT_EDITOR_TIMEOUT_MS) => {
        const frame = iframeRef.current;
        const target = frame?.contentWindow;
        if (!frame || !target) throw new Error(i18n.t("canvas.editor.bridgeUnavailable"));
        const id = randomId();
        const promise = new Promise<EditorMessage>((resolve, reject) => {
            pendingRef.current.set(id, { resolve, reject });
        });
        target.postMessage(editorMessage(kind, { ...fields, id }), window.location.origin);
        try {
            return await requestWithTimeout(promise, timeoutMs, i18n.t("canvas.editor.bridgeTimeout"));
        } finally {
            pendingRef.current.delete(id);
        }
    }, []);

    const handleFrameLoad = useCallback(() => {
        setError("");
        setStatus("connecting");
        const frame = iframeRef.current;
        let doc: Document | null = null;
        try {
            doc = frame?.contentDocument ?? null;
        } catch {
            doc = null;
        }
        if (!doc) {
            setStatus("error");
            setError(i18n.t("canvas.editor.bridgeUnavailable"));
            return;
        }
        const script = doc.createElement("script");
        script.textContent = EDITOR_BRIDGE_SCRIPT;
        (doc.head || doc.documentElement).appendChild(script);
        void request(MESSAGES.ping, {}, readyTimeoutMs)
            .then(() => setStatus("ready"))
            .catch((cause: unknown) => {
                setStatus("error");
                setError(editorErrorMessage(cause));
            });
    }, [readyTimeoutMs, request]);

    const reload = useCallback(() => {
        pendingRef.current.clear();
        setReloadKey((value) => value + 1);
    }, []);

    const openImage = useCallback(async () => {
        if (!source) {
            setError(i18n.t("canvas.editor.empty"));
            return;
        }
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        setError("");
        setNotice(i18n.t("canvas.editor.loading"));
        try {
            await request(MESSAGES.loadImage, { src: source });
            setNotice(i18n.t("canvas.editor.loaded"));
        } catch (cause) {
            setError(editorErrorMessage(cause) || i18n.t("canvas.editor.loadFailed"));
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    }, [request, source]);

    const exportImage = useCallback(async () => {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        setError("");
        try {
            const result = await request(MESSAGES.exportImage);
            const dataUrl = result.dataUrl || "";
            if (!dataUrl) throw new Error(i18n.t("canvas.editor.exportEmpty"));
            const savedAt = Date.now();
            await exportRef.current(dataUrl, savedAt);
            setNotice(i18n.t("canvas.editor.savedAt", { time: new Date(savedAt).toLocaleTimeString() }));
        } catch (cause) {
            setError(editorErrorMessage(cause) || i18n.t("canvas.editor.saveFailed"));
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    }, [request]);

    return { iframeRef, reloadKey, status, error, notice, busy, handleFrameLoad, reload, openImage, exportImage };
}
