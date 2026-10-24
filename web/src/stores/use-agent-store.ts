import { create } from "zustand";
import i18n from "@/i18n";

import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import {
    AGENT_WINDOWS_STORAGE_KEY,
    AGENT_WINDOW_LIMIT,
    appendAgentWindow,
    bumpUnread,
    bumpUnreadOnce,
    clearUnread,
    closeAgentWindowWithFallback,
    createAgentWindow,
    deriveWindowStatus,
    nextActiveIdAfterClose,
    nextWindowNumber,
    parsePersistedWindows,
    projectPersistedWindows,
    updateAgentWindow,
    withAppendedChatItem,
    withAppendedEventLog,
    type AgentWindow,
    type AgentWindowStatus,
} from "@/lib/agent/agent-windows";

export { AGENT_WINDOW_LIMIT };
export type { AgentWindow, AgentWindowStatus };

export type AgentChatRole = "user" | "assistant" | "system" | "tool" | "error";
export type AgentAttachment = { id: string; name: string; type: string; size: number; width: number; height: number; url: string; dataUrl: string };
export type AgentMessageAttachment = Pick<AgentAttachment, "id" | "name" | "url"> & Partial<Pick<AgentAttachment, "type" | "size" | "width" | "height" | "dataUrl">>;
export type AgentCanvasReference = Pick<CanvasResourceReference, "nodeId" | "label" | "title" | "kind" | "previewUrl" | "text">;
export type AgentSkillReference = { name: string; path: string; displayName?: string };
export type AgentChatItem = { id: string; itemId?: string; clientMessageId?: string; threadId?: string; turnId?: string; role: AgentChatRole; title?: string; text: string; meta?: string; detail?: unknown; attachments?: AgentMessageAttachment[]; canvasReferences?: AgentCanvasReference[]; skill?: AgentSkillReference; streamId?: string; activityItems?: Record<string, string> };
export type AgentEventLog = { id: string; time: string; title: string; text: string; raw?: unknown };
export type AgentPendingToolCall = { requestId: string; name: string; input?: { ops?: CanvasAgentOp[]; path?: string } & Record<string, unknown> };
export type AgentPermissionMode = "request" | "automatic" | "full";
export type AgentReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type AgentModel = {
    id: string;
    model: string;
    displayName: string;
    defaultReasoningEffort: AgentReasoningEffort;
    supportedReasoningEfforts: Array<{ reasoningEffort: AgentReasoningEffort; description?: string }>;
    isDefault?: boolean;
};
export type AgentApprovalDecision = "accept" | "acceptForSession" | "decline";
export type AgentPendingApproval = { requestId: string; method: string; threadId?: string; turnId?: string; itemId?: string; reason?: string; command?: unknown; cwd?: string; grantRoot?: string; networkApprovalContext?: unknown; permissions?: unknown; deciding?: AgentApprovalDecision };
export type AgentCanvasContext = { snapshot: CanvasAgentSnapshot; applyOps: (ops?: CanvasAgentOp[]) => CanvasAgentSnapshot; undoOps: () => CanvasAgentSnapshot | null; canUndo: boolean; focusNode?: (nodeId: string) => void };
export type AgentThreadSummary = { id: string; preview: string; name?: string | null; cwd?: string; status?: string; source?: unknown; createdAt?: number; updatedAt?: number };
export type AgentTokenUsage = { input: number; cached: number; output: number };
export type AgentBootstrapStatus = { key: string; text: string; detail: string; status: "running" | "ready" | "error" };
export type AgentConversationState = {
    revision: number;
    conversationId: string;
    threadId: string;
    status: "idle" | "preparing" | "ready" | "warning" | "running" | "failed";
    mcpStatuses: Record<string, { status: "starting" | "ready" | "failed" | "cancelled"; error?: string | null; failureReason?: string | null }>;
    sourceClientId?: string;
    error?: string;
};
export type AgentPanelTab = "chat" | "setup" | "history" | "skills" | "log" | "wall";

/** 预览层确认后的待发送内容：文本是用户在预览层里编辑过的最终版本。 */
export type AgentFeedSendRequest = { text: string; windowId: string; at: number };

/**
 * 「一条会话一份」的字段：这些字段的读写都会落到当前激活的会话窗上，
 * 其余字段（连接、模型、面板尺寸等）保持全局共享。
 */
export const AGENT_WINDOW_FIELDS = [
    "messages",
    "eventLogs",
    "attachments",
    "canvasReferences",
    "conversation",
    "threads",
    "activeThreadId",
    "activeTurnId",
    "workspacePath",
    "tokenUsage",
    "pendingTool",
    "pendingApprovals",
    "bootstrapStatus",
    "mcpStartupStatuses",
    "loadingThreads",
    "activity",
    "sending",
    "waiting",
    "queued",
    "cliMode",
    "cliSession",
    "worktreePath",
] as const;
export type AgentWindowField = (typeof AGENT_WINDOW_FIELDS)[number];

const CONNECT_TIMEOUT_MS = 6000;
let agentSource: EventSource | null = null;
let connectTimer: ReturnType<typeof setTimeout> | null = null;
let windowSequence = 0;

function createWindowId(): string {
    windowSequence += 1;
    return `win-${Date.now().toString(36)}-${windowSequence.toString(36)}`;
}

function defaultWindowTitle(index: number): string {
    return i18n.t("agent.window.defaultTitle", { index });
}

function createDefaultWindow(titleIndex: number): AgentWindow {
    return createAgentWindow({ id: createWindowId(), title: defaultWindowTitle(titleIndex), activity: i18n.t("agent.state.ready") });
}

type AgentStore = {
    width: number;
    panelOpen: boolean;
    panelMounted: boolean;
    panelClosing: boolean;
    canvasContext: AgentCanvasContext | null;
    url: string;
    token: string;
    connected: boolean;
    enabled: boolean;
    silentConnect: boolean;
    fragmentBootstrap: boolean;
    prompt: string;
    attachments: AgentAttachment[];
    canvasReferences: CanvasResourceReference[];
    sending: boolean;
    waiting: boolean;
    queued: boolean;
    messages: AgentChatItem[];
    tokenUsage: AgentTokenUsage | null;
    eventLogs: AgentEventLog[];
    threads: AgentThreadSummary[];
    activeThreadId: string;
    activeTurnId: string;
    workspacePath: string;
    loadingThreads: boolean;
    activeTab: AgentPanelTab;
    confirmTools: boolean;
    permissionMode: AgentPermissionMode;
    models: AgentModel[];
    model: string;
    reasoningEffort: AgentReasoningEffort | "";
    activity: string;
    conversation: AgentConversationState;
    bootstrapStatus: AgentBootstrapStatus | null;
    mcpStartupStatuses: Record<string, AgentBootstrapStatus>;
    connectError: string;
    pendingTool: AgentPendingToolCall | null;
    pendingApprovals: AgentPendingApproval[];
    /** C3 投喂预览：预览层点「发送」时排给面板的一次发送请求（画布侧不复制发送逻辑）。 */
    feedSendRequest: AgentFeedSendRequest | null;
    cliMode: boolean;
    cliSession: string;
    worktreePath: string;
    queueOpen: boolean;
    windows: AgentWindow[];
    activeWindowId: string;
    setAgentState: (patch: Partial<Omit<AgentStore, "noteWindowOutput" | "setAgentState" | "connectAgent" | "disconnectAgent" | "addMessage" | "addEventLog" | "clearEventLogs" | "openPanel" | "closePanel" | "togglePanel" | "setCanvasContext" | "windows" | "activeWindowId" | "addWindow" | "removeWindow" | "selectWindow" | "renameWindow">>) => void;
    openPanel: () => void;
    closePanel: () => void;
    togglePanel: () => void;
    setCanvasContext: (context: AgentCanvasContext | null) => void;
    connectAgent: (options?: { silent?: boolean }) => void;
    disconnectAgent: (patch?: Partial<Omit<AgentStore, "noteWindowOutput" | "setAgentState" | "connectAgent" | "disconnectAgent" | "addMessage" | "addEventLog" | "clearEventLogs" | "openPanel" | "closePanel" | "togglePanel" | "setCanvasContext" | "windows" | "activeWindowId" | "addWindow" | "removeWindow" | "selectWindow" | "renameWindow">>) => void;
    addMessage: (item: AgentChatItem) => void;
    addEventLog: (item: AgentEventLog) => void;
    clearEventLogs: () => void;
    addWindow: () => boolean;
    removeWindow: (id: string) => void;
    selectWindow: (id: string) => void;
    requestFeedSend: (input: { text: string; windowId: string }) => void;
    clearFeedSend: () => void;
    renameWindow: (id: string, title: string) => void;
    noteWindowOutput: (windowId: string, dedupeKey?: string) => void;
};

export const CANVAS_AGENT_PANEL_MOTION_MS = 500;

function activeAgentWindow(state: Pick<AgentStore, "windows" | "activeWindowId">): AgentWindow | undefined {
    return state.windows.find((window) => window.id === state.activeWindowId) ?? state.windows[0];
}

/**
 * 取指定会话窗切片。找不到就返回 undefined —— 后台写入路径必须放弃写入，
 * 绝不能回退激活窗（回退就是把后台窗内容写进当前窗的直接原因）。
 */
export function agentWindowById(state: Pick<AgentStore, "windows" | "activeWindowId">, windowId: string): AgentWindow | undefined {
    return state.windows.find((window) => window.id === windowId);
}

/**
 * 按线程反查会话窗：会话线程 conversation.threadId 或当前线程 activeThreadId 命中即返回该窗 id。
 * 未知线程返回 null。多个窗撞同一线程（历史脏数据）时只认激活窗；
 * 激活窗不在其中则视为无归属，宁可不写也不并发写多个窗。
 */
export function agentWindowIdForThread(state: Pick<AgentStore, "windows"> & { activeWindowId?: string }, threadId: string): string | null {
    if (!threadId) return null;
    const matches = state.windows.filter((window) => window.conversation.threadId === threadId || window.activeThreadId === threadId);
    if (matches.length === 1) return matches[0].id;
    if (!matches.length) return null;
    return matches.find((window) => window.id === state.activeWindowId)?.id ?? null;
}

/**
 * 会话状态归属哪一窗：threadId 优先；其次显式指定的偏好窗；再次唯一持有该 conversationId 的窗；
 * 都没有才落到激活窗。返回值至多一个窗，保证一次状态更新不会同时写多个窗。
 */
export function agentWindowIdForConversation(
    state: Pick<AgentStore, "windows" | "activeWindowId">,
    conversation: Pick<AgentConversationState, "threadId" | "conversationId"> | null | undefined,
    preferredWindowId = "",
): string | null {
    if (!conversation) return null;
    const byThread = agentWindowIdForThread(state, conversation.threadId);
    if (byThread) return byThread;
    if (preferredWindowId && state.windows.some((window) => window.id === preferredWindowId)) return preferredWindowId;
    const owners = conversation.conversationId
        ? state.windows.filter((window) => window.conversation.conversationId === conversation.conversationId)
        : [];
    if (owners.length === 1) return owners[0].id;
    if (owners.length > 1) return owners.find((window) => window.id === state.activeWindowId)?.id ?? null;
    return state.activeWindowId;
}

/** 临时指定 commitAgentPatch 的窗口级写目标（用于把后台事件写进非激活窗）。 */
let windowPatchTargetId: string | null = null;

export function withWindowPatchTarget<T>(windowId: string, run: () => T): T {
    const previous = windowPatchTargetId;
    windowPatchTargetId = windowId;
    try {
        return run();
    } finally {
        windowPatchTargetId = previous;
    }
}

function projectAgentWindow(window: AgentWindow): Pick<AgentStore, AgentWindowField> {
    const projected: Record<string, unknown> = {};
    for (const field of AGENT_WINDOW_FIELDS) projected[field] = window[field];
    return projected as unknown as Pick<AgentStore, AgentWindowField>;
}

/** 把一次扁平 patch 拆成 per-window 与全局两半：per-window 的写进激活窗，再投影回来。 */
function commitAgentPatch(state: AgentStore, patch: Record<string, unknown>): Partial<AgentStore> {
    const windowPatch: Record<string, unknown> = {};
    const globalPatch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
        if ((AGENT_WINDOW_FIELDS as readonly string[]).includes(key)) windowPatch[key] = value;
        else globalPatch[key] = value;
    }
    if (!Object.keys(windowPatch).length) return globalPatch as Partial<AgentStore>;
    // 目标窗：显式指定（后台事件写非激活窗）时取该窗，否则沿用当前激活窗。
    const targeted = windowPatchTargetId ? state.windows.find((window) => window.id === windowPatchTargetId) : undefined;
    // 显式指定了目标窗却找不到（窗口已被关掉）：放弃窗口级写入，绝不回退激活窗。
    if (windowPatchTargetId && !targeted) return globalPatch as Partial<AgentStore>;
    const target = targeted ?? activeAgentWindow(state);
    // 没有窗口时（理论上不会发生）退回直接写，保证不会丢数据。
    if (!target) return { ...globalPatch, ...patch } as Partial<AgentStore>;
    const patched: AgentWindow = { ...target, ...windowPatch } as AgentWindow;
    patched.status = deriveWindowStatus(patched);
    const windows = updateAgentWindow(state.windows, target.id, patched);
    // 写非激活窗时只更新 windows 数组，不投影扁平字段，避免污染当前激活窗。
    if (target.id !== state.activeWindowId) return { ...globalPatch, windows } as Partial<AgentStore>;
    const next = windows.find((window) => window.id === target.id) ?? patched;
    return { ...globalPatch, windows, ...projectAgentWindow(next) } as Partial<AgentStore>;
}

function patchActiveWindow(state: AgentStore, evolve: (window: AgentWindow) => AgentWindow): Partial<AgentStore> {
    // 与 commitAgentPatch 一致：显式指定目标窗（后台事件）时写该窗；找不到目标窗就放弃。
    const targeted = windowPatchTargetId ? state.windows.find((window) => window.id === windowPatchTargetId) : undefined;
    if (windowPatchTargetId && !targeted) return {};
    const active = targeted ?? activeAgentWindow(state);
    if (!active) return {};
    const patched = evolve(active);
    const windows = updateAgentWindow(state.windows, active.id, patched);
    if (active.id !== state.activeWindowId) return { windows };
    return { windows, ...projectAgentWindow(patched) } as Partial<AgentStore>;
}

const initialWindow = createDefaultWindow(1);
// 刷新恢复窗口布局（只恢复骨架：几个窗、各叫什么、CLI 形态；消息内容不落盘）。
const persistedWindows = typeof window === "undefined" ? null : parsePersistedWindows(localStorage.getItem(AGENT_WINDOWS_STORAGE_KEY));
const bootstrapWindows = persistedWindows?.windows ?? [initialWindow];
const bootstrapActiveWindow = bootstrapWindows.find((window) => window.id === persistedWindows?.activeWindowId) ?? bootstrapWindows[0];

export const useAgentStore = create<AgentStore>((set, get) => ({
    width: typeof window === "undefined" ? 440 : Number(localStorage.getItem("canvas-agent-panel-width")) || 440,
    panelOpen: false,
    panelMounted: true,
    panelClosing: false,
    canvasContext: null,
    url: typeof window === "undefined" ? "http://127.0.0.1:17371" : localStorage.getItem("canvas-agent-url") || "http://127.0.0.1:17371",
    token: typeof window === "undefined" ? "" : localStorage.getItem("canvas-agent-token") || "",
    connected: false,
    enabled: false,
    silentConnect: false,
    fragmentBootstrap: false,
    prompt: "",
    feedSendRequest: null,
    activeTab: "setup",
    confirmTools: false,
    permissionMode: typeof window === "undefined" ? "request" : (localStorage.getItem("canvas-agent-permission-mode") as AgentPermissionMode) || "request",
    models: [],
    model: typeof window === "undefined" ? "" : localStorage.getItem("canvas-agent-model") || "",
    reasoningEffort: typeof window === "undefined" ? "" : (localStorage.getItem("canvas-agent-reasoning-effort") as AgentReasoningEffort) || "",
    connectError: "",
    queueOpen: false,
    windows: bootstrapWindows,
    activeWindowId: bootstrapActiveWindow.id,
    ...projectAgentWindow(bootstrapActiveWindow),
    setAgentState: (patch) => set((state) => commitAgentPatch(state, patch as Record<string, unknown>)),
    openPanel: () => set({ panelOpen: true, panelMounted: true, panelClosing: false }),
    closePanel: () => {
        if (!get().panelMounted || get().panelClosing) return;
        set({ panelOpen: false, panelClosing: true });
        setTimeout(() => {
            if (get().panelClosing) set({ panelClosing: false });
        }, CANVAS_AGENT_PANEL_MOTION_MS);
    },
    togglePanel: () => (get().panelOpen ? get().closePanel() : get().openPanel()),
    setCanvasContext: (canvasContext) => set({ canvasContext }),
    connectAgent: (options) => {
        const silent = options?.silent ?? false;
        const endpoint = get().url.trim().replace(/\/$/, "");
        const token = get().token.trim();
        if (!endpoint || !token) return set({ connectError: silent ? "" : i18n.t("agent.state.connectionRequired") });
        try {
            const parsed = new URL(endpoint);
            if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
        } catch {
            return set({ connectError: silent ? "" : i18n.t("agent.state.invalidUrl") });
        }
        localStorage.setItem("canvas-agent-url", endpoint);
        localStorage.setItem("canvas-agent-token", token);
        // Only set enabled here; LocalAgentPanel's effect owns SSE initialization.
        set((state) => commitAgentPatch(state, { url: endpoint, token, enabled: true, silentConnect: silent, fragmentBootstrap: false, activity: i18n.t("agent.status.connecting"), connectError: "" }));
    },
    disconnectAgent: (patch = {}) => {
        agentSource?.close();
        agentSource = null;
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null;
        set((state) => {
            const next = commitAgentPatch(state, {
                enabled: false,
                connected: false,
                silentConnect: false,
                fragmentBootstrap: false,
                activity: i18n.t("agent.state.offline"),
                conversation: { revision: 0, conversationId: "", threadId: "", status: "idle", mcpStatuses: {} },
                bootstrapStatus: null,
                mcpStartupStatuses: {},
                ...(patch as Record<string, unknown>),
            });
            return next;
        });
    },
    addMessage: (item) => set((state) => patchActiveWindow(state, (window) => withAppendedChatItem(window, item, true))),
    addEventLog: (item) => set((state) => patchActiveWindow(state, (window) => withAppendedEventLog(window, item))),
    clearEventLogs: () => set((state) => patchActiveWindow(state, (window) => ({ ...window, eventLogs: [] }))),
    addWindow: () => {
        const state = get();
        const fresh = createDefaultWindow(nextWindowNumber(state.windows));
        const { windows, ok } = appendAgentWindow(state.windows, fresh);
        if (!ok) return false;
        set({ windows, activeWindowId: fresh.id, ...projectAgentWindow(fresh) });
        return true;
    },
    removeWindow: (id) => set((state) => {
        const fallback = createDefaultWindow(nextWindowNumber(state.windows.filter((window) => window.id !== id)));
        const windows = closeAgentWindowWithFallback(state.windows, id, () => fallback);
        const wasActive = state.activeWindowId === id;
        const nextActiveId = wasActive ? nextActiveIdAfterClose(state.windows, id, state.activeWindowId) : state.activeWindowId;
        const resolved = windows.find((window) => window.id === nextActiveId) ?? windows[0];
        return { windows, activeWindowId: resolved.id, ...projectAgentWindow(resolved) };
    }),
    requestFeedSend: ({ text, windowId }) => set((state) => {
        // queued 与 status 必须同时更新：只改 queued 的话，读 window.status 的地方（队列/断言）
        // 会把「排队中」的窗当成空闲。
        const markQueued = (list: AgentWindow[], id: string, queued: boolean) => list.map((window) => (
            window.id === id ? { ...window, queued, status: deriveWindowStatus({ ...window, queued }) } : window
        ));
        const queued = markQueued(state.windows, windowId, true);
        // 上一条排队换个目标窗时，旧窗不能再挂着 queued 标记。
        const previousWindowId = state.feedSendRequest?.windowId || "";
        const windows = previousWindowId && previousWindowId !== windowId ? markQueued(queued, previousWindowId, false) : queued;
        return { windows, feedSendRequest: { text, windowId, at: Date.now() } };
    }),
    clearFeedSend: () => set((state) => {
        const windowId = state.feedSendRequest?.windowId || "";
        if (!windowId) return { feedSendRequest: null };
        const windows = state.windows.map((window) => (
            window.id === windowId ? { ...window, queued: false, status: deriveWindowStatus({ ...window, queued: false }) } : window
        ));
        return { windows, feedSendRequest: null };
    }),
    selectWindow: (id) => set((state) => {
        if (!state.windows.some((window) => window.id === id)) return {};
        const windows = clearUnread(state.windows, id);
        const resolved = windows.find((window) => window.id === id);
        if (!resolved) return {};
        return { windows, activeWindowId: id, ...projectAgentWindow(resolved) };
    }),
    renameWindow: (id, title) => set((state) => ({ windows: updateAgentWindow(state.windows, id, { title: title.trim() || defaultWindowTitle(1) }) })),
    // 后台窗产生输出：只给非激活窗累加未读，激活窗的消息本来就在眼前。
    noteWindowOutput: (windowId, dedupeKey) => set((state) => {
        if (windowId === state.activeWindowId) return {};
        const windows = dedupeKey ? bumpUnreadOnce(state.windows, windowId, dedupeKey) : bumpUnread(state.windows, windowId);
        if (windows === state.windows) return {};
        return { windows };
    }),
}));

// 窗口布局变化即落盘（只落骨架：id/标题/CLI 形态），刷新后按原样恢复，不再回到单窗。
// 注意：流式 token 会让 windows 数组每帧换新，所以用投影串做比对，只有布局真变了才写 localStorage。
if (typeof window !== "undefined") {
    let lastPersistedWindows = "";
    useAgentStore.subscribe((state, previous) => {
        if (state.windows === previous.windows && state.activeWindowId === previous.activeWindowId) return;
        const next = JSON.stringify(projectPersistedWindows(state.windows, state.activeWindowId));
        if (next === lastPersistedWindows) return;
        lastPersistedWindows = next;
        try {
            localStorage.setItem(AGENT_WINDOWS_STORAGE_KEY, next);
        } catch (error) {
            // localStorage 不可用或超配额：布局持久化失败不影响当前会话，记录后继续。
            void error;
        }
    });
}
