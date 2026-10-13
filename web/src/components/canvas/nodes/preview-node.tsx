// M4: web preview node. Renders a local dev server (vite/next `npm run dev`) inside an
// iframe so agent output is visible on the canvas, probes reachability with a status dot,
// auto-refreshes the frame after code edits, and feeds a real screen capture back to the
// agent panel. URL/interval live in node metadata (metadata.preview), mirroring how M2
// stores terminalSession.
import { useCallback, useEffect, useState } from "react";

import { Camera, ExternalLink, Globe, Hand, Move, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { randomId } from "@/lib/utils";
import { useAgentStore, type AgentAttachment } from "@/stores/use-agent-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeContext, CanvasNodeDefinition } from "@/types/canvas-plugin";

export const PREVIEW_NODE_TYPE = "preview";
export const DEFAULT_PREVIEW_URL = "http://localhost:5173";

const DEFAULT_AUTO_REFRESH_MS = 5000;
const PROBE_INTERVAL_MS = 5000;
const PROBE_TIMEOUT_MS = 3000;
const REFRESH_OPTIONS = [0, 2000, 5000, 10000] as const;
const MAX_ATTACHMENTS = 6;

type ProbeStatus = "unknown" | "reachable" | "unreachable";

function readPreview(node: CanvasNodeData) {
    const preview = node.metadata?.preview;
    const url = typeof preview?.url === "string" && preview.url.trim() ? preview.url : DEFAULT_PREVIEW_URL;
    const autoRefreshMs = typeof preview?.autoRefreshMs === "number" && preview.autoRefreshMs >= 0 ? preview.autoRefreshMs : DEFAULT_AUTO_REFRESH_MS;
    return { url, autoRefreshMs };
}

// A dev server answers an opaque (no-cors) request without CORS headers, so a resolved
// fetch means "reachable" even though we cannot read the response. Only a network error
// or our own timeout abort counts as unreachable.
async function probeDevServer(url: string, signal: AbortSignal) {
    await fetch(url, { mode: "no-cors", cache: "no-store", signal });
}

// Real screen capture: a cross-origin iframe cannot be read client-side, so we use the
// Screen Capture API (the app is on a secure context: localhost/https). The user picks the
// window/tab that shows the preview and we keep exactly one real frame. Returns null when
// the API is missing or the user cancels, and the caller then falls back to opening the
// page externally with no attachment — this never fabricates a screenshot.
async function captureScreenFrame(): Promise<{ dataUrl: string; width: number; height: number } | null> {
    if (typeof navigator === "undefined" || typeof navigator.mediaDevices?.getDisplayMedia !== "function") return null;
    let stream: MediaStream | null = null;
    try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: false });
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await new Promise<void>((resolve) => {
            if (video.videoWidth > 0) {
                resolve();
                return;
            }
            video.onloadeddata = () => resolve();
        });
        await video.play().catch(() => undefined);
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!width || !height) return null;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return null;
        context.drawImage(video, 0, 0, width, height);
        return { dataUrl: canvas.toDataURL("image/png"), width, height };
    } catch {
        return null;
    } finally {
        stream?.getTracks().forEach((track) => track.stop());
    }
}

function PreviewView({ ctx }: { ctx: CanvasNodeContext }) {
    const { t } = useTranslation();
    const { url, autoRefreshMs } = readPreview(ctx.node);
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const openAgentPanel = useAgentStore((state) => state.openPanel);
    const [draftUrl, setDraftUrl] = useState(url);
    const [reloadKey, setReloadKey] = useState(0);
    const [status, setStatus] = useState<ProbeStatus>("unknown");
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState("");
    // The interaction toggle gates iframe pointer events; the toolbar and URL field stay usable.
    const interactive = Boolean(ctx.node.metadata?.interactive);

    useEffect(() => {
        setDraftUrl(url);
    }, [url]);

    useEffect(() => {
        if (!notice) return;
        const timer = window.setTimeout(() => setNotice(""), 4000);
        return () => window.clearTimeout(timer);
    }, [notice]);

    // Sparse dev-server probe so a stale dot never blocks the UI and polling stays light.
    useEffect(() => {
        let disposed = false;
        let timer: number | undefined;
        const tick = async () => {
            const controller = new AbortController();
            const timeout = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
            try {
                await probeDevServer(url, controller.signal);
                if (!disposed) setStatus("reachable");
            } catch {
                if (!disposed) setStatus("unreachable");
            } finally {
                window.clearTimeout(timeout);
            }
            if (!disposed) timer = window.setTimeout(() => void tick(), PROBE_INTERVAL_MS);
        };
        void tick();
        return () => {
            disposed = true;
            if (timer) window.clearTimeout(timer);
        };
    }, [url]);

    // Auto refresh: remounting the iframe reloads it even when the page is cross-origin.
    useEffect(() => {
        if (autoRefreshMs <= 0) return;
        const timer = window.setInterval(() => setReloadKey((value) => value + 1), autoRefreshMs);
        return () => window.clearInterval(timer);
    }, [autoRefreshMs]);

    const commitUrl = useCallback(() => {
        const next = draftUrl.trim() || DEFAULT_PREVIEW_URL;
        setDraftUrl(next);
        if (next === url) return;
        ctx.updateMetadata({ preview: { url: next, autoRefreshMs } });
        setReloadKey((value) => value + 1);
    }, [autoRefreshMs, ctx, draftUrl, url]);

    const updateInterval = useCallback(
        (next: number) => {
            ctx.updateMetadata({ preview: { url, autoRefreshMs: next } });
        },
        [ctx, url],
    );

    const openExternal = useCallback(() => {
        window.open(url, "_blank", "noopener,noreferrer");
    }, [url]);

    const feedScreenshot = useCallback(async () => {
        if (busy) return;
        setBusy(true);
        setNotice(t("canvas.preview.capturing"));
        try {
            const capture = await captureScreenFrame();
            if (!capture) {
                // No reliable capture path here: open the page instead and attach nothing.
                setNotice(t("canvas.preview.screenshotUnsupported"));
                openExternal();
                return;
            }
            const blob = await (await fetch(capture.dataUrl)).blob();
            const attachment: AgentAttachment = {
                id: randomId(),
                name: `${t("canvas.nodeTypes.preview")}.png`,
                type: blob.type || "image/png",
                size: blob.size,
                width: capture.width,
                height: capture.height,
                url: URL.createObjectURL(blob),
                dataUrl: capture.dataUrl,
            };
            const current = useAgentStore.getState().attachments;
            setAgentState({ attachments: [...current, attachment].slice(-MAX_ATTACHMENTS) });
            openAgentPanel();
            setNotice(t("canvas.preview.screenshotAttached"));
        } catch {
            setNotice(t("canvas.preview.screenshotFailed"));
        } finally {
            setBusy(false);
        }
    }, [busy, openAgentPanel, openExternal, setAgentState, t]);

    const dotColor = status === "reachable" ? "#22c55e" : status === "unreachable" ? "#ef4444" : "#a8a29e";
    const dotTitle = status === "reachable" ? t("canvas.preview.reachable") : status === "unreachable" ? t("canvas.preview.unreachable") : t("canvas.preview.probing");
    const controlClass = "shrink-0 rounded border border-stone-300 bg-transparent px-1.5 py-1 text-[11px] text-stone-600 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800";

    return (
        <div className="flex h-full w-full flex-col overflow-hidden bg-white dark:bg-stone-900">
            <div className="flex shrink-0 items-center gap-1.5 border-b border-stone-200 px-2 py-1.5 dark:border-stone-800">
                <span className="size-2 shrink-0 rounded-full" style={{ background: dotColor }} title={dotTitle} />
                <input
                    value={draftUrl}
                    onChange={(event) => setDraftUrl(event.target.value)}
                    onBlur={commitUrl}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") commitUrl();
                    }}
                    placeholder={t("canvas.preview.urlPlaceholder")}
                    className="min-w-0 flex-1 rounded border border-stone-300 bg-transparent px-1.5 py-1 text-[11px] text-stone-700 outline-none dark:border-stone-700 dark:text-stone-200"
                />
                <button type="button" onClick={openExternal} title={t("canvas.preview.open")} className={controlClass}>
                    <ExternalLink className="size-3.5" />
                </button>
                <button type="button" onClick={() => setReloadKey((value) => value + 1)} title={t("canvas.preview.refresh")} className={controlClass}>
                    <RefreshCw className="size-3.5" />
                </button>
                <select value={autoRefreshMs} onChange={(event) => updateInterval(Number(event.target.value))} title={t("canvas.preview.interval")} className={controlClass}>
                    {REFRESH_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                            {option === 0 ? t("canvas.preview.intervalOff") : t("canvas.preview.intervalSeconds", { seconds: option / 1000 })}
                        </option>
                    ))}
                </select>
                <button type="button" onClick={() => void feedScreenshot()} disabled={busy} title={t("canvas.preview.screenshot")} className={controlClass}>
                    <Camera className="size-3.5" />
                </button>
            </div>
            {notice ? <div className="shrink-0 border-b border-stone-200 px-2 py-1 text-[11px] text-stone-500 dark:border-stone-800 dark:text-stone-400">{notice}</div> : null}
            <div className="relative min-h-0 flex-1 bg-white">
                <iframe
                    key={`${reloadKey}-${url}`}
                    src={url}
                    title={t("canvas.nodeTypes.preview")}
                    className="h-full w-full border-0 bg-white"
                    style={{ pointerEvents: interactive ? "auto" : "none" }}
                />
            </div>
        </div>
    );
}

export function previewNodeDefinition(): CanvasNodeDefinition {
    return {
        type: PREVIEW_NODE_TYPE,
        title: i18n.t("canvas.nodeTypes.preview"),
        icon: <Globe className="size-4" />,
        description: i18n.t("canvas.preview.description"),
        minimapColor: "#0ea5e9",
        defaultSize: { width: 620, height: 420 },
        defaultMetadata: { preview: { url: DEFAULT_PREVIEW_URL, autoRefreshMs: DEFAULT_AUTO_REFRESH_MS } },
        hasSourceHandle: false,
        hidePanel: true,
        // The host's built-in interaction toggle keys off metadata.content, which a preview
        // node does not use, so we expose the same move/interact toggle ourselves and gate
        // iframe pointer events through metadata.interactive.
        interactionToggle: true,
        toolbar: (ctx) => {
            const interactive = Boolean(ctx.node.metadata?.interactive);
            return [
                {
                    id: "preview-interaction-toggle",
                    title: i18n.t(interactive ? "canvas.plugins.interactiveTitle" : "canvas.plugins.movableTitle"),
                    label: i18n.t(interactive ? "canvas.plugins.move" : "canvas.plugins.interact"),
                    icon: interactive ? <Move className="size-3.5" /> : <Hand className="size-3.5" />,
                    active: interactive,
                    onClick: () => ctx.updateMetadata({ interactive: !interactive }),
                },
            ];
        },
        Content: ({ ctx }) => <PreviewView ctx={ctx} />,
    };
}

let registered = false;
export function registerPreviewNode() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions([previewNodeDefinition()], "builtin");
}
