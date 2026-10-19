import type { AgentAttachment, AgentBootstrapStatus, AgentChatItem, AgentConversationState, AgentEventLog, AgentPendingApproval, AgentPendingToolCall, AgentThreadSummary, AgentTokenUsage } from "@/stores/use-agent-store";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

/** 面板同时最多容纳的会话窗数量（与 ⌘1..9 快捷键位数一致）。 */
export const AGENT_WINDOW_LIMIT = 9;
/** 会话窗布局的持久化键：只存窗口骨架（编号/标题/CLI 形态），不存消息内容。 */
export const AGENT_WINDOWS_STORAGE_KEY = "canvas-agent-windows";
/** 每个窗口保留的操作日志条数上限（沿用改造前的全局上限）。 */
export const AGENT_WINDOW_EVENT_LOG_LIMIT = 160;
/** 每个窗口保留的未读去重键数量上限（防止长会话无限增长）。 */
export const AGENT_WINDOW_UNREAD_KEY_LIMIT = 200;

export type AgentWindowStatus = "idle" | "running" | "error";

/**
 * 一个会话窗的完整切片。凡是「一条会话一份」的状态都放这里，
 * 由 use-agent-store 投影到扁平字段上，保证单窗口行为与改造前一致。
 */
export type AgentWindow = {
    id: string;
    title: string;
    status: AgentWindowStatus;
    unread: number;
    /** 已经计过未读的 turn/消息键，保证一次回复只 +1（流式 delta 不计数）。 */
    unreadKeys: string[];
    messages: AgentChatItem[];
    eventLogs: AgentEventLog[];
    attachments: AgentAttachment[];
    canvasReferences: CanvasResourceReference[];
    conversation: AgentConversationState;
    threads: AgentThreadSummary[];
    activeThreadId: string;
    activeTurnId: string;
    workspacePath: string;
    tokenUsage: AgentTokenUsage | null;
    pendingTool: AgentPendingToolCall | null;
    pendingApprovals: AgentPendingApproval[];
    bootstrapStatus: AgentBootstrapStatus | null;
    mcpStartupStatuses: Record<string, AgentBootstrapStatus>;
    loadingThreads: boolean;
    activity: string;
    sending: boolean;
    waiting: boolean;
    /** G-CLI：该会话窗的呈现形态；true = 内嵌终端（CLI），false = 对话（GUI）。 */
    cliMode: boolean;
    /** CLI 形态复用的终端会话 id（持久化后可跨刷新/切模式续上同一 shell）。 */
    cliSession: string;
};

export function emptyAgentConversation(): AgentConversationState {
    return { revision: 0, conversationId: "", threadId: "", status: "idle", mcpStatuses: {} };
}

/** 空白会话窗的默认切片（纯函数，不读 store / localStorage）。 */
export function createAgentWindow(patch: Partial<AgentWindow> & { id: string; title: string }): AgentWindow {
    return {
        status: "idle",
        unread: 0,
        unreadKeys: [],
        messages: [],
        eventLogs: [],
        attachments: [],
        canvasReferences: [],
        conversation: emptyAgentConversation(),
        threads: [],
        activeThreadId: "",
        activeTurnId: "",
        workspacePath: "",
        tokenUsage: null,
        pendingTool: null,
        pendingApprovals: [],
        bootstrapStatus: null,
        mcpStartupStatuses: {},
        loadingThreads: false,
        activity: "",
        sending: false,
        waiting: false,
        cliMode: false,
        cliSession: "",
        ...patch,
    };
}

/** 追加一个窗口；到上限返回原列表 + ok:false（不静默丢弃）。 */
export function appendAgentWindow(list: AgentWindow[], window: AgentWindow): { windows: AgentWindow[]; ok: boolean; reason?: "limit" } {
    if (list.length >= AGENT_WINDOW_LIMIT) return { windows: list, ok: false, reason: "limit" };
    return { windows: [...list, window], ok: true };
}

export function updateAgentWindow(list: AgentWindow[], id: string, patch: Partial<AgentWindow>): AgentWindow[] {
    return list.map((window) => (window.id === id ? { ...window, ...patch } : window));
}

export function findAgentWindow(list: AgentWindow[], id: string): AgentWindow | undefined {
    return list.find((window) => window.id === id);
}

/** 纯删除（可能返回空列表，补位由 closeAgentWindowWithFallback 负责）。 */
export function closeAgentWindow(list: AgentWindow[], id: string): AgentWindow[] {
    return list.filter((window) => window.id !== id);
}

/** 关闭窗口；关掉最后一个时用 createFallback 补一个空白窗，面板不会变成零窗口。 */
export function closeAgentWindowWithFallback(list: AgentWindow[], id: string, createFallback: () => AgentWindow): AgentWindow[] {
    const remaining = closeAgentWindow(list, id);
    return remaining.length ? remaining : [createFallback()];
}

/** 关闭后的选中规则：关的不是当前窗则保持当前窗；关的是当前窗则选右邻，无右邻退左邻。 */
export function nextActiveIdAfterClose(list: AgentWindow[], closedId: string, activeId: string): string {
    const remaining = closeAgentWindow(list, closedId);
    if (!remaining.length) return "";
    if (activeId && activeId !== closedId && remaining.some((window) => window.id === activeId)) return activeId;
    const index = list.findIndex((window) => window.id === closedId);
    const right = remaining[index];
    return (right ?? remaining[remaining.length - 1]).id;
}

export function clearUnread(list: AgentWindow[], id: string): AgentWindow[] {
    const target = findAgentWindow(list, id);
    if (!target || target.unread === 0) return list;
    return updateAgentWindow(list, id, { unread: 0 });
}

export function bumpUnread(list: AgentWindow[], id: string, delta = 1): AgentWindow[] {
    const target = findAgentWindow(list, id);
    if (!target) return list;
    return updateAgentWindow(list, id, { unread: Math.max(0, target.unread + delta) });
}

/**
 * 按事件去重累加未读：同一个 turn / 同一条消息只 +1。
 * key 为空时退化为普通累加（调用方不应在流式 delta 上调用它）。
 */
export function bumpUnreadOnce(list: AgentWindow[], id: string, key: string): AgentWindow[] {
    const target = findAgentWindow(list, id);
    if (!target) return list;
    if (target.unreadKeys.includes(key)) return list;
    return updateAgentWindow(list, id, {
        unread: Math.max(0, target.unread + 1),
        unreadKeys: [...target.unreadKeys, key].slice(-AGENT_WINDOW_UNREAD_KEY_LIMIT),
    });
}

/**
 * 后台事件是否应该让该窗未读 +1：只有一条 assistant 消息或一个 turn 收尾时返回去重键，
 * 流式 delta（item.updated / 增量文本）返回 null，避免一次回复涨几十个红点。
 */
export function backgroundUnreadKey(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") return null;
    const chat = payload as { message?: { id?: string; role?: string } };
    if (chat.message && typeof chat.message === "object") {
        return chat.message.role === "assistant" && chat.message.id ? `message:${chat.message.id}` : null;
    }
    const event = payload as { type?: string; threadId?: string; thread_id?: string; turnId?: string; turn_id?: string };
    if (event.type === "turn.completed") return `turn:${event.threadId || event.thread_id || ""}:${event.turnId || event.turn_id || "final"}`;
    return null;
}

/** 收到消息：激活窗视为已读，非激活窗累加未读。 */
export function withAppendedChatItem(window: AgentWindow, item: AgentChatItem, active: boolean): AgentWindow {
    return { ...window, messages: [...window.messages, item], unread: active ? 0 : window.unread + 1 };
}

/** 操作日志按窗口截断（与改造前全局 160 条一致）。 */
export function withAppendedEventLog(window: AgentWindow, item: AgentEventLog, limit = AGENT_WINDOW_EVENT_LOG_LIMIT): AgentWindow {
    return { ...window, eventLogs: [...window.eventLogs, item].slice(-limit) };
}

/** 由发送/等待状态推导窗口状态，驱动 tab 上的转圈 / 红点。 */
export function deriveWindowStatus(window: Pick<AgentWindow, "status" | "sending" | "waiting">): AgentWindowStatus {
    if (window.status === "error") return "error";
    return window.sending || window.waiting ? "running" : "idle";
}

/** tab 文案：`1: 标题`（下标从 1 开始）。 */
export function toWindowTabLabel(window: Pick<AgentWindow, "title">, index: number): string {
    return `${index + 1}: ${window.title}`;
}

/**
 * 下一个可用的默认窗口编号：取现有标题里最小的未占用正整数。
 * 关掉中间某个窗口后再点 `+`，不会生成重名 tab（旧实现按窗口数量算，会撞名）。
 */
export function nextWindowNumber(list: AgentWindow[]): number {
    const used = new Set<number>();
    for (const window of list) {
        const match = /(\d+)\s*$/.exec(window.title.trim());
        if (match) used.add(Number(match[1]));
    }
    let index = 1;
    while (used.has(index)) index += 1;
    return index;
}

/** 可持久化的窗口骨架：刻意不含 messages / attachments / conversation，避免体积与隐私面扩大。 */
export type PersistedAgentWindow = Pick<AgentWindow, "id" | "title" | "cliMode" | "cliSession">;

/** 把当前窗口列表投影成可写盘的最小结构（刷新后能恢复「几个窗、各叫什么、什么形态」）。 */
export function projectPersistedWindows(windows: AgentWindow[], activeWindowId: string): { activeWindowId: string; windows: PersistedAgentWindow[] } {
    return {
        activeWindowId,
        windows: windows.map(({ id, title, cliMode, cliSession }) => ({ id, title, cliMode, cliSession })),
    };
}

/**
 * 从 localStorage 原始串恢复窗口骨架：坏数据、超上限、重复 id 一律丢弃并回退，
 * 保证刷新永远不会因为一份脏数据把面板卡成零窗口。
 */
export function parsePersistedWindows(raw: string | null | undefined): { windows: AgentWindow[]; activeWindowId: string } | null {
    if (!raw) return null;
    let data: unknown;
    try {
        data = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const value = data as { activeWindowId?: unknown; windows?: unknown };
    if (!Array.isArray(value.windows)) return null;
    const seen = new Set<string>();
    const windows: AgentWindow[] = [];
    for (const item of value.windows) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const entry = item as Record<string, unknown>;
        const id = typeof entry.id === "string" ? entry.id.trim() : "";
        const title = typeof entry.title === "string" ? entry.title.trim() : "";
        if (!id || !title || seen.has(id)) continue;
        seen.add(id);
        windows.push(createAgentWindow({
            id,
            title,
            cliMode: entry.cliMode === true,
            cliSession: typeof entry.cliSession === "string" ? entry.cliSession : "",
        }));
        if (windows.length >= AGENT_WINDOW_LIMIT) break;
    }
    if (!windows.length) return null;
    const requested = typeof value.activeWindowId === "string" ? value.activeWindowId : "";
    return { windows, activeWindowId: seen.has(requested) ? requested : windows[0].id };
}
