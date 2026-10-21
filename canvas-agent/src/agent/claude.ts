import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";

import { AGENT_PROMPT } from "../config.js";
import { createAgentLogWriter } from "../utils/agent-runtime.js";
import { errorMessage } from "../utils/value.js";
import { claudeThreadStore } from "./claude-threads.js";
import type { AgentEmit, AgentPermissionMode } from "./types.js";

/** 一次 Claude 轮次的输入。threadId 为空表示新建线程。 */
export type ClaudeTurnInput = { threadId: string; prompt: string; cwd?: string; permissionMode?: AgentPermissionMode; model?: string };

/** Claude 侧可识别的模型清单（CLI 侧仍会校验，这里只用于 UI 下拉）。 */
export const CLAUDE_MODELS = [
    { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", isDefault: true },
    { id: "claude-opus-4-1", displayName: "Claude Opus 4.1" },
    { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
];

/** 归一化后的 Claude 事件，供 emit 与单测共用。 */
export type ClaudeParsedEvent =
    | { kind: "session"; sessionId: string }
    | { kind: "delta"; text: string }
    | { kind: "text"; text: string }
    | { kind: "tool"; name: string; input?: unknown }
    | { kind: "result"; text: string; usage?: { input: number; cached: number; output: number }; sessionId?: string; isError?: boolean };

const permissionFlags: Record<AgentPermissionMode, string[]> = {
    request: ["--permission-mode", "default"],
    automatic: ["--permission-mode", "acceptEdits"],
    full: ["--permission-mode", "bypassPermissions"],
};

const running = new Map<string, ChildProcess>();

/**
 * 解析一行 `claude --output-format stream-json` 输出。
 * 未知行返回空数组——Claude CLI 的字段会随版本增减，解析器必须容忍。
 */
export function parseClaudeLine(line: string): ClaudeParsedEvent[] {
    let payload: unknown;
    try {
        payload = JSON.parse(line);
    } catch {
        return [];
    }
    if (!payload || typeof payload !== "object") return [];
    const record = payload as Record<string, unknown>;
    const events: ClaudeParsedEvent[] = [];
    const sessionId = typeof record.session_id === "string" ? record.session_id : undefined;

    if (record.type === "system" && record.subtype === "init" && sessionId) events.push({ kind: "session", sessionId });

    if (record.type === "stream_event") {
        const streamEvent = record.event as Record<string, unknown> | undefined;
        const delta = streamEvent?.delta as Record<string, unknown> | undefined;
        if (streamEvent?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
            events.push({ kind: "delta", text: delta.text });
        }
    }

    if (record.type === "assistant") {
        const message = record.message as Record<string, unknown> | undefined;
        const content = Array.isArray(message?.content) ? message?.content : [];
        for (const block of content) {
            const item = block as Record<string, unknown>;
            if (item?.type === "text" && typeof item.text === "string" && item.text.trim()) events.push({ kind: "text", text: item.text });
            if (item?.type === "tool_use" && typeof item.name === "string") events.push({ kind: "tool", name: item.name, input: item.input });
        }
    }

    if (record.type === "result") {
        const usage = record.usage as Record<string, unknown> | undefined;
        events.push({
            kind: "result",
            text: typeof record.result === "string" ? record.result : "",
            sessionId,
            isError: record.is_error === true || record.subtype === "error",
            usage: usage
                ? {
                      input: Number(usage.input_tokens) || 0,
                      cached: Number(usage.cache_read_input_tokens) || 0,
                      output: Number(usage.output_tokens) || 0,
                  }
                : undefined,
        });
    }

    return events;
}

/** 跑一轮 Claude：写入用户消息、启动 CLI、把事件转给 SSE、结束时落盘助手消息。 */
export function runClaudeTurn(input: ClaudeTurnInput, emit: AgentEmit, spawnImpl: typeof spawn = spawn): boolean {
    const prompt = input.prompt.trim();
    if (!prompt) {
        emit("agent_error", { message: "prompt required" });
        return false;
    }
    const thread = (input.threadId ? claudeThreadStore.get(input.threadId) : undefined) ?? claudeThreadStore.create({ cwd: input.cwd });
    if (!thread) {
        emit("agent_error", { message: `unknown thread: ${input.threadId}` });
        return false;
    }
    const threadId = thread.id;
    claudeThreadStore.append(threadId, { role: "user", text: prompt });

    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--allowedTools", "mcp__canvasagents__*"];
    if (input.model) args.push("--model", input.model);
    args.push(...(permissionFlags[input.permissionMode ?? "request"] ?? permissionFlags.request));
    if (thread.sessionId) args.push("--resume", thread.sessionId);
    args.push(`${AGENT_PROMPT}\n\n用户请求：${prompt}`);

    let child: ChildProcess;
    try {
        child = spawnImpl("claude", args, { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", windowsHide: true });
    } catch (error) {
        emit("agent_error", { message: errorMessage(error), threadId });
        return false;
    }
    running.set(threadId, child);
    emit("agent_event", { agent: "claude", type: "turn.started", threadId });

    const stderr = createAgentLogWriter((text) => emit("agent_log", { text }));
    let buffer = "";
    let finalText = "";

    child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
            if (!line.trim()) continue;
            for (const event of parseClaudeLine(line)) {
                if (event.kind === "session") claudeThreadStore.touch(threadId, { sessionId: event.sessionId });
                if (event.kind === "delta") emit("agent_event", { agent: "claude", type: "assistant_delta", threadId, text: event.text });
                if (event.kind === "text") {
                    finalText = event.text;
                    emit("agent_event", { agent: "claude", type: "assistant_message", threadId, text: event.text });
                }
                if (event.kind === "tool") emit("agent_event", { agent: "claude", type: "tool_use", threadId, name: event.name, input: event.input });
                if (event.kind === "result") {
                    if (event.sessionId) claudeThreadStore.touch(threadId, { sessionId: event.sessionId });
                    if (event.text) finalText = event.text;
                    if (event.usage) emit("agent_event", { agent: "claude", type: "usage.updated", threadId, usage: event.usage });
                }
            }
        }
    });

    child.stderr?.on("data", (chunk: Buffer) => stderr.write(chunk.toString()));

    child.on("error", (error) => {
        stderr.flush();
        running.delete(threadId);
        emit("agent_error", { message: error.message, threadId });
    });

    child.on("close", (code) => {
        stderr.flush();
        running.delete(threadId);
        if (finalText.trim()) claudeThreadStore.append(threadId, { role: "assistant", text: finalText });
        emit("agent_done", { agent: "claude", threadId, code: code ?? 0 });
    });

    return true;
}

/** 中断某个线程正在跑的轮次；没有在跑则返回 false。 */
export function interruptClaudeTurn(threadId: string): boolean {
    const child = running.get(threadId);
    if (!child) return false;
    child.kill("SIGTERM");
    running.delete(threadId);
    return true;
}

/** 是否有线程正在运行（队列视图据此显示状态）。 */
export function claudeRunningThreadIds(): string[] {
    return [...running.keys()];
}
