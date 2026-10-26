import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";

import { AGENT_PROMPT } from "../config.js";
import { createAgentLogWriter } from "../utils/agent-runtime.js";
import { errorMessage } from "../utils/value.js";
import { opencodeThreadStore } from "./opencode-threads.js";
import type { AgentEmit, AgentPermissionMode } from "./types.js";

/** 一次 OpenCode 轮次的输入。threadId 为空表示新建线程。 */
export type OpencodeTurnInput = { threadId: string; prompt: string; cwd?: string; permissionMode?: AgentPermissionMode; model?: string };

/**
 * OpenCode 的模型清单由本机 `opencode models` 决定，桥端不维护第二份权威列表；
 * 需要选模型时直接把 `provider/model` 传给 CLI，这里只给一个空列表表示「不预设」。
 */
export const OPENCODE_MODELS: Array<{ id: string; displayName: string; isDefault?: boolean }> = [];

/** 归一化后的 OpenCode 事件。CLI 的 JSON 事件会随版本增减，解析器必须容忍未知类型。 */
export type OpencodeParsedEvent =
    | { kind: "session"; sessionId: string }
    | { kind: "delta"; text: string }
    | { kind: "text"; text: string }
    | { kind: "tool"; name: string; input?: unknown }
    | { kind: "usage"; usage: { input: number; cached: number; output: number } }
    | { kind: "error"; message: string };

/**
 * 解析一行 `opencode run --format json` 输出。
 * 已知形状：`{"type":"error","sessionID":"ses_…","error":{"data":{"message":"…"}}}`；
 * 其余类型按字段名做保守映射，未知行返回空数组。
 */
export function parseOpencodeLine(line: string): OpencodeParsedEvent[] {
    let payload: unknown;
    try {
        payload = JSON.parse(line);
    } catch {
        return [];
    }
    if (!payload || typeof payload !== "object") return [];
    const record = payload as Record<string, unknown>;
    const events: OpencodeParsedEvent[] = [];
    const sessionId = typeof record.sessionID === "string" ? record.sessionID : typeof record.session_id === "string" ? record.session_id : undefined;
    if (sessionId) events.push({ kind: "session", sessionId });

    const type = typeof record.type === "string" ? record.type : "";
    if (type === "error") {
        const error = record.error as Record<string, unknown> | undefined;
        const data = error?.data as Record<string, unknown> | undefined;
        const message = (typeof data?.message === "string" && data.message) || (typeof error?.message === "string" && error.message) || "opencode error";
        events.push({ kind: "error", message });
        return events;
    }

    const text = typeof record.text === "string" ? record.text : typeof (record.part as Record<string, unknown> | undefined)?.text === "string" ? String((record.part as Record<string, unknown>).text) : "";
    if (type.includes("delta") && text) events.push({ kind: "delta", text });
    else if (text) events.push({ kind: "text", text });

    if (type.includes("tool")) {
        const name = typeof record.name === "string" ? record.name : typeof (record.part as Record<string, unknown> | undefined)?.tool === "string" ? String((record.part as Record<string, unknown>).tool) : "tool";
        events.push({ kind: "tool", name, input: record.input });
    }

    const tokens = record.tokens as Record<string, unknown> | undefined;
    if (tokens && typeof tokens.input === "number") {
        events.push({ kind: "usage", usage: { input: Number(tokens.input) || 0, cached: Number(tokens.cache?.toString?.() ?? 0) || 0, output: Number(tokens.output) || 0 } });
    }
    return events;
}

const running = new Map<string, ChildProcess>();

/** 权限模式 → CLI 参数。OpenCode 只有「自动批准」一档，其余交给它自己的默认策略。 */
function permissionArgs(mode: AgentPermissionMode | undefined) {
    return mode === "full" || mode === "automatic" ? ["--auto"] : [];
}

export function runOpencodeTurn(input: OpencodeTurnInput, emit: AgentEmit, spawnImpl: typeof spawn = spawn): boolean {
    const prompt = input.prompt.trim();
    if (!prompt) {
        emit("agent_error", { message: "prompt required" });
        return false;
    }
    const thread = (input.threadId ? opencodeThreadStore.get(input.threadId) : undefined) ?? opencodeThreadStore.create({ cwd: input.cwd });
    const threadId = thread.id;
    opencodeThreadStore.append(threadId, { role: "user", text: prompt });

    const args = ["run", "--format", "json"];
    if (input.model) args.push("--model", input.model);
    if (input.cwd) args.push("--dir", input.cwd);
    if (thread.sessionId) args.push("--session", thread.sessionId);
    args.push(...permissionArgs(input.permissionMode));
    args.push(`${AGENT_PROMPT}\n\n用户请求：${prompt}`);

    let child: ChildProcess;
    try {
        child = spawnImpl("opencode", args, { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", windowsHide: true });
    } catch (error) {
        emit("agent_error", { message: errorMessage(error), threadId });
        return false;
    }
    running.set(threadId, child);
    emit("agent_event", { agent: "opencode", type: "turn.started", threadId });

    const stderr = createAgentLogWriter((text) => emit("agent_log", { text }));
    let buffer = "";
    let finalText = "";
    let sawError = false;

    child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
            if (!line.trim()) continue;
            for (const event of parseOpencodeLine(line)) {
                if (event.kind === "session") opencodeThreadStore.touch(threadId, { sessionId: event.sessionId });
                if (event.kind === "delta") emit("agent_event", { agent: "opencode", type: "assistant_delta", threadId, text: event.text });
                if (event.kind === "text") {
                    finalText = event.text;
                    emit("agent_event", { agent: "opencode", type: "assistant_message", threadId, text: event.text });
                }
                if (event.kind === "tool") emit("agent_event", { agent: "opencode", type: "tool_use", threadId, name: event.name, input: event.input });
                if (event.kind === "usage") emit("agent_event", { agent: "opencode", type: "usage.updated", threadId, usage: event.usage });
                if (event.kind === "error") {
                    sawError = true;
                    // 未登录时 OpenCode 只回一个通用 UnknownError；把原始信息透传，别假装成功。
                    emit("agent_error", { message: event.message, threadId });
                }
            }
        }
    });

    child.stderr?.on("data", (chunk: Buffer) => stderr.write(chunk.toString()));
    child.on("error", (error) => {
        stderr.flush();
        running.delete(threadId);
        emit("agent_error", { message: errorMessage(error), threadId });
    });
    child.on("close", (code) => {
        stderr.flush();
        running.delete(threadId);
        if (finalText) opencodeThreadStore.append(threadId, { role: "assistant", text: finalText });
        if (code !== 0 && !sawError) emit("agent_error", { message: `opencode exited with code ${code}`, threadId });
        emit("agent_event", { agent: "opencode", type: "turn.completed", threadId, code });
    });
    return true;
}

export function interruptOpencodeTurn(threadId: string): boolean {
    const child = running.get(threadId);
    if (!child) return false;
    child.kill("SIGTERM");
    running.delete(threadId);
    return true;
}

export function opencodeRunningThreadIds(): string[] {
    return [...running.keys()];
}
