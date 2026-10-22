// M4/A2: web preview node. Renders any web page inside an iframe so agent output (or an
// arbitrary site) is visible on the canvas, probes reachability with a status dot,
// auto-refreshes the frame after code edits, and feeds a real screen capture back to the
// agent panel. URL/interval live in node metadata (metadata.preview), mirroring how M2
// stores terminalSession.
//
// A2 changes: any URL (not just a local dev server), manual refresh stays, and a failed
// frame shows a readable Chinese/English error card instead of a blank iframe. The probe
// dot is informational only — a no-cors probe cannot prove a public site is unreachable
// (CORS/网络策略都会让探测失败), so the error card is driven by the iframe itself:
// onError → 网络不可达, no onLoad within the timeout → 超时/被禁止嵌入.
import { useCallback, useEffect, useRef, useState } from "react";

import { AlertTriangle, Camera, ExternalLink, Globe, Hand, Move, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { DEFAULT_PREVIEW_URL, PREVIEW_NODE_TYPE, classifyPreviewFailure, normalizePreviewUrl, resolvePreviewFailure, type PreviewFailure, type PreviewProbeStatus } from "@/lib/canvas/preview-node-utils";
import { randomId } from "@/lib/utils";
import { useAgentStore, type AgentAttachment } from "@/stores/use-agent-store";
import { requestAgentCaptureSilently } from "@/services/api/canvas-agent";
import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeContext, CanvasNodeDefinition } from "@/types/canvas-plugin";

export { PREVIEW_NODE_TYPE, DEFAULT_PREVIEW_URL };

const DEFAULT_AUTO_REFRESH_MS = 5000;
const PROBE_INTERVAL_MS = 5000;
const PROBE_TIMEOUT_MS = 3000;
/** iframe 多久没有 onLoad 就判定为失败（够慢网/冷启动的 dev server 用）。 */
const FRAME_LOAD_TIMEOUT_MS = 12000;
/** onLoad 已经触发、但文档停在 about:blank，基本就是被 X-Frame-Options/CSP 拦掉了。 */
const BLOCKED_PROBE_DELAY_MS = 600;
const REFRESH_OPTIONS = [0, 2000, 5000, 10000] as const;
const MAX_ATTACHMENTS = 6;

type ProbeStatus = PreviewProbeStatus;

function readPreview(node: CanvasNodeData) {
    const preview = node.metadata?.preview;
    // A2: 空 URL 就是空状态，不再回落到 localhost:5173（占位符仍给建议值）。
    const url = typeof preview?.url === "string" ? preview.url.trim() : "";
    const autoRefreshMs = typeof preview?.autoRefreshMs === "number" && preview.autoRefreshMs >= 0 ? preview.autoRefreshMs : DEFAULT_AUTO_REFRESH_MS;
    return { url, autoRefreshMs };
}

// A dev server answers an opaque (no-cors) request without CORS headers, so a resolved
// fetch means "reachable" even though we cannot read the response. A rejected fetch only
// means "this browser could not complete an opaque request" (CORS policy, DNS, offline),
// which is why the dot never drives the error card.
async function probeDevServer(url: string, signal: AbortSignal) {
    await fetch(url, { mode: "no-cors", cache: "no-store", signal });
}

/**
 * Best effort: 被 X-Frame-Options/CSP 拦下的 frame 在 Chrome 会触发 onLoad，但文档不是目标页。
 * 跨域正常加载时 contentDocument 为 null；被拦下时通常是可访问的 about:blank。
 * 只做提示，抓不到就不下结论（不 pretend 成功）。
 */
function looksLikeBlockedFrame(frame: HTMLIFrameElement | null, url: string): boolean {
    if (!frame) return false;
    try {
        const doc = frame.contentDocument;
        if (!doc) return false;
        const docUrl = doc.URL ?? "";
        if (!docUrl) return false;
        if (docUrl === "about:blank" || docUrl === "about:srcdoc") {
            // 目标 URL 自己就是 about:blank 时不算（normalizePreviewUrl 本来也不允许）。
            return !url.startsWith("about:");
        }
        return false;
    } catch {
        // 跨域访问抛错 = 页面确实加载了别的源，正常情况。
        return false;
    }
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
    const stored = readPreview(ctx.node);
    const normalized = normalizePreviewUrl(stored.url);
    const url = normalized.url;
    const autoRefreshMs = stored.autoRefreshMs;
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const openAgentPanel = useAgentStore((state) => state.openPanel);
    const [draftUrl, setDraftUrl] = useState(stored.url);
    const [reloadKey, setReloadKey] = useState(0);
    const [status, setStatus] = useState<ProbeStatus>("unknown");
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState("");
    const frameRef = useRef<HTMLIFrameElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    // 每次重新加载都是一个新的 frameKey：onLoad/onError/超时都只认当前这一帧，避免旧帧串台。
    const frameKey = `${reloadKey}|${url}`;
    const [frame, setFrame] = useState<{ key: string; loaded: boolean; failed: boolean; expired: boolean; blocked: boolean }>({
        key: frameKey,
        loaded: false,
        failed: false,
        expired: false,
        blocked: false,
    });
    // G3: 只在 dev server 由不可达转可达（= 部署/重启成功）时沉淀一张产物截图。
    const previousStatusRef = useRef<ProbeStatus>("unknown");
    // The interaction toggle gates iframe pointer events; the toolbar and URL field stay usable.
    const interactive = Boolean(ctx.node.metadata?.interactive);

    useEffect(() => {
        setDraftUrl(stored.url);
    }, [stored.url]);

    useEffect(() => {
        if (!notice) return;
        const timer = window.setTimeout(() => setNotice(""), 4000);
        return () => window.clearTimeout(timer);
    }, [notice]);

    // 新的一帧开始：清空状态并起一个超时计时器。
    useEffect(() => {
        if (!url) return;
        setFrame({ key: frameKey, loaded: false, failed: false, expired: false, blocked: false });
        const timer = window.setTimeout(() => {
            setFrame((prev) => (prev.key === frameKey && !prev.loaded ? { ...prev, expired: true } : prev));
        }, FRAME_LOAD_TIMEOUT_MS);
        return () => window.clearTimeout(timer);
    }, [frameKey, url]);

    // Sparse probe, 只喂状态圆点（以及超时后的文案归类），不驱动错误卡。
    useEffect(() => {
        if (!url) {
            setStatus("unknown");
            return;
        }
        let disposed = false;
        let timer: number | undefined;
        const tick = async () => {
            const controller = new AbortController();
            const timeout = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
            try {
                await probeDevServer(url, controller.signal);
                if (!disposed) {
                    setStatus("reachable");
                    if (previousStatusRef.current === "unreachable") {
                        const { url: endpoint, token } = useAgentStore.getState();
                        requestAgentCaptureSilently(endpoint, token, { tag: "preview" });
                    }
                    previousStatusRef.current = "reachable";
                }
            } catch {
                if (!disposed) {
                    setStatus("unreachable");
                    previousStatusRef.current = "unreachable";
                }
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
        if (autoRefreshMs <= 0 || !url) return;
        const timer = window.setInterval(() => setReloadKey((value) => value + 1), autoRefreshMs);
        return () => window.clearInterval(timer);
    }, [autoRefreshMs, url]);

    const current = frame.key === frameKey ? frame : { key: frameKey, loaded: false, failed: false, expired: false, blocked: false };
    const rawFailure: PreviewFailure | null = current.blocked
        ? "blocked"
        : resolvePreviewFailure({ loaded: current.loaded, failed: current.failed, elapsedMs: current.expired ? FRAME_LOAD_TIMEOUT_MS : 0, timeoutMs: FRAME_LOAD_TIMEOUT_MS });
    const failure: PreviewFailure | null = rawFailure ? classifyPreviewFailure(rawFailure, status) : null;

    const handleFrameLoad = useCallback(() => {
        setFrame((prev) => (prev.key === frameKey ? { ...prev, loaded: true, failed: false } : prev));
        // onLoad 也可能来自「被拦下的错误页」，延后一拍再看文档停在哪。
        window.setTimeout(() => {
            if (looksLikeBlockedFrame(frameRef.current, url)) {
                setFrame((prev) => (prev.key === frameKey ? { ...prev, loaded: false, blocked: true } : prev));
            }
        }, BLOCKED_PROBE_DELAY_MS);
    }, [frameKey, url]);

    const commitUrl = useCallback(() => {
        const next = normalizePreviewUrl(draftUrl);
        if (next.problem === "unsupported") {
            setNotice(t("canvas.preview.invalidUrl"));
            return;
        }
        const value = next.url;
        setDraftUrl(value);
        if (value === stored.url) return;
        ctx.updateMetadata({ preview: { url: value, autoRefreshMs } });
        setReloadKey((key) => key + 1);
    }, [autoRefreshMs, ctx, draftUrl, stored.url, t]);

    const updateInterval = useCallback(
        (next: number) => {
            ctx.updateMetadata({ preview: { url: stored.url, autoRefreshMs: next } });
        },
        [ctx, stored.url],
    );

    const retry = useCallback(() => {
        setNotice("");
        setStatus("unknown");
        setReloadKey((value) => value + 1);
    }, []);

    const openExternal = useCallback(() => {
        if (!url) return;
        window.open(url, "_blank", "noopener,noreferrer");
    }, [url]);

    const feedScreenshot = useCallback(async () => {
        if (busy || !url) return;
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
            const currentAttachments = useAgentStore.getState().attachments;
            setAgentState({ attachments: [...currentAttachments, attachment].slice(-MAX_ATTACHMENTS) });
            openAgentPanel();
            setNotice(t("canvas.preview.screenshotAttached"));
        } catch {
            setNotice(t("canvas.preview.screenshotFailed"));
        } finally {
            setBusy(false);
        }
    }, [busy, openAgentPanel, openExternal, setAgentState, t, url]);

    const dotColor = status === "reachable" ? "#22c55e" : status === "unreachable" ? "#ef4444" : "#a8a29e";
    const dotTitle = status === "reachable" ? t("canvas.preview.reachable") : status === "unreachable" ? t("canvas.preview.unreachable") : t("canvas.preview.probing");
    const controlClass = "shrink-0 rounded border border-stone-300 bg-transparent px-1.5 py-1 text-[11px] text-stone-600 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800";

    const failureTitle = failure === "blocked" ? t("canvas.preview.errorBlocked") : failure === "unreachable" ? t("canvas.preview.errorUnreachable") : t("canvas.preview.errorTimeout");
    const failureHint = failure === "blocked" ? t("canvas.preview.errorHintBlocked") : failure === "unreachable" ? t("canvas.preview.errorHintUnreachable") : t("canvas.preview.errorHintTimeout");

    return (
        <div className="flex h-full w-full flex-col overflow-hidden bg-white dark:bg-stone-900">
            <div className="flex shrink-0 items-center gap-1.5 border-b border-stone-200 px-2 py-1.5 dark:border-stone-800">
                <span className="size-2 shrink-0 rounded-full" style={{ background: url ? dotColor : "#d6d3d1" }} title={url ? dotTitle : t("canvas.preview.emptyTitle")} />
                <input
                    ref={inputRef}
                    value={draftUrl}
                    onChange={(event) => setDraftUrl(event.target.value)}
                    onBlur={commitUrl}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") commitUrl();
                        event.stopPropagation();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    placeholder={t("canvas.preview.urlPlaceholder")}
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded border border-stone-300 bg-transparent px-1.5 py-1 text-[11px] text-stone-700 outline-none dark:border-stone-700 dark:text-stone-200"
                    data-preview-url-input
                />
                <button type="button" onClick={openExternal} disabled={!url} title={t("canvas.preview.open")} className={controlClass}>
                    <ExternalLink className="size-3.5" />
                </button>
                <button type="button" onClick={retry} disabled={!url} title={t("canvas.preview.refresh")} className={controlClass} data-preview-refresh>
                    <RefreshCw className="size-3.5" />
                </button>
                <select value={autoRefreshMs} onChange={(event) => updateInterval(Number(event.target.value))} title={t("canvas.preview.interval")} className={controlClass}>
                    {REFRESH_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                            {option === 0 ? t("canvas.preview.intervalOff") : t("canvas.preview.intervalSeconds", { seconds: option / 1000 })}
                        </option>
                    ))}
                </select>
                <button type="button" onClick={() => void feedScreenshot()} disabled={busy || !url} title={t("canvas.preview.screenshot")} className={controlClass}>
                    <Camera className="size-3.5" />
                </button>
            </div>
            {notice ? <div className="shrink-0 border-b border-stone-200 px-2 py-1 text-[11px] text-stone-500 dark:border-stone-800 dark:text-stone-400">{notice}</div> : null}
            <div className="relative min-h-0 flex-1 bg-white dark:bg-stone-950">
                {!url ? (
                    <button
                        type="button"
                        className="flex h-full w-full flex-col items-center justify-center gap-1.5 p-4 text-center text-stone-500 dark:text-stone-400"
                        onClick={() => inputRef.current?.focus()}
                        data-preview-empty
                    >
                        <Globe className="size-6 opacity-50" />
                        <span className="text-xs font-medium">{t("canvas.preview.emptyTitle")}</span>
                        <span className="max-w-[280px] text-[11px] leading-4 opacity-70">{t("canvas.preview.emptyHint")}</span>
                    </button>
                ) : failure ? (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-5 text-center" data-preview-error>
                        <AlertTriangle className="size-6 text-amber-500" />
                        <span className="text-xs font-semibold text-stone-700 dark:text-stone-200">{t("canvas.preview.errorTitle")}</span>
                        <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">{failureTitle}</span>
                        <span className="max-w-[320px] text-[11px] leading-4 text-stone-500 dark:text-stone-400">{failureHint}</span>
                        <span className="max-w-[320px] break-all text-[10px] leading-4 text-stone-400 dark:text-stone-500">{url}</span>
                        <div className="mt-1 flex items-center gap-2">
                            <button type="button" onClick={retry} className="rounded border border-stone-300 px-2 py-1 text-[11px] text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-200 dark:hover:bg-stone-800" data-preview-retry>
                                {t("canvas.preview.retry")}
                            </button>
                            <button type="button" onClick={openExternal} className="rounded border border-stone-300 px-2 py-1 text-[11px] text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-200 dark:hover:bg-stone-800">
                                {t("canvas.preview.open")}
                            </button>
                        </div>
                    </div>
                ) : (
                    <iframe
                        ref={frameRef}
                        key={frameKey}
                        src={url}
                        title={t("canvas.nodeTypes.preview")}
                        className="h-full w-full border-0 bg-white"
                        style={{ pointerEvents: interactive ? "auto" : "none" }}
                        onLoad={handleFrameLoad}
                        onError={() => setFrame((prev) => (prev.key === frameKey ? { ...prev, failed: true } : prev))}
                    />
                )}
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
        // A2: 新节点不再预填 localhost:5173；URL 由用户输入，空着就是空状态。
        defaultMetadata: { preview: { url: "", autoRefreshMs: DEFAULT_AUTO_REFRESH_MS } },
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
