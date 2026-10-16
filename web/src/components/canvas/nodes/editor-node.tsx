// Phase 3: professional PS-mode editor node. Embeds the self-hosted miniPaint build in a
// same-origin iframe and talks to a small script injected into that frame via postMessage
// (see lib/canvas/editor-bridge). Opening loads metadata.content into the editor; saving pulls the
// edited canvas back out as an artifact (node content / image data URL) while keeping any existing
// structure layer (metadata.regions) intact.
import { useCallback, useEffect, useRef, useState } from "react";

import { AlertCircle, Hand, ImagePlus, Loader2, Move, PenTool, RefreshCw, Save } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import {
    DEFAULT_EDITOR_TIMEOUT_MS,
    EDITOR_BRIDGE_SCRIPT,
    EDITOR_ENGINE_NAME,
    EDITOR_ENGINE_VERSION,
    EDITOR_IFRAME_SRC,
    MESSAGES,
    buildEditorSavePatch,
    editorMessage,
    isEditorMessage,
    requestWithTimeout,
    type EditorMessage,
    type EditorMessageKind,
} from "@/lib/canvas/editor-bridge";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { randomId } from "@/lib/utils";
import type { CanvasNodeContext, CanvasNodeDefinition } from "@/types/canvas-plugin";

export const EDITOR_NODE_TYPE = "editor";

const STATUS_CLASS = "shrink-0 rounded border border-stone-300 bg-transparent px-1.5 py-1 text-[11px] text-stone-600 hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800";
const READY_TIMEOUT_MS = 12000;

type BridgeStatus = "connecting" | "ready" | "error";
type PendingRequest = { resolve: (message: EditorMessage) => void; reject: (cause: unknown) => void };

function errorMessage(cause: unknown) {
    return cause instanceof Error ? cause.message : String(cause);
}

function EditorView({ ctx }: { ctx: CanvasNodeContext }) {
    const { t } = useTranslation();
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const pendingRef = useRef(new Map<string, PendingRequest>());
    const [status, setStatus] = useState<BridgeStatus>("connecting");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    // The interaction toggle gates iframe pointer events so canvas drag/zoom still works.
    const interactive = Boolean(ctx.node.metadata?.interactive);
    const source = ctx.node.metadata?.content || "";
    const engineVersion = ctx.node.metadata?.editor?.version || EDITOR_ENGINE_VERSION;

    useEffect(() => {
        if (!notice) return;
        const timer = window.setTimeout(() => setNotice(""), 4000);
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

    // Because the frame is same-origin we can append the bridge script directly to its document; the
    // frame only counts as ready once the injected script answers a ping within the timeout.
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
        void request(MESSAGES.ping, {}, READY_TIMEOUT_MS)
            .then(() => setStatus("ready"))
            .catch((cause: unknown) => {
                setStatus("error");
                setError(errorMessage(cause));
            });
    }, [request]);

    const reload = useCallback(() => {
        pendingRef.current.clear();
        setReloadKey((value) => value + 1);
    }, []);

    const openImage = useCallback(async () => {
        if (!source) {
            setError(i18n.t("canvas.editor.empty"));
            return;
        }
        if (busy) return;
        setBusy(true);
        setError("");
        setNotice(i18n.t("canvas.editor.loading"));
        try {
            await request(MESSAGES.loadImage, { src: source });
            setNotice(i18n.t("canvas.editor.loaded"));
        } catch (cause) {
            setError(errorMessage(cause) || i18n.t("canvas.editor.loadFailed"));
        } finally {
            setBusy(false);
        }
    }, [busy, request, source]);

    const saveBack = useCallback(async () => {
        if (busy) return;
        setBusy(true);
        setError("");
        try {
            const result = await request(MESSAGES.exportImage);
            const dataUrl = result.dataUrl || "";
            if (!dataUrl) throw new Error(i18n.t("canvas.editor.exportEmpty"));
            const savedAt = Date.now();
            // Artifact (node content) + structure (regions kept, parse timestamp bumped).
            ctx.updateMetadata(buildEditorSavePatch(ctx.node.metadata, dataUrl, savedAt));
            setNotice(i18n.t("canvas.editor.savedAt", { time: new Date(savedAt).toLocaleTimeString() }));
        } catch (cause) {
            setError(errorMessage(cause) || i18n.t("canvas.editor.saveFailed"));
        } finally {
            setBusy(false);
        }
    }, [busy, ctx, request]);

    const statusText = status === "ready" ? "" : status === "connecting" ? t("canvas.editor.connecting") : "";

    return (
        <div className="flex h-full w-full flex-col overflow-hidden bg-white text-stone-700 dark:bg-stone-900 dark:text-stone-200">
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-stone-200 px-2 py-1.5 dark:border-stone-800">
                <PenTool className="size-3.5 shrink-0 text-stone-500 dark:text-stone-400" />
                <span className="shrink-0 rounded bg-stone-100 px-1 py-0.5 text-[10px] text-stone-600 dark:bg-stone-800 dark:text-stone-300" title={t("canvas.editor.engine", { engine: EDITOR_ENGINE_NAME, version: engineVersion })}>
                    {t("canvas.editor.engine", { engine: EDITOR_ENGINE_NAME, version: engineVersion })}
                </span>
                {statusText ? (
                    <span className="flex shrink-0 items-center gap-1 text-[10px] text-stone-500 dark:text-stone-400">
                        <Loader2 className="size-3 animate-spin" />
                        {statusText}
                    </span>
                ) : null}
                <span className="min-w-0 flex-1" />
                <button type="button" onClick={() => void openImage()} disabled={busy || status !== "ready"} title={t("canvas.editor.openImage")} className={`${STATUS_CLASS} flex items-center gap-1`}>
                    <ImagePlus className="size-3.5" />
                    {t("canvas.editor.openImage")}
                </button>
                <button type="button" onClick={() => void saveBack()} disabled={busy || status !== "ready"} title={t("canvas.editor.saveBack")} className={`${STATUS_CLASS} flex items-center gap-1`}>
                    <Save className="size-3.5" />
                    {t("canvas.editor.saveBack")}
                </button>
                <button type="button" onClick={reload} title={t("canvas.editor.retry")} className={STATUS_CLASS}>
                    <RefreshCw className="size-3.5" />
                </button>
            </div>

            {notice ? <div className="shrink-0 border-b border-stone-200 px-2 py-1 text-[11px] text-stone-500 dark:border-stone-800 dark:text-stone-400">{notice}</div> : null}

            <div className="relative min-h-0 flex-1 bg-stone-100 dark:bg-stone-950">
                <iframe
                    key={reloadKey}
                    ref={iframeRef}
                    src={EDITOR_IFRAME_SRC}
                    title={t("canvas.nodeTypes.editor")}
                    onLoad={handleFrameLoad}
                    className="h-full w-full border-0 bg-white"
                    style={{ pointerEvents: interactive ? "auto" : "none" }}
                />

                {!source ? (
                    <div className="pointer-events-none absolute inset-x-2 top-2 flex items-center gap-1.5 rounded border border-stone-300 bg-white/85 px-2 py-1 text-[11px] text-stone-500 dark:border-stone-700 dark:bg-stone-900/85 dark:text-stone-400">
                        <ImagePlus className="size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{t("canvas.editor.empty")}</span>
                    </div>
                ) : null}

                {status === "error" && error ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/90 px-4 text-center dark:bg-stone-900/90">
                        <span className="flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-300">
                            <AlertCircle className="size-3.5 shrink-0" />
                            <span className="min-w-0 truncate" title={error}>
                                {error || t("canvas.editor.bridgeUnavailable")}
                            </span>
                        </span>
                        <button type="button" onClick={reload} className={`${STATUS_CLASS} flex items-center gap-1`}>
                            <RefreshCw className="size-3.5" />
                            {t("canvas.editor.retry")}
                        </button>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

export function editorNodeDefinition(): CanvasNodeDefinition {
    return {
        type: EDITOR_NODE_TYPE,
        title: i18n.t("canvas.nodeTypes.editor"),
        icon: <PenTool className="size-4" />,
        description: i18n.t("canvas.editor.description"),
        minimapColor: "#7c3aed",
        defaultSize: { width: 900, height: 620 },
        defaultMetadata: { editor: { engine: EDITOR_ENGINE_NAME, version: EDITOR_ENGINE_VERSION } },
        hidePanel: true,
        // The host's interaction toggle keys off metadata.content; the editor gates its own iframe
        // pointer events through metadata.interactive so the node stays draggable when idle.
        interactionToggle: true,
        toolbar: (ctx) => {
            const interactive = Boolean(ctx.node.metadata?.interactive);
            return [
                {
                    id: "editor-interaction-toggle",
                    title: i18n.t(interactive ? "canvas.plugins.interactiveTitle" : "canvas.plugins.movableTitle"),
                    label: i18n.t(interactive ? "canvas.plugins.move" : "canvas.plugins.interact"),
                    icon: interactive ? <Move className="size-3.5" /> : <Hand className="size-3.5" />,
                    active: interactive,
                    onClick: () => ctx.updateMetadata({ interactive: !interactive }),
                },
            ];
        },
        Content: ({ ctx }) => <EditorView ctx={ctx} />,
    };
}

let registered = false;
export function registerEditorNode() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions([editorNodeDefinition()], "builtin");
}
