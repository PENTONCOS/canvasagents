import type { AgentAttachment, AgentBootstrapStatus, AgentChatItem, AgentConversationState, AgentEventLog, AgentPendingApproval, AgentPendingToolCall, AgentThreadSummary, AgentTokenUsage } from "@/stores/use-agent-store";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

/** 面板同时最多容纳的会话窗数量（与 ⌘1..9 快捷键位数一致）。 */
export const AGENT_WINDOW_LIMIT = 9;
/** 每个窗口保留的操作日志条数上限（沿用改造前的全局上限）。 */
export const AGENT_WINDOW_EVENT_LOG_LIMIT = 160;

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
};

export function emptyAgentConversation(): AgentConversationState {
    return { revision: 0, conversationId: "", threadId: "", status: "idle", mcpStatuses: {} };
}

/** 空白会话窗的默认切片（纯函数，不读 store / localStorage）。 */
export function createAgentWindow(patch: Partial<AgentWindow> & { id: string; title: string }): AgentWindow {
    return {
        status: "idle",
        unread: 0,
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
