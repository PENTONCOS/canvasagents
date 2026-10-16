// M6: service node. Describes a local service (name/port/health path) and actively probes
// http://127.0.0.1:<port><healthPath || "/"> with a short timeout, so the canvas shows whether
// the service is actually up. The binding lives in node metadata (metadata.service).
import { useCallback, useEffect, useState } from "react";

import { Activity, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { SERVICE_PROBE_TIMEOUT_MS, buildHealthUrl, normalizePort, readServiceMetadata, serviceMetadataPatch } from "@/lib/canvas/service-node-utils";
import type { CanvasNodeServiceStatus } from "@/types/canvas";
import type { CanvasNodeContext, CanvasNodeDefinition } from "@/types/canvas-plugin";

export const SERVICE_NODE_TYPE = "service";

const PROBE_INTERVAL_MS = 5000;
const FIELD_CLASS = "w-full rounded border border-stone-300 bg-transparent px-1.5 py-1 text-[11px] outline-none dark:border-stone-700";

const STATUS_COLOR: Record<CanvasNodeServiceStatus, string> = {
    probing: "#a8a29e",
    ready: "#22c55e",
    failed: "#ef4444",
};

const STATUS_LABEL_KEY: Record<CanvasNodeServiceStatus, string> = {
    probing: "canvas.service.probing",
    ready: "canvas.service.ready",
    failed: "canvas.service.failed",
};

function errorMessage(cause: unknown) {
    return cause instanceof Error ? cause.message : String(cause);
}

// A loopback service without CORS headers answers an opaque (no-cors) request, so a resolved
// fetch means "reachable"; only a network error or our own timeout counts as failure.
async function probeHealth(url: string, signal: AbortSignal) {
    await fetch(url, { mode: "no-cors", cache: "no-store", signal });
}

function ServiceNodeView({ ctx }: { ctx: CanvasNodeContext }) {
    const { t } = useTranslation();
    const state = readServiceMetadata(ctx.node.metadata);
    const healthUrl = buildHealthUrl(state.port, state.healthPath);

    const [status, setStatus] = useState<CanvasNodeServiceStatus>(state.status);
    const [error, setError] = useState("");
    const [draftName, setDraftName] = useState(state.name);
    const [draftPort, setDraftPort] = useState(state.port == null ? "" : String(state.port));
    const [draftHealthPath, setDraftHealthPath] = useState(state.healthPath);
    const [probeKey, setProbeKey] = useState(0);

    useEffect(() => {
        setDraftName(state.name);
        setDraftPort(state.port == null ? "" : String(state.port));
        setDraftHealthPath(state.healthPath);
    }, [state.name, state.port, state.healthPath]);

    // Sparse probe loop; aborts on unmount, target change, or a manual refresh.
    useEffect(() => {
        if (!healthUrl) {
            setStatus("failed");
            setError(i18n.t("canvas.service.portRequired"));
            return;
        }
        let disposed = false;
        let timer: number | undefined;
        const tick = async () => {
            const controller = new AbortController();
            const timeout = window.setTimeout(() => controller.abort(), SERVICE_PROBE_TIMEOUT_MS);
            try {
                await probeHealth(healthUrl, controller.signal);
                if (!disposed) {
                    setStatus("ready");
                    setError("");
                }
            } catch (cause) {
                if (!disposed) {
                    setStatus("failed");
                    setError(errorMessage(cause));
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
    }, [healthUrl, probeKey]);

    // Persist the probe outcome into metadata only when it changes, so canvases stay quiet.
    useEffect(() => {
        if (state.status === status) return;
        ctx.updateMetadata({ service: serviceMetadataPatch(state, { status }) });
    }, [status, state, ctx]);

    const commit = useCallback(
        (patch: Parameters<typeof serviceMetadataPatch>[1]) => {
            ctx.updateMetadata({ service: serviceMetadataPatch(state, patch) });
        },
        [ctx, state],
    );

    const commitPort = useCallback(() => {
        const port = normalizePort(draftPort);
        setDraftPort(port == null ? "" : String(port));
        commit({ port: port == null ? undefined : port });
    }, [commit, draftPort]);

    return (
        <div className="flex h-full w-full flex-col overflow-hidden bg-white text-stone-700 dark:bg-stone-900 dark:text-stone-200">
            <div className="flex shrink-0 items-center gap-1.5 border-b border-stone-200 px-2 py-1.5 dark:border-stone-800">
                <span className="size-2 shrink-0 rounded-full" style={{ background: STATUS_COLOR[status] }} title={error || t(STATUS_LABEL_KEY[status])} />
                <Activity className="size-3.5 shrink-0 text-stone-500 dark:text-stone-400" />
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium" title={state.name}>
                    {state.name || t("canvas.service.untitled")}
                </span>
                <span className="shrink-0 text-[10px] text-stone-400 dark:text-stone-500">{t(STATUS_LABEL_KEY[status])}</span>
                <button type="button" onClick={() => setProbeKey((value) => value + 1)} title={t("canvas.service.retry")} className="shrink-0 rounded border border-stone-300 bg-transparent px-1 py-1 text-stone-600 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800">
                    <RefreshCw className="size-3" />
                </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
                <label className="block space-y-1">
                    <span className="block text-[10px] text-stone-500 dark:text-stone-400">{t("canvas.service.name")}</span>
                    <input
                        value={draftName}
                        onChange={(event) => setDraftName(event.target.value)}
                        onBlur={() => commit({ name: draftName })}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") commit({ name: draftName });
                        }}
                        className={FIELD_CLASS}
                    />
                </label>
                <label className="block space-y-1">
                    <span className="block text-[10px] text-stone-500 dark:text-stone-400">{t("canvas.service.port")}</span>
                    <input
                        value={draftPort}
                        inputMode="numeric"
                        onChange={(event) => setDraftPort(event.target.value)}
                        onBlur={commitPort}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") commitPort();
                        }}
                        placeholder={t("canvas.service.portPlaceholder")}
                        className={FIELD_CLASS}
                    />
                </label>
                <label className="block space-y-1">
                    <span className="block text-[10px] text-stone-500 dark:text-stone-400">{t("canvas.service.healthPath")}</span>
                    <input
                        value={draftHealthPath}
                        onChange={(event) => setDraftHealthPath(event.target.value)}
                        onBlur={() => commit({ healthPath: draftHealthPath })}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") commit({ healthPath: draftHealthPath });
                        }}
                        placeholder={t("canvas.service.healthPathPlaceholder")}
                        className={FIELD_CLASS}
                    />
                </label>
                <div className="truncate text-[10px] text-stone-400 dark:text-stone-500" title={healthUrl}>
                    {healthUrl || t("canvas.service.noTarget")}
                </div>
                {status === "failed" && error ? (
                    <div className="truncate text-[11px] text-red-500" title={error}>
                        {error}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

export function serviceNodeDefinition(): CanvasNodeDefinition {
    return {
        type: SERVICE_NODE_TYPE,
        title: i18n.t("canvas.nodeTypes.service"),
        icon: <Activity className="size-4" />,
        description: i18n.t("canvas.service.description"),
        minimapColor: "#0ea5e9",
        defaultSize: { width: 320, height: 240 },
        defaultMetadata: { service: { healthPath: "/" } },
        hidePanel: true,
        Content: ({ ctx }) => <ServiceNodeView ctx={ctx} />,
    };
}

let registered = false;
export function registerServiceNode() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions([serviceNodeDefinition()], "builtin");
}
