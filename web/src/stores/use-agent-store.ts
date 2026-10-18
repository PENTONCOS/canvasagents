import { create } from "zustand";
import i18n from "@/i18n";

import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import {
    AGENT_WINDOW_LIMIT,
    appendAgentWindow,
    clearUnread,
    closeAgentWindowWithFallback,
    createAgentWindow,
    deriveWindowStatus,
    nextActiveIdAfterClose,
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
export type AgentCanvasContext = { snapshot: CanvasAgentSnapshot; applyOps: (ops?: CanvasAgentOp[]) => CanvasAgentSnapshot; undoOps: () => CanvasAgentSnapshot | null; canUndo: boolean };
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
    queueOpen: boolean;
    windows: AgentWindow[];
    activeWindowId: string;
    setAgentState: (patch: Partial<Omit<AgentStore, "setAgentState" | "connectAgent" | "disconnectAgent" | "addMessage" | "addEventLog" | "clearEventLogs" | "openPanel" | "closePanel" | "togglePanel" | "setCanvasContext" | "windows" | "activeWindowId" | "addWindow" | "removeWindow" | "selectWindow" | "renameWindow">>) => void;
    openPanel: () => void;
    closePanel: () => void;
    togglePanel: () => void;
    setCanvasContext: (context: AgentCanvasContext | null) => void;
    connectAgent: (options?: { silent?: boolean }) => void;
    disconnectAgent: (patch?: Partial<Omit<AgentStore, "setAgentState" | "connectAgent" | "disconnectAgent" | "addMessage" | "addEventLog" | "clearEventLogs" | "openPanel" | "closePanel" | "togglePanel" | "setCanvasContext" | "windows" | "activeWindowId" | "addWindow" | "removeWindow" | "selectWindow" | "renameWindow">>) => void;
    addMessage: (item: AgentChatItem) => void;
    addEventLog: (item: AgentEventLog) => void;
    clearEventLogs: () => void;
    addWindow: () => boolean;
    removeWindow: (id: string) => void;
    selectWindow: (id: string) => void;
    renameWindow: (id: string, title: string) => void;
};

export const CANVAS_AGENT_PANEL_MOTION_MS = 500;

function activeAgentWindow(state: Pick<AgentStore, "windows" | "activeWindowId">): AgentWindow | undefined {
    return state.windows.find((window) => window.id === state.activeWindowId) ?? state.windows[0];
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
    const active = activeAgentWindow(state);
    // 没有窗口时（理论上不会发生）退回直接写，保证不会丢数据。
    if (!active) return { ...globalPatch, ...patch } as Partial<AgentStore>;
    const patched: AgentWindow = { ...active, ...windowPatch } as AgentWindow;
    patched.status = deriveWindowStatus(patched);
    const windows = updateAgentWindow(state.windows, active.id, patched);
    const next = windows.find((window) => window.id === active.id) ?? patched;
    return { ...globalPatch, windows, ...projectAgentWindow(next) } as Partial<AgentStore>;
}

function patchActiveWindow(state: AgentStore, evolve: (window: AgentWindow) => AgentWindow): Partial<AgentStore> {
    const active = activeAgentWindow(state);
    if (!active) return {};
    const patched = evolve(active);
    const windows = updateAgentWindow(state.windows, active.id, patched);
    return { windows, ...projectAgentWindow(patched) } as Partial<AgentStore>;
}

const initialWindow = createDefaultWindow(1);

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
    activeTab: "setup",
    confirmTools: false,
    permissionMode: typeof window === "undefined" ? "request" : (localStorage.getItem("canvas-agent-permission-mode") as AgentPermissionMode) || "request",
    models: [],
    model: typeof window === "undefined" ? "" : localStorage.getItem("canvas-agent-model") || "",
    reasoningEffort: typeof window === "undefined" ? "" : (localStorage.getItem("canvas-agent-reasoning-effort") as AgentReasoningEffort) || "",
    connectError: "",
    queueOpen: false,
    windows: [initialWindow],
    activeWindowId: initialWindow.id,
    ...projectAgentWindow(initialWindow),
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
        const fresh = createDefaultWindow(state.windows.length + 1);
        const { windows, ok } = appendAgentWindow(state.windows, fresh);
        if (!ok) return false;
        set({ windows, activeWindowId: fresh.id, ...projectAgentWindow(fresh) });
        return true;
    },
    removeWindow: (id) => set((state) => {
        const fallback = createDefaultWindow(Math.max(1, state.windows.length));
        const windows = closeAgentWindowWithFallback(state.windows, id, () => fallback);
        const wasActive = state.activeWindowId === id;
        const nextActiveId = wasActive ? nextActiveIdAfterClose(state.windows, id, state.activeWindowId) : state.activeWindowId;
        const resolved = windows.find((window) => window.id === nextActiveId) ?? windows[0];
        return { windows, activeWindowId: resolved.id, ...projectAgentWindow(resolved) };
    }),
    selectWindow: (id) => set((state) => {
        if (!state.windows.some((window) => window.id === id)) return {};
        const windows = clearUnread(state.windows, id);
        const resolved = windows.find((window) => window.id === id);
        if (!resolved) return {};
        return { windows, activeWindowId: id, ...projectAgentWindow(resolved) };
    }),
    renameWindow: (id, title) => set((state) => ({ windows: updateAgentWindow(state.windows, id, { title: title.trim() || defaultWindowTitle(1) }) })),
}));
