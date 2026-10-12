// M2: 内置终端服务。pty-bridge（bin/pty-bridge，forkpty 实现）负责创建/重连
// macOS screen 会话；ws 在浏览器 xterm 客户端与 pty 之间推流。会话名
// canvas-<canvasId>-<n> 在 screen 中存活，agent 重启后可透明重连。
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";

import { logger } from "../utils/logger.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = process.env.PTY_BRIDGE_PATH || path.join(moduleDir, "..", "..", "bin", "pty-bridge");
const SCREEN_PATH = process.env.SCREEN_PATH || "/usr/bin/screen";
const SCROLLBACK_LIMIT = 200_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export type TerminalInfo = { id: string; canvasId: string; attached: boolean; alive: boolean };

type TerminalSession = {
    id: string;
    canvasId: string;
    proc: ChildProcess | null;
    /** fd3 resize 控制通道（bridge 约定），spawn 后赋值。 */
    controlFd: NodeJS.WritableStream | null;
    /** 主动 detach 造成的退出不清理会话（screen 仍在后台）。 */
    detaching: boolean;
    lastSize: { cols: number; rows: number };
    scrollback: Buffer;
    clients: Set<WebSocket>;
};

function sessionName(canvasId: string, index: number) {
    return canvasId ? `canvas-${canvasId}-${index}` : `canvas-tty-${randomBytes(4).toString("hex")}`;
}

function parseSessionName(name: string) {
    const numbered = /^canvas-(.+)-(\d+)$/.exec(name);
    if (numbered?.[1]) return { canvasId: numbered[1] };
    if (name.startsWith("canvas-tty-")) return { canvasId: "" };
    return { canvasId: name.startsWith("canvas-") ? name.slice("canvas-".length) : name };
}

function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** screen 守护进程与 bridge 生命周期解耦：独立创建 detached 会话，bridge 之后用 -x 挂接。 */
function spawnScreenDaemon(id: string) {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(SCREEN_PATH, ["-dmS", id, process.env.SHELL || "/bin/zsh"], {
            stdio: "ignore",
            env: { ...process.env, TERM: "xterm-256color" },
        });
        child.once("exit", (code) => {
            if (code === 0) setTimeout(resolve, 200);
            else reject(new Error(`screen -dmS exited ${code}`));
        });
        child.once("error", reject);
    });
}

/** 列出当前存活的 screen 会话名（macOS 会话清单可能打印在 stdout 或 stderr）。 */
function screenNames(): Promise<Set<string>> {
    return new Promise((resolve) => {
        const child = spawn(SCREEN_PATH, ["-ls"], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (chunk) => (out += String(chunk)));
        child.stderr.on("data", (chunk) => (out += String(chunk)));
        const finish = () => {
            const names = new Set<string>();
            for (const match of out.matchAll(/\d+\.(\S+)\s+\(/g)) names.add(match[1] || "");
            names.delete("");
            resolve(names);
        };
        child.once("exit", finish);
        child.once("error", () => resolve(new Set()));
    });
}

export function bridgeAvailable() {
    try {
        accessSync(BRIDGE_PATH, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

class TerminalManager {
    private readonly sessions = new Map<string, TerminalSession>();
    private readonly wss = new WebSocketServer({ noServer: true });

    async list(canvasId = "") {
        const alive = await screenNames();
        const result: TerminalInfo[] = [];
        for (const [id, session] of this.sessions) {
            if (canvasId && session.canvasId !== canvasId) continue;
            result.push({ id, canvasId: session.canvasId, attached: session.clients.size > 0, alive: alive.has(id) });
        }
        for (const name of alive) {
            if (!name.startsWith("canvas-") || result.some((item) => item.id === name)) continue;
            const parsed = parseSessionName(name);
            if (canvasId && parsed.canvasId !== canvasId) continue;
            result.push({ id: name, canvasId: parsed.canvasId, attached: false, alive: true });
        }
        return result;
    }

    async create(canvasId = "") {
        if (!bridgeAvailable()) throw new Error("pty-bridge 不可用（bin/pty-bridge 缺失或不可执行）");
        let lastError = new Error("session create failed");
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const names = await screenNames();
            let index = 1;
            while (canvasId && names.has(sessionName(canvasId, index))) index += 1;
            const id = sessionName(canvasId, index);
            try {
                await spawnScreenDaemon(id);
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                continue;
            }
            const session = this.register(id, canvasId);
            return { id: session.id, canvasId: session.canvasId };
        }
        throw lastError;
    }

    async remove(id: string) {
        const session = this.sessions.get(id);
        this.sendControl(id, { type: "exit", reason: "killed" });
        this.detach(session);
        this.sessions.delete(id);
        await new Promise<void>((resolve) => {
            const child = spawn(SCREEN_PATH, ["-S", id, "-X", "quit"], { stdio: "ignore" });
            child.once("exit", () => resolve());
            child.once("error", () => resolve());
        });
        this.sendControl(id, { type: "exit", reason: "killed" });
    }

    private register(id: string, canvasId: string) {
        const existing = this.sessions.get(id);
        if (existing) return existing;
        const session: TerminalSession = { id, canvasId, proc: null, controlFd: null, detaching: false, lastSize: { cols: 120, rows: 32 }, scrollback: Buffer.alloc(0), clients: new Set() };
        this.sessions.set(id, session);
        return session;
    }

    private detach(session: TerminalSession | undefined) {
        if (!session?.proc) return;
        session.detaching = true;
        session.controlFd = null;
        session.proc.kill("SIGKILL");
        session.proc = null;
    }

    private spawnBridge(session: TerminalSession) {
        const { cols, rows } = session.lastSize;
        const proc = spawn(BRIDGE_PATH, [String(cols), String(rows), "--", SCREEN_PATH, "-x", session.id], {
            env: { ...process.env, TERM: "xterm-256color" },
            stdio: ["pipe", "pipe", "pipe", "pipe"],
        });
        session.proc = proc;
        const controlFd = proc.stdio[3];
        if (controlFd && "write" in controlFd) session.controlFd = controlFd;
        proc.stdout?.on("data", (chunk: Buffer) => {
            session.scrollback = Buffer.concat([session.scrollback, chunk]).subarray(Math.max(0, session.scrollback.length + chunk.length - SCROLLBACK_LIMIT));
            for (const client of session.clients) if (client.readyState === WebSocket.OPEN) client.send(chunk);
        });
        proc.stderr?.on("data", (chunk: Buffer) => {
            const text = String(chunk);
            logger.warn("terminal bridge stderr", { id: session.id, text: text.slice(0, 200) });
            if (/attached|Cannot|No screen/i.test(text)) this.sendTo(session, { type: "error", message: text.trim().slice(0, 300) });
        });
        proc.once("exit", () => {
            session.proc = null;
            session.controlFd = null;
            if (session.detaching) {
                session.detaching = false;
                this.sendTo(session, { type: "detached" });
                return;
            }
            this.sessions.delete(session.id);
            this.sendTo(session, { type: "exit", reason: "process" });
        });
        return proc;
    }

    private sendTo(session: TerminalSession, payload: Record<string, unknown>) {
        const text = JSON.stringify(payload);
        for (const client of session.clients) if (client.readyState === WebSocket.OPEN) client.send(text);
    }

    /** exit 控制消息可能在会话已删除后发送，保留按 id 定位的广播。 */
    private sendControl(id: string, payload: Record<string, unknown>) {
        const session = this.sessions.get(id);
        if (session) this.sendTo(session, payload);
    }

    private feedInput(session: TerminalSession, data: Buffer) {
        const proc = session.proc;
        if (!proc?.stdin) return;
        proc.stdin.write(data);
    }

    private resize(session: TerminalSession, cols: number, rows: number) {
        if (!Number.isFinite(cols) && !Number.isFinite(rows)) return;
        session.lastSize = { cols: Math.max(2, Math.min(500, Math.floor(cols) || session.lastSize.cols)), rows: Math.max(2, Math.min(200, Math.floor(rows) || session.lastSize.rows)) };
        session.controlFd?.write(`${JSON.stringify({ cols: session.lastSize.cols, rows: session.lastSize.rows })}\n`);
    }

    attach(ws: WebSocket, rawId: string) {
        if (!bridgeAvailable()) {
            ws.close(1011, "pty-bridge unavailable");
            return;
        }
        const id = SESSION_ID_PATTERN.test(rawId) ? rawId : "";
        if (!id) {
            ws.close(1008, "invalid session id");
            return;
        }
        const session = this.sessions.get(id) || this.register(id, parseSessionName(id).canvasId);
        session.clients.add(ws);
        ws.on("close", () => {
            session.clients.delete(ws);
            // 所有客户端离开后保留 bridge 进程 30s 再 detach，避免快速刷新反复重建。
            setTimeout(() => {
                if (session.clients.size === 0 && session.proc) this.detach(session);
            }, 30_000);
        });
        ws.on("message", (data, isBinary) => {
            if (isBinary) {
                this.feedInput(session, data as Buffer);
                return;
            }
            const text = String(data);
            if (text.startsWith("{")) {
                try {
                    const frame = JSON.parse(text) as { type?: string; cols?: number; rows?: number };
                    if (frame.type === "resize" && typeof frame.cols === "number" && typeof frame.rows === "number") {
                        this.resize(session, frame.cols, frame.rows);
                        return;
                    }
                    if (frame.type === "ping") {
                        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "pong" }));
                        return;
                    }
                } catch {
                    // 非 JSON 控制帧，按普通输入处理。
                }
            }
            this.feedInput(session, Buffer.from(text, "utf8"));
        });
        // 重放历史输出，再确保 bridge 已连接。
        if (session.scrollback.length && ws.readyState === WebSocket.OPEN) ws.send(session.scrollback);
        this.sendTo(session, { type: "attached", id: session.id, clients: session.clients.size });
        if (!session.proc) this.spawnBridge(session);
    }

    /** 挂接到 HTTP server 的 upgrade 事件；/terminal/ws 之外的升级直接拒绝。 */
    registerHttp(server: Server, verify: (req: IncomingMessage, url: URL) => boolean) {
        server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
            const url = new URL(req.url || "/", "http://127.0.0.1");
            if (url.pathname !== "/terminal/ws") {
                socket.destroy();
                return;
            }
            if (!verify(req, url)) {
                socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
                socket.destroy();
                return;
            }
            this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, String(url.searchParams.get("session") || "")));
        });
    }
}

export const terminalManager = new TerminalManager();
