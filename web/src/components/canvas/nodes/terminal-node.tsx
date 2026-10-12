// M2: terminal window node. Talks to canvas-agent /terminal/ws; the backend side
// owns a pty-bridge process re-attached to a persistent macOS screen session, so
// terminals survive agent restarts and page reloads. Session id lives in node
// metadata (terminalSession) and is namespaced per canvas (canvas-<id>-<n>).
import { useEffect, useMemo, useRef, useState } from "react";

import { SquareTerminal } from "lucide-react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import i18n from "@/i18n";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { useAgentStore } from "@/stores/use-agent-store";
import type { CanvasNodeContext, CanvasNodeDefinition } from "@/types/canvas-plugin";

export const TERMINAL_NODE_TYPE = "terminal";

type TerminalStatus = "connecting" | "live" | "closed" | "error";

function wsBase(url: string, token: string) {
    try {
        const base = new URL(url, window.location.origin);
        const protocol = base.protocol === "https:" ? "wss:" : "ws:";
        return `${protocol}//${base.host}/terminal/ws?token=${encodeURIComponent(token)}`;
    } catch {
        return "";
    }
}

async function createSession(canvasId: string, url: string, token: string) {
    const response = await fetch(`${url.replace(/\/$/, "")}/terminal/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-canvas-agent-token": token },
        body: JSON.stringify({ canvasId }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { ok?: boolean; id?: string };
    if (!data.ok || !data.id) throw new Error("no session id");
    return data.id;
}

function TerminalView({ ctx }: { ctx: CanvasNodeContext }) {
    const { t } = useTranslation();
    const { id: routeId } = useParams<{ id?: string }>();
    const canvasId = routeId || "";
    const agentUrl = useAgentStore((state) => state.url);
    const agentToken = useAgentStore((state) => state.token);
    const hostRef = useRef<HTMLDivElement | null>(null);
    const socketRef = useRef<WebSocket | null>(null);
    const [session, setSession] = useState(() => String(ctx.node.metadata?.terminalSession || ""));
    const [status, setStatus] = useState<TerminalStatus>("connecting");
    const [error, setError] = useState("");
    const [attempt, setAttempt] = useState(0);
    const base = useMemo(() => wsBase(agentUrl, agentToken), [agentUrl, agentToken]);

    const startSession = async () => {
        setStatus("connecting");
        setError("");
        try {
            const id = await createSession(canvasId, agentUrl, agentToken);
            ctx.updateMetadata({ terminalSession: id });
            setSession(id);
        } catch (cause) {
            setStatus("error");
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    useEffect(() => {
        const host = hostRef.current;
        if (!host || !base) return;
        let disposed = false;
        let socket: WebSocket | null = null;
        const term = new Terminal({
            cursorBlink: true,
            fontSize: 12,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            scrollback: 5000,
            theme: { background: "#101010", foreground: "#e6e2d8", cursor: "#e6e2d8" },
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(host);

        const report = (cols: number, rows: number) => {
            if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols, rows }));
        };
        const observer = new ResizeObserver(() => {
            try {
                fit.fit();
                report(term.cols, term.rows);
            } catch {
                // host not measurable yet
            }
        });
        observer.observe(host);
        const initialFit = window.setTimeout(() => {
            try {
                fit.fit();
            } catch {
                // ignore first-pass fit failures
            }
        }, 50);

        term.onData((data) => {
            if (socket && socket.readyState === WebSocket.OPEN) socket.send(data);
        });

        const connect = () => {
            if (disposed || !session) return;
            socket = new WebSocket(`${base}&session=${encodeURIComponent(session)}`);
            socket.binaryType = "arraybuffer";
            socketRef.current = socket;
            socket.onopen = () => {
                if (disposed) return;
                setStatus("live");
                try {
                    fit.fit();
                } catch {
                    // ignore
                }
                report(term.cols, term.rows);
                term.focus();
            };
            socket.onmessage = (event) => {
                const text = String(event.data);
                if (text.startsWith("{") && text.includes('"type"')) {
                    try {
                        const frame = JSON.parse(text) as { type?: string; message?: string; reason?: string };
                        if (frame.type === "attached") setStatus("live");
                        if (frame.type === "error") setError(String(frame.message || "terminal error"));
                        if (frame.type === "exit") {
                            setStatus("closed");
                            if (frame.reason === "killed") term.reset();
                        }
                        return;
                    } catch {
                        // not a control frame
                    }
                }
                term.write(typeof event.data === "string" ? text : new Uint8Array(event.data as ArrayBuffer));
            };
            socket.onclose = () => {
                if (!disposed) setStatus((current) => (current === "live" ? "closed" : current));
            };
            socket.onerror = () => {
                if (!disposed) setStatus((current) => (current === "live" ? "closed" : "error"));
            };
        };

        if (session) connect();
        else void startSession();

        return () => {
            disposed = true;
            window.clearTimeout(initialFit);
            observer.disconnect();
            socket?.close();
            socketRef.current = null;
            term.dispose();
        };
        // Reconnect deliberately on session, endpoint, or attempt change; startSession drives retry via session updates.
    }, [base, session, attempt]);

    return (
        <div className="relative flex h-full w-full flex-col overflow-hidden bg-[#101010]">
            <div ref={hostRef} className="min-h-0 flex-1 px-2 py-1" />
            {status !== "live" ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#101010]/85 text-xs text-stone-300">
                    {status === "connecting" ? <span>{t("canvas.terminal.connecting")}</span> : null}
                    {status === "closed" ? (
                        <>
                            <span>{t("canvas.terminal.closed")}</span>
                            <div className="flex gap-2">
                                <button type="button" onClick={() => { setStatus("connecting"); setAttempt((value) => value + 1); }} className="rounded border border-stone-600 px-2 py-1 text-stone-200 hover:bg-stone-800">
                                    {t("canvas.terminal.reconnect")}
                                </button>
                                <button type="button" onClick={() => { ctx.updateMetadata({ terminalSession: "" }); setSession(""); setStatus("connecting"); }} className="rounded border border-stone-600 px-2 py-1 text-stone-200 hover:bg-stone-800">
                                    {t("canvas.terminal.newSession")}
                                </button>
                            </div>
                        </>
                    ) : null}
                    {status === "error" ? (
                        <>
                            <span>{error || t("canvas.terminal.error")}</span>
                            <button type="button" onClick={() => { setStatus("connecting"); if (session) setAttempt((value) => value + 1); else void startSession(); }} className="rounded border border-stone-600 px-2 py-1 text-stone-200 hover:bg-stone-800">
                                {t("canvas.terminal.retry")}
                            </button>
                        </>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

export function terminalNodeDefinition(): CanvasNodeDefinition {
    return {
        type: TERMINAL_NODE_TYPE,
        title: i18n.t("canvas.nodeTypes.terminal"),
        icon: <SquareTerminal className="size-4" />,
        description: i18n.t("canvas.terminal.description"),
        minimapColor: "#22c55e",
        defaultSize: { width: 560, height: 380 },
        defaultMetadata: {},
        hasSourceHandle: false,
        hidePanel: true,
        interactionToggle: true,
        forceInteractive: () => true,
        Content: ({ ctx }) => <TerminalView ctx={ctx} />,
    };
}

let registered = false;
export function registerTerminalNode() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions([terminalNodeDefinition()], "builtin");
}
