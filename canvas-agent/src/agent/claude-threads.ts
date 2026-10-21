import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { CONFIG_DIR } from "../config.js";

/** Claude 会话里的一条消息（只存展示所需的最小字段）。 */
export type ClaudeThreadMessage = { role: "user" | "assistant"; text: string; at: number };

/** Claude 线程：与 Codex 线程同级的会话对象，额外记录 CLI 的 sessionId 以便 --resume。 */
export type ClaudeThread = {
    id: string;
    name?: string;
    preview: string;
    cwd?: string;
    createdAt: number;
    updatedAt: number;
    sessionId?: string;
    messages: ClaudeThreadMessage[];
};

export type ClaudeThreadSummary = Pick<ClaudeThread, "id" | "name" | "preview" | "cwd" | "createdAt" | "updatedAt">;

export type ClaudeThreadStoreOptions = { filePath: string; now?: () => number; maxThreads?: number };

const DEFAULT_MAX_THREADS = 80;
const PREVIEW_LIMIT = 80;

/**
 * Claude 线程存储。Codex 的线程历史由 Codex 自己保存，Claude CLI 每次 `-p` 都是新进程，
 * 所以线程元数据与消息摘要必须由我们自己落盘，否则切换 driver 就只剩一段空白。
 */
export function createClaudeThreadStore(options: ClaudeThreadStoreOptions) {
    const now = options.now ?? (() => Date.now());
    const maxThreads = options.maxThreads ?? DEFAULT_MAX_THREADS;
    let threads: ClaudeThread[] = load();

    function load(): ClaudeThread[] {
        try {
            const raw = fs.readFileSync(options.filePath, "utf8");
            const parsed = JSON.parse(raw) as unknown;
            if (!Array.isArray(parsed)) return [];
            return parsed.filter(isThread).map((thread) => ({ ...thread, messages: thread.messages.filter(isMessage) }));
        } catch {
            return [];
        }
    }

    function persist() {
        try {
            fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
            const temp = `${options.filePath}.tmp`;
            fs.writeFileSync(temp, JSON.stringify(threads.slice(0, maxThreads), null, 2), "utf8");
            fs.renameSync(temp, options.filePath);
        } catch {
            // 落盘失败不影响本次会话可用性；下次写入会再试。
        }
    }

    function create(input: { name?: string; cwd?: string } = {}): ClaudeThread {
        const at = now();
        const thread: ClaudeThread = {
            id: `cl-${randomUUID()}`,
            name: input.name?.trim() || undefined,
            preview: "",
            cwd: input.cwd,
            createdAt: at,
            updatedAt: at,
            messages: [],
        };
        threads.unshift(thread);
        threads = threads.slice(0, maxThreads);
        persist();
        return thread;
    }

    function get(id: string): ClaudeThread | undefined {
        return threads.find((thread) => thread.id === id);
    }

    function touch(id: string, patch: Partial<Pick<ClaudeThread, "name" | "cwd" | "sessionId">> = {}): ClaudeThread | undefined {
        const thread = get(id);
        if (!thread) return undefined;
        if (patch.name !== undefined) thread.name = patch.name.trim() || undefined;
        if (patch.cwd !== undefined) thread.cwd = patch.cwd;
        if (patch.sessionId !== undefined) thread.sessionId = patch.sessionId;
        thread.updatedAt = now();
        persist();
        return thread;
    }

    function append(id: string, message: Omit<ClaudeThreadMessage, "at"> & { at?: number }): ClaudeThread | undefined {
        const thread = get(id);
        if (!thread) return undefined;
        const entry: ClaudeThreadMessage = { role: message.role, text: message.text, at: message.at ?? now() };
        thread.messages.push(entry);
        if (!thread.preview && entry.role === "user") thread.preview = entry.text.slice(0, PREVIEW_LIMIT);
        thread.updatedAt = entry.at;
        persist();
        return thread;
    }

    function remove(id: string): boolean {
        const before = threads.length;
        threads = threads.filter((thread) => thread.id !== id);
        if (threads.length === before) return false;
        persist();
        return true;
    }

    function list(): ClaudeThreadSummary[] {
        return [...threads]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(({ id, name, preview, cwd, createdAt, updatedAt }) => ({ id, name, preview, cwd, createdAt, updatedAt }));
    }

    function reset(next: ClaudeThread[] = []) {
        threads = next;
        persist();
    }

    return { create, get, touch, append, remove, list, reset };
}

export type ClaudeThreadStore = ReturnType<typeof createClaudeThreadStore>;

export const claudeThreadStore = createClaudeThreadStore({ filePath: path.join(CONFIG_DIR, "claude-threads.json") });

function isThread(value: unknown): value is ClaudeThread {
    if (!value || typeof value !== "object") return false;
    const thread = value as Record<string, unknown>;
    return typeof thread.id === "string" && typeof thread.createdAt === "number" && typeof thread.updatedAt === "number" && Array.isArray(thread.messages);
}

function isMessage(value: unknown): value is ClaudeThreadMessage {
    if (!value || typeof value !== "object") return false;
    const message = value as Record<string, unknown>;
    return (message.role === "user" || message.role === "assistant") && typeof message.text === "string" && typeof message.at === "number";
}
