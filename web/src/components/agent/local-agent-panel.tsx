import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Segmented, Tooltip } from "antd";
import dayjs from "dayjs";
import { Bot, History, Images, MessageSquare, MessageSquarePlus, PanelRightClose, PlugZap, Sparkles, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";

import { APP_ID } from "@/constant/brand";
import i18n from "@/i18n";
import { readAgentUrlBootstrap } from "@/lib/agent/agent-url-bootstrap";
import { canvasThemes } from "@/lib/canvas-theme";
import { upscaleDataUrl } from "@/lib/canvas/canvas-image-data";
import { imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { resolveCanvasReferenceImages } from "@/lib/canvas/canvas-resource-references";
import { readImageMeta } from "@/lib/image-utils";
import { randomId } from "@/lib/utils";
import { uploadImage } from "@/services/image-storage";
import { useThemeStore } from "@/stores/use-theme-store";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useDeliveryStore } from "@/stores/use-delivery-store";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { useShallow } from "zustand/react/shallow";
import { canSpendQuota, quotaMessageKey, quotaSnapshot } from "@/lib/agent/quota";
import { skillPromptPrefix } from "@/lib/agent/skill-bindings";
import { useAgentStore, type AgentAttachment, type AgentBootstrapStatus, type AgentCanvasContext, type AgentCanvasReference, type AgentChatItem, type AgentConversationState, type AgentModel, type AgentPendingApproval, type AgentPendingToolCall, type AgentPermissionMode, type AgentReasoningEffort, type AgentThreadSummary, agentWindowById, agentWindowIdForConversation, agentWindowIdForThread, withWindowPatchTarget } from "@/stores/use-agent-store";
import { backgroundUnreadKey } from "@/lib/agent/agent-windows";
import { needsThreadPrepare, threadResetRetryDelay } from "@/lib/agent/agent-thread-retry";
import { type CanvasAgentOp, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { referenceConnectionOps } from "@/lib/canvas/canvas-reference-links";
import { isSiteTool, runSiteTool } from "@/lib/agent/agent-site-tools";
import { acknowledgeCodexHistory, activateAgentClient, AgentApiError, discoverAgentConfig, fetchAgentJson, interruptCodexTurn, postCodexApproval, postState, postToolResult, requestAgentCaptureSilently } from "@/services/api/canvas-agent";
import { withAppendedEventLog } from "@/lib/agent/agent-windows";
import { AgentChatTimeline, AgentTaskProgress, AgentUsageBar } from "./agent-chat";
import { AgentContextBar } from "./agent-context-bar";
import { AgentChatComposer } from "./agent-chat-composer";
import { AgentConnectView } from "./agent-connect-view";
import {
    activityDeltaFallback,
    activityDetail,
    activityKind,
    activityPlaceholder,
    agentAttachmentToChatAttachment,
    agentErrorView,
    attachmentPayloadBytes,
    compactText,
    eventUsage,
    formatAgentActivity,
    formatAgentEvent,
    formatAgentEventLog,
    formatAgentPlan,
    formatBytes,
    bindPendingTurnMessages,
    isCanvasWriteTool,
    isConnectionErrorMessage,
    isReasoningSummary,
    mergeAgentMessages,
    mergeStreamText,
    normalizeHistoryMessages,
    normalizeText,
    parseEventData,
    promptWithAttachments,
    promptWithCanvasReferences,
    reasoningActivityText,
    registerLiveAgentTurn,
    scopeChatItem,
    stringText,
    toolName,
    turnPlanStatus,
    upsertAgentMessage,
    type AgentEventItem,
    type AgentEventPayload,
} from "./agent-event-formatters";
import { AgentHistoryView } from "./agent-history-view";
import { AgentLogView } from "./agent-log-view";
import { agentApiPath, getAgentDriver, setAgentDriver as persistAgentDriver, subscribeAgentDriver, type AgentDriverId } from "@/lib/agent/agent-driver";
import { AgentPanelTabs } from "./agent-panel-tabs";
import { AgentWindowTabs } from "./agent-window-tabs";
import { AgentRepoBadge } from "./agent-repo-badge";
import { AgentSkillsView } from "./agent-skills-view";
import { AgentWallView } from "./agent-wall-view";
import { EmbeddedTerminal } from "./embedded-terminal";

const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_PAYLOAD_BYTES = 28 * 1024 * 1024;
const MESSAGE_PREVIEW_LONG_EDGE = 192;
const MESSAGE_PREVIEW_MAX_LENGTH = 500_000;
const DEFAULT_AGENT_URL = "http://127.0.0.1:17371";
const AGENT_PROTOCOL_VERSION = 6;
const HISTORY_RETRY_DELAYS_MS = [0, 150, 350, 700, 1200];
const AGENT_REASONING_EFFORTS = new Set<AgentReasoningEffort>(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const rt = (key: string, options?: Record<string, unknown>) => i18n.t(`agent.runtime.${key}`, options);

type AgentWorkspace = { workspacePath: string; activeThreadId?: string };
type AgentThreadsResponse = { ok?: boolean; workspace?: AgentWorkspace; conversation?: AgentConversationState; data?: AgentThreadSummary[] };
type AgentThreadResponse = { ok?: boolean; workspace?: AgentWorkspace; conversation?: AgentConversationState; thread?: AgentThreadSummary; messages?: AgentChatItem[]; settledTurnIds?: string[]; historyReady?: boolean };
type AgentWorkspaceResponse = { ok?: boolean; workspace?: AgentWorkspace; conversation?: AgentConversationState };
type AgentTurnResponse = { ok?: boolean; threadId?: string };
type AgentModelsResponse = { ok?: boolean; data?: AgentModel[] };
type AgentCodexState = { busy?: boolean; threadId?: string; turnId?: string };
type AgentHelloEvent = { ok?: boolean; protocolVersion?: number; clientId?: string; workspace?: { activeThreadId?: string }; conversation?: AgentConversationState; codex?: AgentCodexState; pendingApprovals?: AgentPendingApproval[] };
type AgentWorkspaceEvent = { activeThreadId?: string; threadId?: string; sourceClientId?: string; emptyThread?: boolean; draftThread?: boolean; conversation?: AgentConversationState };
type AgentChatEvent = { threadId?: string; turnId?: string; sourceClientId?: string; replayed?: boolean; message?: AgentChatItem };
type AgentBootstrapEvent = { type?: "codex.preparing" | "codex.prepare_failed" | "mcp.startup" | "mcp.complete"; phase?: "preheat" | "runtime"; threadId?: string; name?: string; status?: "starting" | "ready" | "failed" | "cancelled"; error?: string | null; failureReason?: string | null };
type AgentClientGlobal = typeof globalThis & { __canvasAgentsClientIdPromise?: Promise<string> };

function authoritativeHistoryTurnKeys(threadId: string, settledTurnIds: string[]) {
    return new Set(settledTurnIds.map((turnId) => `${threadId}\0${turnId}`));
}

function agentErrorState(error: unknown) {
    return error instanceof AgentApiError ? (error.response as { state?: AgentConversationState }).state : undefined;
}

function conversationBootstrapView(conversation: AgentConversationState) {
    const mcpStartupStatuses: Record<string, AgentBootstrapStatus> = Object.fromEntries(Object.entries(conversation.mcpStatuses).map(([name, item]) => {
        const view: AgentBootstrapStatus = item.status === "starting"
            ? { key: `mcp:${name}:starting`, text: rt("mcpStarting", { name }), detail: rt("mcpConnecting"), status: "running" }
            : item.status === "ready"
                ? { key: `mcp:${name}:ready`, text: rt("mcpReadyNamed", { name }), detail: rt("toolsReady"), status: "ready" }
                : { key: `mcp:${name}:${item.status}`, text: rt(item.status === "failed" ? "mcpFailedNamed" : "mcpCanceledNamed", { name }), detail: item.error || rt("toolInitFailed"), status: "error" };
        return [name, view];
    }));
    const services = Object.values(mcpStartupStatuses);
    const pending = services.filter((item) => item.status === "running").length;
    const bootstrapStatus: AgentBootstrapStatus | null = conversation.status === "idle" || conversation.status === "preparing"
        ? services.length
            ? { key: "mcp:starting", text: rt("mcpServicesStarting"), detail: pending ? rt("toolServicesPending", { count: pending }) : rt("checkingToolServices"), status: "running" }
            : { key: "codex:preparing", text: rt("conversationInitializing"), detail: rt("conversationCreating"), status: "running" }
        : conversation.status === "warning"
            ? { key: "mcp:warning", text: rt("someMcpFailed"), detail: rt("remainingToolsReady"), status: "error" }
            : conversation.status === "failed"
                ? { key: "codex:prepare_failed", text: rt("conversationInitFailed"), detail: conversation.error || rt("conversationCreateFailed"), status: "error" }
                : conversation.status === "ready"
                    ? { key: "mcp:ready", text: rt("mcpServicesReady", { count: services.length }), detail: rt("toolsReady"), status: "ready" }
                    : null;
    return { bootstrapStatus, mcpStartupStatuses };
}

export function LocalAgentPanel({ embedded, headless, autoConnect }: { embedded?: boolean; headless?: boolean; autoConnect?: boolean }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { message, modal } = App.useApp();
    const { hash } = useLocation();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    // Field-level selectors with useShallow rerender only when these fields change.
    // canvasContext is intentionally excluded because project updates it every frame during dragging and resizing.
    // The panel uses it only for ref synchronization and debounced postState calls, never during rendering.
    // Subscribing here would rerender the panel every frame and amplify the #185 crash, so it is observed imperatively below.
    const { width, url, token, connected, enabled, prompt, attachments, sending, waiting, tokenUsage, eventLogs, threads, activeThreadId, workspacePath, loadingThreads, activeTab, confirmTools, permissionMode, models, model, reasoningEffort, activity, conversation, connectError, pendingTool, pendingApprovals, cliMode, cliSession, activeWindowId } = useAgentStore(
        useShallow((state) => ({
            width: state.width,
            url: state.url,
            token: state.token,
            connected: state.connected,
            enabled: state.enabled,
            prompt: state.prompt,
            attachments: state.attachments,
            sending: state.sending,
            waiting: state.waiting,
            tokenUsage: state.tokenUsage,
            eventLogs: state.eventLogs,
            threads: state.threads,
            activeThreadId: state.activeThreadId,
            workspacePath: state.workspacePath,
            loadingThreads: state.loadingThreads,
            activeTab: state.activeTab,
            confirmTools: state.confirmTools,
            permissionMode: state.permissionMode,
            models: state.models,
            model: state.model,
            reasoningEffort: state.reasoningEffort,
            activity: state.activity,
            conversation: state.conversation,
            connectError: state.connectError,
            pendingTool: state.pendingTool,
            pendingApprovals: state.pendingApprovals,
            cliMode: state.cliMode,
            cliSession: state.cliSession,
            activeWindowId: state.activeWindowId,
        })),
    );
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const conversationReady = conversation.status === "ready" || conversation.status === "warning";
    const conversationBusy = conversation.status === "preparing" || conversation.status === "running";
    const closePanel = useAgentStore((state) => state.closePanel);
    const pushMessage = useAgentStore((state) => state.addMessage);
    const pushEventLog = useAgentStore((state) => state.addEventLog);
    const clearEventLogs = useAgentStore((state) => state.clearEventLogs);
    const loadSkills = useAgentSkillStore((state) => state.loadSkills);
    const clearSkillSelection = useAgentSkillStore((state) => state.clearSelection);
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const skillCount = useAgentSkillStore((state) => state.skills.length);
    const messageCount = useAgentStore((state) => state.messages.length);
    const deliveryRunCount = useDeliveryStore((state) => Object.keys(state.runs).length);
    const quota = useMemo(() => quotaSnapshot(tokenUsage, deliveryRunCount), [tokenUsage, deliveryRunCount]);
    const quotaKey = quotaMessageKey(quota);
    const quotaText = quotaKey
        ? t(quotaKey, {
            used: quota.reason === "runs" ? quota.runsUsed : quota.tokensUsed,
            limit: quota.reason === "runs" ? quota.runsUsed + quota.runsRemaining : quota.tokensUsed + quota.tokensRemaining,
        })
        : "";
    const canvasContextRef = useRef<AgentCanvasContext | null>(useAgentStore.getState().canvasContext);
    const confirmToolsRef = useRef(confirmTools);
    const pendingToolRef = useRef<AgentPendingToolCall | null>(null);
    const autoConnectRef = useRef(false);
    const connectedRef = useRef(false);
    const errorLoggedRef = useRef(false);
    const attachmentUrlsRef = useRef(new Set<string>());
    const clientIdRef = useRef("");
    const turnReferenceNodeIdsRef = useRef<string[]>([]);
    const [clientReady, setClientReady] = useState(false);
    const [driverId, setDriverId] = useState<AgentDriverId>(getAgentDriver());
    const [drivers, setDrivers] = useState<Array<{ id: string; label: string; available: boolean; version?: string; error?: string }>>([]);
    const loadThreadsSequenceRef = useRef(0);
    /** 每个窗口还有几个历史加载在飞：被新一轮顶掉的请求也要收掉自己窗的 loadingThreads。 */
    const loadingThreadsPendingRef = useRef(new Map<string, number>());
    const loadThreadsRef = useRef<((skipHistory?: boolean) => Promise<void>) | null>(null);
    const threadMessagesRef = useRef(new Map<string, AgentChatItem[]>());
    const authoritativeHistoryTurnsRef = useRef(new Set<string>());
    const liveTurnKeysRef = useRef(new Set<string>());
    const threadOperationRef = useRef(0);
    const threadOperationSequenceRef = useRef(0);
    // 已经为该会话窗「成功」准备过对话线程的窗口 id：只记成功，失败时要能再次进入准备路径。
    const preparedWindowRef = useRef("");
    // 建线程重试：定时器 / 已完成尝试次数 / 当前等待重试的目标窗。
    const threadResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const threadResetAttemptRef = useRef(0);
    const threadResetTargetRef = useRef("");
    const runThreadResetRef = useRef<(windowId: string, attempt: number) => void>(() => undefined);
    const endpoint = useMemo(() => url.trim().replace(/\/$/, ""), [url]);
    useEffect(() => {
        return subscribeAgentDriver((next: AgentDriverId) => setDriverId(next));
    }, []);
    useEffect(() => {
        if (!connected || !endpoint || !token.trim()) return;
        let disposed = false;
        void fetchAgentJson<{ ok?: boolean; data?: Array<{ id: string; label: string; available: boolean; version?: string; error?: string }> }>(endpoint, token, "/agent/drivers")
            .then(({ data }) => { if (!disposed) setDrivers(data || []); })
            .catch(() => { if (!disposed) setDrivers([]); });
        return () => { disposed = true; };
    }, [connected, endpoint, token]);
    const urlAgentAutoConnect = searchParams.has("agentUrl") && searchParams.has("agentToken");
    useEffect(() => {
        let disposed = false;
        void acquireAgentClientId().then((clientId) => {
            if (!disposed) {
                clientIdRef.current = clientId;
                setClientReady(true);
            }
        });
        return () => { disposed = true; };
    }, []);
    const loadThreadSnapshot = useCallback(async (threadId: string, sequence: number, windowId: string, response?: AgentThreadResponse, expectedTurnId = "") => {
        let thread = response;
        let lastError: unknown;
        for (const delayMs of HISTORY_RETRY_DELAYS_MS) {
            if (delayMs) await delay(delayMs);
            if (sequence !== loadThreadsSequenceRef.current) return false;
            const windowAtStart = useAgentStore.getState().windows.find((window) => window.id === windowId);
            if (windowAtStart?.activeThreadId !== threadId) return false;
            try {
                thread ||= await fetchAgentJson<AgentThreadResponse>(endpoint, token, agentApiPath(`/threads/${encodeURIComponent(threadId)}`));
                lastError = undefined;
            } catch (error) {
                lastError = error;
                thread = undefined;
                continue;
            }
            const history = normalizeHistoryMessages(thread.messages || []);
            const latest = useAgentStore.getState().windows.find((window) => window.id === windowId);
            if (sequence !== loadThreadsSequenceRef.current || !latest || latest.activeThreadId !== threadId) return false;
            const historyTurns = authoritativeHistoryTurnKeys(threadId, thread.settledTurnIds || []);
            const hasExpectedTurn = !expectedTurnId || historyTurns.has(`${threadId}\0${expectedTurnId}`);
            historyTurns.forEach((key) => liveTurnKeysRef.current.delete(key));
            if (latest.activeTurnId) liveTurnKeysRef.current.add(`${threadId}\0${latest.activeTurnId}`);
            authoritativeHistoryTurnsRef.current = historyTurns;
            const messages = mergeAgentMessages(history, latest.messages, threadId, liveTurnKeysRef.current);
            threadMessagesRef.current.set(threadId, messages);
            withWindowPatchTarget(windowId, () => setAgentState({ messages, connectError: "" }));
            const coveredTurnIds = [...historyTurns].map((key) => key.slice(threadId.length + 1));
            if (coveredTurnIds.length) void acknowledgeCodexHistory(endpoint, token, threadId, coveredTurnIds).catch(() => undefined);
            if (hasExpectedTurn && (thread.historyReady !== false || Boolean(expectedTurnId))) return true;
            thread = undefined;
        }
        if (lastError) throw lastError;
        return false;
    }, [endpoint, setAgentState, token]);
    const applyWorkspaceChange = useCallback((data: AgentWorkspaceEvent, targetWindowId = "") => {
        const state = useAgentStore.getState();
        const nextThreadId = data.activeThreadId ?? data.threadId ?? "";
        const threadOwnerId = agentWindowIdForThread(state, nextThreadId);
        const windowId = (targetWindowId && state.windows.some((window) => window.id === targetWindowId) ? targetWindowId : "")
            || threadOwnerId
            || state.activeWindowId;
        const target = state.windows.find((window) => window.id === windowId);
        if (!target) return loadThreadsSequenceRef.current;
        const threadChanged = target.activeThreadId !== nextThreadId;
        const emptyThread = Boolean(data.emptyThread || data.draftThread);
        const pendingMessage = [...target.messages].reverse().find((item) => item.role === "user" && !item.turnId);
        const keepPendingMessage = Boolean(
            data.emptyThread
            && pendingMessage
            && (target.sending || target.waiting)
            && (!data.sourceClientId || data.sourceClientId === clientIdRef.current),
        );
        if (threadChanged && target.activeThreadId) {
            const messages = keepPendingMessage ? target.messages.filter((item) => item.id !== pendingMessage!.id) : target.messages;
            threadMessagesRef.current.set(target.activeThreadId, messages);
        }
        if (emptyThread && nextThreadId) threadMessagesRef.current.delete(nextThreadId);
        if (threadChanged || emptyThread) {
            loadThreadsSequenceRef.current += 1;
            authoritativeHistoryTurnsRef.current.clear();
            liveTurnKeysRef.current.clear();
        }
        const messages = keepPendingMessage
            ? [scopeChatItem(pendingMessage!, nextThreadId, "")]
            : emptyThread ? []
                : threadChanged ? threadMessagesRef.current.get(nextThreadId) || []
                    : target.messages;
        if (windowId === state.activeWindowId) pendingToolRef.current = null;
        withWindowPatchTarget(windowId, () => setAgentState({
            activeThreadId: nextThreadId,
            activeTurnId: threadChanged || emptyThread ? "" : target.activeTurnId,
            messages,
            tokenUsage: threadChanged || emptyThread ? null : target.tokenUsage,
            pendingTool: null,
            pendingApprovals: threadChanged || emptyThread ? [] : target.pendingApprovals,
        }));
        return loadThreadsSequenceRef.current;
    }, [setAgentState]);
    /**
     * 会话状态只落到「属于它」的那一个窗：threadId 优先，其次显式偏好窗，
     * 再次唯一持有该 conversationId 的窗，都没有才落到激活窗。返回实际写入的窗 id，未写返回 null。
     */
    const applyConversationState = useCallback((next: AgentConversationState, force = false, preferredWindowId = "") => {
        if (!next?.revision) return null;
        const state = useAgentStore.getState();
        const windowId = agentWindowIdForConversation(state, next, preferredWindowId);
        if (!windowId) return null;
        const target = state.windows.find((window) => window.id === windowId);
        if (!target) return null;
        if (!force && next.revision <= target.conversation.revision) return null;
        const conversationChanged = next.conversationId !== target.conversation.conversationId;
        const nextThreadId = next.threadId || "";
        if (conversationChanged || nextThreadId !== target.activeThreadId) {
            applyWorkspaceChange({
                activeThreadId: nextThreadId,
                emptyThread: conversationChanged || !target.activeThreadId,
                draftThread: next.status === "preparing",
                sourceClientId: next.sourceClientId,
            }, windowId);
        }
        withWindowPatchTarget(windowId, () => setAgentState({ conversation: next, ...conversationBootstrapView(next) }));
        return windowId;
    }, [applyWorkspaceChange, setAgentState]);
    const switchAgentDriver = useCallback((next: AgentDriverId) => {
        if (next === getAgentDriver()) return;
        persistAgentDriver(next);
        // 切 driver 只换会话来源：窗口与画布绑定不动，历史按新 driver 重新拉。
        setAgentState({ messages: [], threads: [], activeThreadId: "", activeTurnId: "", eventLogs: [], waiting: false, sending: false, tokenUsage: { input: 0, cached: 0, output: 0 } });
        void loadThreadsRef.current?.(true);
    }, [setAgentState]);

    const loadThreads = useCallback(async (skipHistory = false, expectedTurnId = "") => {
        if (!connectedRef.current && !useAgentStore.getState().connected) return;
        let sequence = ++loadThreadsSequenceRef.current;
        const requestedWindowId = useAgentStore.getState().activeWindowId;
        const pendingLoads = loadingThreadsPendingRef.current;
        pendingLoads.set(requestedWindowId, (pendingLoads.get(requestedWindowId) ?? 0) + 1);
        withWindowPatchTarget(requestedWindowId, () => setAgentState({ loadingThreads: true }));
        try {
            const data = await fetchAgentJson<AgentThreadsResponse>(endpoint, token, agentApiPath("/threads"));
            if (sequence !== loadThreadsSequenceRef.current) return;
            // 先按 threadId / conversationId 找到会话归属窗，再决定历史写进哪一窗，绝不默认写激活窗。
            const windowId = data.conversation
                ? agentWindowIdForConversation(useAgentStore.getState(), data.conversation) ?? requestedWindowId
                : requestedWindowId;
            if (data.conversation) {
                applyConversationState(data.conversation, false, windowId);
                sequence = loadThreadsSequenceRef.current;
            }
            const target = useAgentStore.getState().windows.find((window) => window.id === windowId);
            if (!target) return;
            const currentThreadId = target.activeThreadId || data.conversation?.threadId || data.workspace?.activeThreadId || "";
            // 窗口的 activeThreadId 与本轮解析出的线程不一致时必须显式同步，不能只在「没有 conversation」时同步：
            // 切换 driver 后新会话的 revision 不比旧的小，applyConversationState 会被版本保护跳过，
            // 窗口就仍停在空线程上；下面的归属校验随即 return，结果切完 driver 历史列表是空的。
            if (currentThreadId !== target.activeThreadId) sequence = applyWorkspaceChange({ activeThreadId: currentThreadId }, windowId);
            if (sequence !== loadThreadsSequenceRef.current) return;
            const latest = useAgentStore.getState().windows.find((window) => window.id === windowId);
            if (!latest || latest.activeThreadId !== currentThreadId) return;
            withWindowPatchTarget(windowId, () => setAgentState({ threads: data.data || [], workspacePath: data.workspace?.workspacePath || "" }));
            if (currentThreadId && !skipHistory) {
                await loadThreadSnapshot(currentThreadId, sequence, windowId, undefined, expectedTurnId);
            } else {
                authoritativeHistoryTurnsRef.current.clear();
                liveTurnKeysRef.current.clear();
            }
        } catch (error) {
            addEventLog(rt("historyReadFailed"), error);
        } finally {
            // 收尾只看「这一窗还有没有历史加载在飞」：applyWorkspaceChange（线程变更）和
            // 发送都会推进全局 sequence，被顶掉的请求若跟着 sequence 一起跳过收尾，
            // 该窗的 loadingThreads 就永远停在 true，输入框永久禁用（双窗切换必现）。
            const remaining = (pendingLoads.get(requestedWindowId) ?? 1) - 1;
            if (remaining > 0) pendingLoads.set(requestedWindowId, remaining);
            else pendingLoads.delete(requestedWindowId);
            if (remaining <= 0) withWindowPatchTarget(requestedWindowId, () => setAgentState({ loadingThreads: false }));
        }
    }, [applyConversationState, applyWorkspaceChange, endpoint, loadThreadSnapshot, setAgentState, token]);
    loadThreadsRef.current = loadThreads;
    // Imperatively subscribe to canvasContext to keep the ref current and debounce snapshot reports without rerendering the panel.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const unsubscribe = useAgentStore.subscribe((state) => {
            if (state.canvasContext === canvasContextRef.current) return;
            canvasContextRef.current = state.canvasContext;
            if (!useAgentStore.getState().connected) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => void postState(endpoint, token, clientIdRef.current, canvasContextRef.current?.snapshot || null), 300);
        });
        return () => {
            unsubscribe();
            if (timer) clearTimeout(timer);
        };
    }, [endpoint, token]);
    useEffect(() => {
        confirmToolsRef.current = confirmTools;
    }, [confirmTools]);
    useEffect(() => {
        pendingToolRef.current = pendingTool;
    }, [pendingTool]);
    useEffect(() => () => attachmentUrlsRef.current.forEach((url) => URL.revokeObjectURL(url)), []);

    useEffect(() => {
        if (!clientReady || !enabled || !token.trim()) return;
        localStorage.setItem("canvas-agent-url", endpoint);
        localStorage.setItem("canvas-agent-token", token);
        const clientId = clientIdRef.current;
        let disposed = false;
        let protocolRejected = false;
        let eventQueue = Promise.resolve();
        const isCurrentConnection = () => !disposed && clientIdRef.current === clientId;
        const enqueueEvent = (task: () => void | Promise<void>) => {
            eventQueue = eventQueue.then(async () => {
                if (isCurrentConnection()) await task();
            }).catch((error) => {
                if (isCurrentConnection()) addEventLog(rt("conversationSyncFailed"), error);
            });
        };
        const source = new EventSource(`${endpoint}/events?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`);
        source.addEventListener("hello", (event) => {
            if (!isCurrentConnection()) return;
            const hello = parseEventData<AgentHelloEvent>(event);
            if (hello?.protocolVersion !== AGENT_PROTOCOL_VERSION) {
                const text = rt("agentOutdated");
                protocolRejected = true;
                source.close();
                connectedRef.current = false;
                setAgentState({ enabled: false, connected: false, waiting: false, sending: false, activity: rt("restartRequired"), connectError: text, silentConnect: false, fragmentBootstrap: false, pendingTool: null, pendingApprovals: [] });
                useAgentSkillStore.getState().reset();
                addEventLog(rt("versionMismatch"), text, hello);
                if (!headless) message.error(text);
                return;
            }
            const codex = hello?.codex;
            const busy = Boolean(codex?.busy);
            const storeAtHello = useAgentStore.getState();
            // 重连只绑定「归属」那一窗：threadId 命中写归属窗，没有归属才写激活窗，绝不一次写多个窗。
            const helloWindowId = (hello?.conversation
                ? agentWindowIdForConversation(storeAtHello, hello.conversation)
                : agentWindowIdForThread(storeAtHello, hello?.workspace?.activeThreadId || storeAtHello.activeThreadId))
                ?? storeAtHello.activeWindowId;
            const nextThreadId = hello?.conversation?.threadId ?? hello?.workspace?.activeThreadId ?? storeAtHello.activeThreadId;
            if (hello?.conversation) applyConversationState(hello.conversation, true, helloWindowId);
            else applyWorkspaceChange({ activeThreadId: nextThreadId }, helloWindowId);
            const current = useAgentStore.getState().windows.find((window) => window.id === helloWindowId) ?? storeAtHello.windows[0];
            const nextTurnId = codex?.threadId === nextThreadId ? codex.turnId ?? "" : "";
            if (nextTurnId) liveTurnKeysRef.current.add(`${nextThreadId}\0${nextTurnId}`);
            const activeTurnId = busy ? nextTurnId : "";
            const pendingApprovals = busy ? (hello?.pendingApprovals || []).filter((item) => !item.threadId || item.threadId === nextThreadId) : [];
            const messages = activeTurnId
                ? bindPendingTurnMessages(current.messages.filter((item) => !isConnectionErrorMessage(item)), nextThreadId, activeTurnId)
                : current.messages.filter((item) => !isConnectionErrorMessage(item));
            errorLoggedRef.current = false;
            connectedRef.current = true;
            withWindowPatchTarget(helloWindowId, () => setAgentState({
                connected: true,
                activity: pendingApprovals.length ? rt("awaitingApproval") : busy ? rt("codexRunning") : rt("connected"),
                waiting: busy,
                sending: false,
                connectError: "",
                silentConnect: false,
                fragmentBootstrap: false,
                activeTab: storeAtHello.activeTab === "setup" ? "chat" : storeAtHello.activeTab,
                activeThreadId: nextThreadId,
                activeTurnId,
                messages,
                pendingApprovals,
            }));
            if (!headless) message.success(rt("localAgentConnected"));
            void postState(endpoint, token, clientId, canvasContextRef.current?.snapshot || null);
            if (document.visibilityState === "visible" && document.hasFocus()) void activateAgentClient(endpoint, token, clientId);
            if (!busy && !nextThreadId && (!hello?.conversation || hello.conversation.status === "idle")) {
                // 走统一的补准备路径（含退避重试）：先占住目标窗，避免下面 effect 再发一次并发 reset。
                // 连接时不该忙（busy 已排除），但网络抖动/桥端切换中失败时同样要能自恢复。
                threadResetTargetRef.current = helloWindowId;
                runThreadResetRef.current(helloWindowId, 0);
            }
        });
        source.addEventListener("codex_state", (event) => {
            const data = parseEventData<AgentCodexState>(event);
            if (!data) return;
            enqueueEvent(async () => {
                const busy = Boolean(data.busy);
                const storeState = useAgentStore.getState();
                // 按线程找归属窗；未知线程直接丢弃，不能改写当前激活窗。
                const windowId = data.threadId ? agentWindowIdForThread(storeState, data.threadId) : storeState.activeWindowId;
                if (!windowId) return;
                const current = storeState.windows.find((window) => window.id === windowId);
                if (!current) return;
                const turnId = data.turnId || current.activeTurnId;
                if (turnId) liveTurnKeysRef.current.add(`${current.activeThreadId}\0${turnId}`);
                const activeTurnId = busy ? turnId : "";
                const messages = activeTurnId ? bindPendingTurnMessages(current.messages, current.activeThreadId, activeTurnId) : current.messages;
                withWindowPatchTarget(windowId, () => setAgentState({
                    activity: busy ? rt("codexRunning") : current.activity === rt("processingFailed") ? rt("processingFailed") : rt("completed"),
                    waiting: busy,
                    sending: false,
                    activeTurnId,
                    messages,
                }));
                if (!busy && current.waiting && windowId === storeState.activeWindowId) void loadThreads(false, turnId);
            });
        });
        source.addEventListener("tool_call", (event) => {
            if (!isCurrentConnection()) return;
            const data = parseEventData<AgentPendingToolCall>(event);
            if (data) void handleToolCall(endpoint, token, data);
        });
        source.addEventListener("codex_approval", (event) => {
            if (!isCurrentConnection()) return;
            const data = parseEventData<AgentPendingApproval>(event);
            if (!data) return;
            const storeState = useAgentStore.getState();
            const windowId = data.threadId ? agentWindowIdForThread(storeState, data.threadId) : storeState.activeWindowId;
            if (!windowId) return;
            const current = storeState.windows.find((window) => window.id === windowId);
            if (!current) return;
            withWindowPatchTarget(windowId, () => setAgentState({ pendingApprovals: [...current.pendingApprovals.filter((item) => item.requestId !== data.requestId), data], activity: rt("awaitingApproval") }));
            addWindowEventLog(windowId, rt("awaitingApproval"), data.reason || data.method, data);
        });
        source.addEventListener("codex_approval_resolved", (event) => {
            if (!isCurrentConnection()) return;
            const data = parseEventData<{ requestId?: string; decision?: "accept" | "acceptForSession" | "decline" | "cancel" }>(event);
            if (!data?.requestId) return;
            const storeState = useAgentStore.getState();
            // 审批归属按 requestId 反查：哪个窗挂着这条审批就写哪个窗。
            const owner = storeState.windows.find((window) => window.pendingApprovals.some((item) => item.requestId === data.requestId));
            const windowId = owner?.id ?? storeState.activeWindowId;
            const current = owner ?? storeState.windows.find((window) => window.id === windowId);
            if (!current) return;
            const approval = current.pendingApprovals.find((item) => item.requestId === data.requestId);
            const pendingApprovals = current.pendingApprovals.filter((item) => item.requestId !== data.requestId);
            withWindowPatchTarget(windowId, () => setAgentState({ pendingApprovals, activity: approvalActivity(pendingApprovals, current.waiting, current.activity) }));
            const decision = data.decision || approval?.deciding;
            if (approval && decision) addWindowEventLog(windowId, rt(decision === "accept" || decision === "acceptForSession" ? "approvalGranted" : "approvalCanceled"), approval.reason || approval.method, approval);
        });
        source.addEventListener("agent_event", (event) => {
            const data = parseEventData<AgentEventPayload>(event);
            if (data) enqueueEvent(() => {
                const eventThreadId = data.threadId || data.thread_id || "";
                const storeState = useAgentStore.getState();
                // 有 threadId 就严格按归属路由；没有 threadId 的全局事件落到激活窗。
                const targetWindowId = eventThreadId ? agentWindowIdForThread(storeState, eventThreadId) : storeState.activeWindowId;
                if (!targetWindowId) return;
                if (targetWindowId !== storeState.activeWindowId) {
                    handleBackgroundEvent(targetWindowId, data);
                    return;
                }
                const shouldProcess = registerLiveAgentTurn(data, authoritativeHistoryTurnsRef.current, liveTurnKeysRef.current);
                if (data.type !== "usage.updated" && !shouldProcess) return;
                return handleAgentEvent(data);
            });
        });
        source.addEventListener("agent_done", (event) => {
            const data = parseEventData<{ threadId?: string; code?: number; agent?: string }>(event);
            if (!data || data.agent !== "claude") return;
            enqueueEvent(() => {
                const threadId = data.threadId || "";
                const current = useAgentStore.getState();
                // 收尾：清掉流式标记，否则输入框会一直以为还有一轮在跑。
                setAgentState({
                    waiting: false,
                    sending: false,
                    activity: rt("completed"),
                    messages: current.messages.map((message) => (threadId && message.id === `claude-stream-${threadId}` ? { ...message, streamId: undefined } : message)),
                });
            });
        });
        source.addEventListener("agent_bootstrap", (event) => {
            const data = parseEventData<AgentBootstrapEvent>(event);
            if (!data?.type) return;
            if (data.type === "codex.preparing") {
                addEventLog(rt("conversationInitializing"), rt("conversationCreating"), data);
                return;
            }
            if (data.type === "codex.prepare_failed") {
                addEventLog(rt("conversationInitFailed"), data.error, data);
                return;
            }
            if (data.type === "mcp.complete") {
                addEventLog(rt("mcpStatusComplete"), rt("mcpListRead"), data);
                return;
            }
            if (!data.name || !data.status) return;
            const label = data.name;
            const status = data.status === "starting"
                ? { text: rt("mcpStarting", { name: label }), detail: rt("mcpConnecting"), status: "running" as const }
                : data.status === "ready"
                    ? { text: rt("mcpReadyNamed", { name: label }), detail: rt("toolsReady"), status: "ready" as const }
                    : data.status === "failed"
                        ? { text: rt("mcpFailedNamed", { name: label }), detail: data.error || rt("toolInitFailed"), status: "error" as const }
                        : { text: rt("mcpCanceledNamed", { name: label }), detail: rt("toolInitCanceled"), status: "error" as const };
            addEventLog(status.text, status.detail, data);
        });
        source.addEventListener("conversation_changed", (event) => {
            const data = parseEventData<AgentConversationState>(event);
            if (data) enqueueEvent(() => {
                const storeState = useAgentStore.getState();
                // 严格按 threadId 归属路由；找不到归属时按 conversationId 唯一持有者/激活窗兜底，且只写一个窗。
                const targetWindowId = agentWindowIdForConversation(storeState, data);
                if (!targetWindowId) return;
                if (targetWindowId && targetWindowId !== storeState.activeWindowId) {
                    handleBackgroundEvent(targetWindowId, data);
                    return;
                }
                applyConversationState(data, false, targetWindowId);
            });
        });
        source.addEventListener("workspace_changed", (event) => {
            const data = parseEventData<AgentWorkspaceEvent>(event);
            if (!data) return;
            enqueueEvent(() => {
                if (data.conversation) applyConversationState(data.conversation);
                else applyWorkspaceChange(data);
                if (!data.draftThread) void loadThreads(Boolean(data.emptyThread));
            });
        });
        source.addEventListener("chat_message", (event) => {
            const data = parseEventData<AgentChatEvent>(event);
            if (!data?.message) return;
            enqueueEvent(() => {
                const eventThreadId = data.threadId || data.message!.threadId || "";
                const storeState = useAgentStore.getState();
                // 用户/助手消息带 threadId 时只写归属窗；缺失 threadId 才落激活窗。
                const targetWindowId = eventThreadId ? agentWindowIdForThread(storeState, eventThreadId) : storeState.activeWindowId;
                if (!targetWindowId) return;
                if (targetWindowId !== storeState.activeWindowId) {
                    handleBackgroundEvent(targetWindowId, data);
                    return;
                }
                if (!registerLiveAgentTurn(data, authoritativeHistoryTurnsRef.current, liveTurnKeysRef.current)) return;
                const current = useAgentStore.getState();
                const threadId = data.threadId || data.message!.threadId || current.activeThreadId;
                const turnId = data.turnId ?? data.message!.turnId ?? "";
                const clientMessageId = data.message!.clientMessageId || data.message!.itemId || data.message!.id;
                if (current.activeThreadId !== threadId) return;
                const next = scopeChatItem(data.message!, threadId, turnId);
                const currentMessages = data.message!.role === "user" && clientMessageId
                    ? current.messages.filter((item) => item.role !== "user" || item.clientMessageId !== clientMessageId || item.id === next.id)
                    : current.messages;
                const messages = upsertAgentMessage(currentMessages, next);
                setAgentState({ messages });
            });
        });
        source.addEventListener("agent_log", (event) => {
            if (!isCurrentConnection()) return;
            const text = parseEventData<{ text?: unknown }>(event)?.text;
            addEventLog(rt("log"), text, text);
        });
        source.addEventListener("skills_changed", (event) => {
            if (!isCurrentConnection()) return;
            const data = parseEventData<{ forceReload?: boolean }>(event);
            void loadSkills(endpoint, token, Boolean(data?.forceReload));
        });
        source.addEventListener("agent_error", (event) => {
            const data = parseEventData<AgentEventPayload>(event);
            if (!data) return;
            enqueueEvent(() => {
                const eventThreadId = data.threadId || data.thread_id || "";
                const storeState = useAgentStore.getState();
                const targetWindowId = eventThreadId ? agentWindowIdForThread(storeState, eventThreadId) : storeState.activeWindowId;
                if (!targetWindowId) return;
                if (targetWindowId !== storeState.activeWindowId) {
                    handleBackgroundEvent(targetWindowId, data);
                    return;
                }
                if (!registerLiveAgentTurn(data, authoritativeHistoryTurnsRef.current, liveTurnKeysRef.current)) return;
                showAgentError(data.message, data, !data.replayed);
            });
        });
        source.onerror = () => {
            if (disposed || protocolRejected) return;
            const wasConnected = connectedRef.current;
            const silent = useAgentStore.getState().silentConnect && !wasConnected;
            const text = rt(wasConnected ? "connectionLostDescription" : "connectionFailedDescription");
            if (!errorLoggedRef.current || wasConnected) {
                addEventLog(rt(wasConnected ? "connectionLost" : "connectionFailed"), text);
                if (!headless && !silent) message.error(text);
            }
            errorLoggedRef.current = true;
            connectedRef.current = false;
            pendingToolRef.current = null;
            setAgentState({
                activity: rt(wasConnected ? "connectionLost" : "connectionFailed"),
                connected: false,
                waiting: false,
                sending: false,
                connectError: silent ? "" : text,
                silentConnect: false,
                fragmentBootstrap: false,
                pendingTool: null,
                pendingApprovals: [],
            });
            useAgentSkillStore.getState().reset();
            if (!wasConnected) {
                source.close();
                setAgentState({ enabled: false });
            }
        };
        return () => {
            disposed = true;
            source.close();
            connectedRef.current = false;
            loadThreadsSequenceRef.current += 1;
            useAgentSkillStore.getState().reset();
        };
    }, [applyConversationState, applyWorkspaceChange, clientReady, enabled, endpoint, loadSkills, loadThreads, message, setAgentState, token]);

    useEffect(() => {
        if (connected) void loadThreads();
    }, [connected, loadThreads]);

    useEffect(() => {
        if (connected) void loadSkills(endpoint, token);
    }, [connected, endpoint, loadSkills, token]);

    useEffect(() => {
        if (!connected) return;
        void fetchAgentJson<AgentModelsResponse>(endpoint, token, agentApiPath("/models")).then(({ data = [] }) => {
            const names = new Set<string>();
            const models = data.flatMap((item) => {
                const name = item.displayName || item.model;
                const efforts = item.supportedReasoningEfforts.filter(({ reasoningEffort }) => AGENT_REASONING_EFFORTS.has(reasoningEffort));
                if (item.model === "codex-auto-review" || names.has(name) || !efforts.length) return [];
                names.add(name);
                const defaultReasoningEffort = efforts.some((effort) => effort.reasoningEffort === item.defaultReasoningEffort) ? item.defaultReasoningEffort : efforts[0].reasoningEffort;
                return [{ ...item, supportedReasoningEfforts: efforts, defaultReasoningEffort }];
            });
            if (!models.length) return;
            const savedModel = useAgentStore.getState().model;
            const current = models.find((item) => item.model === savedModel) || models.find((item) => item.isDefault) || models[0];
            const savedEffort = useAgentStore.getState().reasoningEffort;
            const efforts = current.supportedReasoningEfforts.map((item) => item.reasoningEffort);
            const nextEffort = efforts.includes(savedEffort as AgentReasoningEffort) ? savedEffort as AgentReasoningEffort : current.defaultReasoningEffort || efforts[0];
            localStorage.setItem("canvas-agent-model", current.model);
            localStorage.setItem("canvas-agent-reasoning-effort", nextEffort);
            setAgentState({ models, model: current.model, reasoningEffort: nextEffort });
        }).catch((error) => addEventLog(rt("modelListFailed"), error));
    }, [connected, endpoint, setAgentState, token]);

    useEffect(() => {
        if (!connected) return;
        const activate = () => void activateAgentClient(endpoint, token, clientIdRef.current);
        const activateVisible = () => {
            if (document.visibilityState === "visible") activate();
        };
        window.addEventListener("focus", activate);
        document.addEventListener("visibilitychange", activateVisible);
        return () => {
            window.removeEventListener("focus", activate);
            document.removeEventListener("visibilitychange", activateVisible);
        };
    }, [connected, endpoint, token]);
    // C3：预览层只负责「看和改」，发送仍走这里——画布侧不另开一条发送通道。
    // 传 textOverride 时以预览层里编辑后的文本为准，其余逻辑与原发送路径完全一致。
    const sendPrompt = async (textOverride?: string) => {
        const text = (textOverride ?? prompt).trim();
        const files = attachments;
        const skillState = useAgentSkillStore.getState();
        const selectedSkill = skillState.selectedSkill;
        const selectedSkillRevision = skillState.selectionRevision;
        const currentState = useAgentStore.getState();
        const canvasNodeIds = new Set(currentState.canvasContext?.snapshot.nodes.map((node) => node.id) || []);
        const canvasReferences = currentState.canvasReferences.filter((item) => canvasNodeIds.has(item.nodeId));
        if (canvasReferences.length !== currentState.canvasReferences.length) {
            setAgentState({ canvasReferences });
            message.warning(rt(canvasReferences.length ? "someCanvasReferencesMissing" : "canvasReferencesMissing"));
        }
        const skillPrefix = skillPromptPrefix(useAgentSkillStore.getState().bindings, currentState.activeWindowId, text);
        const requestPrompt = skillPrefix + promptWithCanvasReferences(promptWithAttachments(text, files), canvasReferences);
        const liveQuota = quotaSnapshot(currentState.tokenUsage, Object.keys(useDeliveryStore.getState().runs).length);
        if (!canSpendQuota(liveQuota, "message")) {
            const key = quotaMessageKey(liveQuota);
            if (key) message.error(t(key, { used: liveQuota.tokensUsed, limit: liveQuota.tokensUsed + liveQuota.tokensRemaining }));
            return;
        }
        if (!currentState.connected || !requestPrompt || currentState.sending || currentState.waiting || currentState.loadingThreads || !["ready", "warning"].includes(currentState.conversation.status)) return;
        let referenceImages: AgentAttachment[] = [];
        if (canvasReferences.some((item) => item.kind === "image")) {
            setAgentState({ sending: true, activity: rt("readingCanvasImages") });
            try {
                referenceImages = await resolveCanvasReferenceImages(canvasReferences, currentState.canvasContext?.snapshot.nodes || []);
            } catch (error) {
                setAgentState({ sending: false, activity: rt("canvasImageReadFailed") });
                addMessage({ role: "error", title: rt("canvasImageReadFailed"), text: error instanceof Error ? error.message : rt("canvasImageReadFailed") });
                return;
            }
        }
        const requestFiles = files;
        const canvasAttachments = canvasReferences.flatMap(({ nodeId }) => {
            const image = referenceImages.find((item) => item.id === `canvas:${nodeId}`);
            return image ? [{ id: image.id, name: image.name, type: image.type, size: image.size, width: image.width, height: image.height, url: image.url, dataUrl: image.dataUrl, canvasNodeId: nodeId }] : [];
        });
        const payloadAttachments = [...requestFiles, ...canvasAttachments];
        if (payloadAttachments.length > MAX_ATTACHMENTS) {
            setAgentState({ sending: false, activity: rt("tooManyImages") });
            addMessage({ role: "error", title: rt("tooManyImages"), text: rt("imageCountLimit", { count: MAX_ATTACHMENTS }) });
            return;
        }
        if (attachmentPayloadBytes(payloadAttachments) > MAX_ATTACHMENT_PAYLOAD_BYTES) {
            setAgentState({ sending: false, activity: rt("imageTooLarge") });
            addMessage({ role: "error", title: rt("imageTooLarge"), text: rt("imagePayloadTooLarge") });
            return;
        }
        const messageId = createId();
        const userText = text || rt(files.length ? "imagesSent" : "canvasReferencesSent", { count: files.length || canvasReferences.length });
        const messageReferences: AgentCanvasReference[] = await Promise.all(canvasReferences.map(async ({ nodeId, label, title, kind, previewUrl, text }) => {
            const image = referenceImages.find((item) => item.id === `canvas:${nodeId}`);
            return { nodeId, label, title, kind, previewUrl: image ? (await createMessageAttachmentMetadata(image)).url : previewUrl, text };
        }));
        const messageSkill = selectedSkill ? { name: selectedSkill.name, path: selectedSkill.path, displayName: selectedSkill.interface?.displayName || undefined } : undefined;
        loadThreadsSequenceRef.current += 1;
        const storeBeforeSend = useAgentStore.getState();
        // 发送必须用本窗自己的线程：取激活窗切片，而不是可能被别的窗刷新的扁平字段。
        const sendWindow = agentWindowById(storeBeforeSend, storeBeforeSend.activeWindowId);
        if (!sendWindow) return;
        const requestThreadId = sendWindow.activeThreadId || sendWindow.conversation.threadId;
        setAgentState({ prompt: "", attachments: [], canvasReferences: [], activity: rt("sending"), sending: true, loadingThreads: false, activeTurnId: "", messages: sendWindow.messages });
        addMessage({ id: messageId, itemId: "synthetic:user", clientMessageId: messageId, threadId: requestThreadId, turnId: "", role: "user", text: userText, attachments: files, canvasReferences: messageReferences, skill: messageSkill });
        let threadId = requestThreadId;
        try {
            const messageAttachments = await Promise.all(files.map(createMessageAttachmentMetadata));
            const messageMetadata = {
                ...(messageAttachments.length ? { attachments: messageAttachments } : {}),
                ...(messageReferences.length ? { canvasReferences: messageReferences } : {}),
                ...(messageSkill ? { skill: messageSkill } : {}),
            };
            const modelName = models.find((item) => item.model === model)?.displayName || model || rt("defaultModel");
            const effortName = reasoningEffort ? i18n.t(`agent.composer.effort.${reasoningEffort}`) : rt("defaultEffort");
            addEventLog(rt("sendTask"), `${modelName} · ${effortName}${selectedSkill ? ` · Skill ${selectedSkill.name}` : ""}${files.length ? ` · ${rt("attachmentCount", { count: files.length })}` : ""}${canvasReferences.length ? ` · ${rt("canvasReferenceCount", { count: canvasReferences.length })}` : ""} · ${compactText(text) || rt(canvasReferences.length ? "canvasReferencesOnly" : "attachmentsOnly")}`);
            turnReferenceNodeIdsRef.current = messageReferences.map((item) => item.nodeId);
            const accepted = await fetchAgentJson<AgentTurnResponse>(endpoint, token, agentApiPath("/turn"), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    prompt: requestPrompt,
                    messageText: userText,
                    messageId,
                    clientId: clientIdRef.current,
                    threadId,
                    conversationId: sendWindow.conversation.conversationId,
                    expectedRevision: sendWindow.conversation.revision,
                    permissionMode,
                    model,
                    effort: reasoningEffort,
                    skill: selectedSkill ? { name: selectedSkill.name, path: selectedSkill.path } : undefined,
                    attachments: requestFiles.map(({ id, name, type, size, width, height, dataUrl }) => ({ id, name, type, size, width, height, dataUrl })),
                    canvasAttachments: canvasAttachments.map(({ id, name, type, size, width, height, dataUrl, canvasNodeId }) => ({ id, name, type, size, width, height, dataUrl, source: "canvas", canvasNodeId })),
                    imageChannelReady: isAiConfigReady(effectiveConfig, effectiveConfig.imageModel),
                    messageMetadata,
                }),
            });
            threadId = accepted.threadId || threadId;
            if (!threadId) throw new Error(rt("startConversationFailed"));
            if (selectedSkill) clearSkillSelection(selectedSkillRevision);
            files.forEach((item) => {
                URL.revokeObjectURL(item.url);
                attachmentUrlsRef.current.delete(item.url);
            });
        } catch (error) {
            const text = error instanceof Error ? error.message : rt("sendFailed");
            const response = error instanceof AgentApiError ? error.response as { code?: string; state?: AgentConversationState } : undefined;
            if (response?.state) applyConversationState(response.state);
            const stale = response?.code === "CONVERSATION_STALE";
            const busy = response?.code === "CONVERSATION_BUSY" || text.includes("Codex 正在运行");
            const state = useAgentStore.getState();
            const removeFailedPending = (messages: AgentChatItem[]) => messages.filter((item) => item.clientMessageId !== messageId || Boolean(item.turnId));
            threadMessagesRef.current.forEach((messages, cachedThreadId) => {
                const next = removeFailedPending(messages);
                if (next.length !== messages.length) threadMessagesRef.current.set(cachedThreadId, next);
            });
            const ownsCurrentThread = state.activeThreadId === (threadId || requestThreadId);
            const restoreDraft = state.prompt || state.attachments.length || state.canvasReferences.length ? {} : { prompt, attachments: files, canvasReferences };
            if (ownsCurrentThread) {
                setAgentState({
                    activity: rt(stale ? "conversationSynced" : busy ? "codexRunning" : "sendFailed"),
                    sending: false,
                    messages: removeFailedPending(state.messages),
                    ...restoreDraft,
                });
                addMessage({ threadId: state.activeThreadId, turnId: "", role: "error", title: rt(stale ? "conversationSynced" : busy ? "taskStillRunning" : "sendFailed"), text });
            } else {
                setAgentState({ sending: false, messages: removeFailedPending(state.messages), ...restoreDraft });
            }
            addEventLog(rt("sendFailed"), error);
        }
    };

    /** 预览层排队的一次发送：等到「连接上 + 会话就绪 + 没在跑」再交给 sendPrompt。 */
    const feedSendRequest = useAgentStore((state) => state.feedSendRequest);
    useEffect(() => {
        if (!feedSendRequest) return;
        if (feedSendRequest.windowId !== activeWindowId) return;
        if (!connected || loadingThreads || sending || waiting || !["ready", "warning"].includes(conversation.status)) return;
        // 草稿被改过说明用户另有意图，这条排队发送作废，不能把它盖回去。
        if (prompt.trim() !== feedSendRequest.text.trim()) {
            useAgentStore.getState().clearFeedSend();
            return;
        }
        useAgentStore.getState().clearFeedSend();
        void sendPrompt(feedSendRequest.text);
    }, [activeWindowId, connected, conversation.status, feedSendRequest, loadingThreads, prompt, sendPrompt, sending, waiting]);

    // 排队发送不能无限悬着：60 秒还没发出去就作废（内容仍在输入框里，用户可手动发）。
    useEffect(() => {
        if (!feedSendRequest) return;
        const timer = setTimeout(() => {
            if (useAgentStore.getState().feedSendRequest === feedSendRequest) useAgentStore.getState().clearFeedSend();
        }, 60_000);
        return () => clearTimeout(timer);
    }, [feedSendRequest]);

    const stopTurn = async () => {
        if (!connected || (!sending && !waiting)) return;
        setAgentState({ activity: rt("stopping") });
        try {
            // 中断用本窗线程：取激活窗切片的线程，不取可能被别的窗改写的扁平字段。
            const storeState = useAgentStore.getState();
            const window = agentWindowById(storeState, storeState.activeWindowId);
            await interruptCodexTurn(endpoint, token, window?.activeThreadId || window?.conversation.threadId || undefined);
            addEventLog(rt("stopTask"), rt("taskStopped"));
        } catch (error) {
            setAgentState({ activity: rt("stopFailed") });
            addEventLog(rt("stopFailed"), error);
        }
    };

    const addAttachments = async (files: FileList | File[] | null) => {
        if (!files) return;
        const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
        const prev = useAgentStore.getState().attachments;
        try {
            const next = await Promise.all(
                images.slice(0, Math.max(0, MAX_ATTACHMENTS - prev.length)).map(async (file) => {
                    const dataUrl = await readDataUrl(file);
                    const meta = await readImageMeta(dataUrl);
                    const url = URL.createObjectURL(file);
                    attachmentUrlsRef.current.add(url);
                    return { id: createId(), name: file.name, type: file.type, size: file.size, width: meta.width, height: meta.height, url, dataUrl };
                }),
            );
            const merged = [...prev, ...next];
            if (attachmentPayloadBytes(merged) > MAX_ATTACHMENT_PAYLOAD_BYTES) {
                next.forEach((item) => {
                    URL.revokeObjectURL(item.url);
                    attachmentUrlsRef.current.delete(item.url);
                });
                addMessage({ role: "error", title: rt("imageTooLarge"), text: rt("imageLimit") });
                return;
            }
            if (next.length) setAgentState({ attachments: merged });
        } catch (error) {
            addMessage({ role: "error", title: rt("imageReadFailed"), text: error instanceof Error ? error.message : rt("imageReadFailed") });
        }
    };

    const removeAttachment = (id: string) => {
        const removed = attachments.find((item) => item.id === id);
        if (removed) {
            URL.revokeObjectURL(removed.url);
            attachmentUrlsRef.current.delete(removed.url);
        }
        setAgentState({ attachments: attachments.filter((item) => item.id !== id) });
    };

    const handleToolCall = async (endpoint: string, token: string, payload: AgentPendingToolCall) => {
        if (confirmToolsRef.current && isCanvasWriteTool(payload.name)) {
            if (pendingToolRef.current) {
                await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: rt("pendingCanvasTool") });
                return;
            }
            pendingToolRef.current = payload;
            setAgentState({ pendingTool: payload });
            addEventLog(rt("awaitingConfirmation"), payload, payload);
            return;
        }
        await runToolCall(endpoint, token, payload);
    };

    const runToolCall = async (endpoint: string, token: string, payload: AgentPendingToolCall) => {
        if (isSiteTool(payload.name)) {
            try {
                addEventLog(toolName(payload.name), payload, payload);
                const result = await runSiteTool(payload.name, payload.input || {}, navigate, { canvasSnapshot: canvasContextRef.current?.snapshot || null });
                await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, result });
                addEventLog(rt("toolCompleted", { tool: toolName(payload.name) }), result, result);
            } catch (error) {
                const message = error instanceof Error ? error.message : rt("toolExecutionFailed");
                await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: message });
            }
            return;
        }
        try {
            const input: { ops?: CanvasAgentOp[]; path?: string } = payload.input || {};
            addEventLog(toolName(payload.name), payload, payload);
            let result: unknown;
            let appliedOps = input.ops || [];
            if (payload.name === "site_navigate") {
                const path = input.path || "/";
                navigate(path);
                result = { ok: true, path };
            } else if (payload.name === "canvas_apply_ops") {
                const context = canvasContextRef.current;
                if (!context) throw new Error(rt("openCanvasFirst"));
                result = context.applyOps(appliedOps);
                void postState(endpoint, token, clientIdRef.current, result as CanvasAgentSnapshot);
            } else if (payload.name === "canvas_create_attachment_nodes") {
                const context = canvasContextRef.current;
                if (!context) throw new Error(rt("openCanvasFirst"));
                appliedOps = await attachmentNodeOps(endpoint, token, clientIdRef.current, payload.input?.nodes);
                result = context.applyOps(appliedOps);
                await postState(endpoint, token, clientIdRef.current, result as CanvasAgentSnapshot);
            } else {
                const snapshot = canvasContextRef.current?.snapshot;
                if (!snapshot) throw new Error(rt("openCanvasFirst"));
                result = snapshot;
            }
            await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, result });
            addEventLog(rt("toolCompleted", { tool: toolName(payload.name) }), result, result);
        } catch (error) {
            const message = error instanceof Error ? error.message : rt("canvasOperationFailed");
            await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: message });
        }
    };

    const rejectPendingTool = async () => {
        if (!pendingTool) return;
        await postToolResult(endpoint, token, clientIdRef.current, { requestId: pendingTool.requestId, error: rt("canvasToolCanceled") });
        pendingToolRef.current = null;
        setAgentState({ pendingTool: null });
    };

    const approvePendingTool = async () => {
        if (!pendingTool) return;
        const tool = pendingTool;
        pendingToolRef.current = null;
        setAgentState({ pendingTool: null });
        await runToolCall(endpoint, token, tool);
    };

    const decideApproval = async (approval: AgentPendingApproval, decision: "accept" | "acceptForSession" | "decline") => {
        // 审批归属按 requestId 反查持有窗：哪个窗挂着这条审批就更新哪个窗，不默认写激活窗。
        const storeState = useAgentStore.getState();
        const owner = storeState.windows.find((window) => window.pendingApprovals.some((item) => item.requestId === approval.requestId));
        const windowId = owner?.id ?? storeState.activeWindowId;
        const current = owner ?? agentWindowById(storeState, windowId);
        if (!current) return;
        const pending = current.pendingApprovals.find((item) => item.requestId === approval.requestId);
        if (!pending || pending.deciding) return;
        withWindowPatchTarget(windowId, () => setAgentState({ pendingApprovals: current.pendingApprovals.map((item) => item.requestId === approval.requestId ? { ...item, deciding: decision } : item), activity: rt("submittingApproval") }));
        try {
            await postCodexApproval(endpoint, token, approval.requestId, decision);
            const latest = agentWindowById(useAgentStore.getState(), windowId);
            if (latest?.pendingApprovals.some((item) => item.requestId === approval.requestId)) {
                withWindowPatchTarget(windowId, () => setAgentState({ activity: rt("waitingCodexApproval") }));
            }
        } catch (error) {
            const latest = agentWindowById(useAgentStore.getState(), windowId);
            if (!latest) return;
            const expired = error instanceof Error && error.message.includes("审批请求已失效");
            const resolved = expired || !latest.pendingApprovals.some((item) => item.requestId === approval.requestId);
            const pendingApprovals = resolved
                ? latest.pendingApprovals.filter((item) => item.requestId !== approval.requestId)
                : latest.pendingApprovals.map((item) => item.requestId === approval.requestId ? { ...item, deciding: undefined } : item);
            withWindowPatchTarget(windowId, () => setAgentState({ pendingApprovals, activity: approvalActivity(pendingApprovals, latest.waiting, latest.activity) }));
            if (resolved) return;
            addWindowEventLog(windowId, rt("approvalFailed"), error);
            message.error(error instanceof Error ? error.message : rt("approvalFailed"));
        }
    };

    const changePermissionMode = (nextMode: AgentPermissionMode) => {
        const apply = () => {
            localStorage.setItem("canvas-agent-permission-mode", nextMode);
            setAgentState({ permissionMode: nextMode });
        };
        if (nextMode !== "full") return apply();
        modal.confirm({
            title: rt("enableFullAccess"),
            content: rt("fullAccessDescription"),
            okText: rt("enableFullAccessAction"),
            okType: "danger",
            cancelText: t("common.cancel"),
            onOk: apply,
        });
    };

    const toggleAgentConnection = async ({ silent = false }: { silent?: boolean } = {}) => {
        if (enabled) {
            clearAgentSession({ enabled: false, connected: false, activity: rt("offline"), connectError: "" });
            return;
        }
        const urlToken = searchParams.get("agentToken") || "";
        const urlEndpoint = searchParams.get("agentUrl") || "";
        const discovered = urlToken ? null : await discoverAgentConfig(endpoint || DEFAULT_AGENT_URL);
        const nextEndpoint = (urlEndpoint || discovered?.url || endpoint || DEFAULT_AGENT_URL).trim().replace(/\/$/, "");
        const nextToken = (urlToken || token.trim() || discovered?.token || "").trim();
        if (!nextEndpoint) {
            const text = rt("addressRequired");
            if (!silent) {
                setAgentState({ connectError: text });
                if (!headless) message.warning(text);
            }
            return;
        }
        if (!nextToken) {
            const text = rt("agentNotFound");
            if (!silent) {
                setAgentState({ connectError: text });
                if (!headless) message.warning(text);
            }
            return;
        }
        try {
            const parsed = new URL(nextEndpoint);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid protocol");
        } catch {
            const text = rt("invalidAddress");
            if (!silent) {
                setAgentState({ connectError: text });
                if (!headless) message.warning(text);
            }
            return;
        }
        errorLoggedRef.current = false;
        setAgentState({ url: nextEndpoint, token: nextToken, enabled: true, connected: false, silentConnect: silent, fragmentBootstrap: false, activity: rt("connecting"), connectError: "", activeTab: "setup" });
    };

    useLayoutEffect(() => {
        const bootstrap = readAgentUrlBootstrap(hash);
        if (!bootstrap) return;
        navigate(`${window.location.pathname}${window.location.search}${bootstrap.remainingHash}`, { replace: true });
        if (!bootstrap.url || !bootstrap.token) {
            setAgentState({ fragmentBootstrap: false, activeTab: "setup", connectError: rt(!bootstrap.url ? "addressRequired" : "agentNotFound") });
            useAgentStore.getState().openPanel();
            return;
        }
        try {
            const parsed = new URL(bootstrap.url);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid protocol");
        } catch {
            setAgentState({ fragmentBootstrap: false, activeTab: "setup", connectError: rt("invalidAddress") });
            useAgentStore.getState().openPanel();
            return;
        }
        errorLoggedRef.current = false;
        setAgentState({ url: bootstrap.url.replace(/\/$/, ""), token: bootstrap.token, enabled: true, connected: false, silentConnect: true, fragmentBootstrap: true, confirmTools: false, activity: rt("connecting"), connectError: "", activeTab: "setup" });
    }, [hash, navigate, setAgentState]);

    useEffect(() => {
        if (urlAgentAutoConnect && confirmTools) setAgentState({ confirmTools: false });
    }, [confirmTools, setAgentState, urlAgentAutoConnect]);

    useEffect(() => {
        if ((!autoConnect && !urlAgentAutoConnect) || autoConnectRef.current || enabled || connected) return;
        autoConnectRef.current = true;
        void toggleAgentConnection({ silent: true });
    }, [autoConnect, connected, enabled, urlAgentAutoConnect]);

    function clearAgentSession(patch: Parameters<typeof setAgentState>[0] = {}) {
        loadThreadsSequenceRef.current += 1;
        threadMessagesRef.current.clear();
        authoritativeHistoryTurnsRef.current.clear();
        liveTurnKeysRef.current.clear();
        threadOperationRef.current = 0;
        loadingThreadsPendingRef.current.clear();
        setAgentState({
            messages: [],
            tokenUsage: null,
            threads: [],
            activeThreadId: "",
            activeTurnId: "",
            workspacePath: "",
            loadingThreads: false,
            waiting: false,
            sending: false,
            fragmentBootstrap: false,
            pendingTool: null,
            pendingApprovals: [],
            conversation: { revision: 0, conversationId: "", threadId: "", status: "idle", mcpStatuses: {} },
            bootstrapStatus: null,
            mcpStartupStatuses: {},
            ...patch,
        });
        useAgentSkillStore.getState().reset();
        pendingToolRef.current = null;
    }

    const beginThreadOperation = () => {
        const operation = ++threadOperationSequenceRef.current;
        threadOperationRef.current = operation;
        setAgentState({ loadingThreads: true });
        return operation;
    };

    const finishThreadOperation = (operation: number) => {
        if (threadOperationRef.current !== operation) return;
        threadOperationRef.current = 0;
        setAgentState({ loadingThreads: false });
    };

    const startNewThread = async () => {
        const current = useAgentStore.getState();
        if (!current.connected || current.sending || current.waiting || current.loadingThreads || ["preparing", "running"].includes(current.conversation.status)) return;
        const operation = beginThreadOperation();
        clearSkillSelection();
        setAgentState({ activeTab: "chat", activity: rt("creatingConversation") });
        const targetWindowId = useAgentStore.getState().activeWindowId;
        try {
            const result = await fetchAgentJson<AgentWorkspaceResponse>(endpoint, token, agentApiPath("/threads/reset"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: clientIdRef.current, permissionMode }) });
            if (threadOperationRef.current !== operation) return;
            if (result.conversation) applyConversationState(result.conversation, false, targetWindowId);
            setAgentState({ activeTab: "chat", activity: rt("newConversation") });
        } catch (error) {
            const state = agentErrorState(error);
            if (state) applyConversationState(state, false, targetWindowId);
            addWindowEventLog(targetWindowId, rt("newConversationFailed"), error);
            message.error(error instanceof Error ? error.message : rt("newConversationFailed"));
            await loadThreads();
        } finally {
            finishThreadOperation(operation);
        }
    };


    const resumeThread = async (threadId: string) => {
        const current = useAgentStore.getState();
        if (!current.connected || !threadId || current.sending || current.waiting || current.loadingThreads || ["preparing", "running"].includes(current.conversation.status)) return;
        const operation = beginThreadOperation();
        const targetWindowId = useAgentStore.getState().activeWindowId;
        try {
            const result = await fetchAgentJson<AgentThreadResponse>(endpoint, token, agentApiPath(`/threads/${encodeURIComponent(threadId)}/resume`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ permissionMode, clientId: clientIdRef.current }) });
            if (result.conversation) applyConversationState(result.conversation, false, targetWindowId);
            await loadThreads();
            if (useAgentStore.getState().activeThreadId === threadId) setAgentState({ activeTab: "chat", activity: rt("conversationResumed") });
        } catch (error) {
            const state = agentErrorState(error);
            if (state) applyConversationState(state, false, targetWindowId);
            addWindowEventLog(targetWindowId, rt("resumeConversationFailed"), error);
            message.error(error instanceof Error ? error.message : rt("resumeConversationFailed"));
            await loadThreads();
        } finally {
            finishThreadOperation(operation);
        }
    };

    const deleteThreads = async (threadIds: string[]) => {
        if (!connected || !threadIds.length || sending || waiting || loadingThreads) return;
        const operation = beginThreadOperation();
        let deletedCount = 0;
        try {
            for (const threadId of new Set(threadIds)) {
                await fetchAgentJson(endpoint, token, agentApiPath(`/threads/${encodeURIComponent(threadId)}/delete`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: clientIdRef.current }) });
                threadMessagesRef.current.delete(threadId);
                deletedCount += 1;
            }
            await loadThreads();
            message.success(rt("recordsDeleted", { count: deletedCount }));
        } catch (error) {
            await loadThreads();
            addEventLog(rt("deleteConversationFailed"), error);
            message.error(error instanceof Error ? error.message : rt("deleteConversationFailed"));
        } finally {
            finishThreadOperation(operation);
        }
    };

    const confirmDeleteThreads = (threadIds: string[]) => {
        modal.confirm({
            title: rt("deleteConversations", { count: threadIds.length }),
            content: rt("deleteConversationsDescription"),
            okText: t("common.delete"),
            okType: "danger",
            cancelText: t("common.cancel"),
            onOk: () => deleteThreads(threadIds),
        });
    };

    const addMessage = (item: Omit<AgentChatItem, "id"> & { id?: string }) => {
        const text = normalizeText(item.text);
        if (!text && !item.attachments?.length) return;
        const current = useAgentStore.getState();
        const itemId = item.itemId || item.id || createId();
        const next = scopeChatItem({ ...item, id: item.id || itemId, itemId, text } as AgentChatItem, item.threadId ?? current.activeThreadId, item.turnId ?? current.activeTurnId);
        setAgentState({ messages: upsertAgentMessage(current.messages, next) });
    };

    /** 把一条日志写进指定窗（后台窗也只在它自己的切片里累积）。 */
    const addWindowEventLog = (windowId: string, title: string, text: unknown, raw?: unknown) => {
        const value = normalizeText(text) || title;
        const target = useAgentStore.getState().windows.find((window) => window.id === windowId);
        if (!target) return;
        const last = target.eventLogs.at(-1);
        if (last?.title === title && last.text === value) return;
        withWindowPatchTarget(windowId, () => pushEventLog({ id: `${Date.now()}-${Math.random()}`, time: dayjs().format("YYYY-MM-DD HH:mm:ss"), title, text: value, raw }));
    };

    const addEventLog = (title: string, text: unknown, raw?: unknown) => {
        addWindowEventLog(useAgentStore.getState().activeWindowId, title, text, raw);
    };

    /** 目标窗是否还需要补建线程：窗还在、还没线程、状态没定性（被别的路径建好了就不再补）。 */
    const threadPrepareNeeded = (windowId: string) => needsThreadPrepare(useAgentStore.getState().windows.find((item) => item.id === windowId));

    const clearThreadResetRetry = useCallback(() => {
        if (threadResetTimerRef.current) {
            clearTimeout(threadResetTimerRef.current);
            threadResetTimerRef.current = null;
        }
        threadResetAttemptRef.current = 0;
        threadResetTargetRef.current = "";
    }, []);

    /**
     * 为新窗补一次建线程（threads/reset）。
     * 失败按退避重试（1s → 2s → 4s → 8s 封顶，最多 THREAD_RESET_MAX_ATTEMPTS 次）：
     * 双窗并行时桥端在任一 turn 运行中直接 409 拒绝，若不重试新窗会永久卡在无线程状态。
     * 终点只有三个：成功 / 窗口被关或切走（cleanup 清定时器）/ 重试耗尽后落到可读失败态。
     */
    const runThreadReset = (windowId: string, attempt: number) => {
        if (!threadPrepareNeeded(windowId)) {
            clearThreadResetRetry();
            return;
        }
        threadResetAttemptRef.current = attempt;
        // loadingThreads 是窗口级字段：必须显式指向目标窗（hello 补准备时目标窗未必是激活窗）。
        const operation = withWindowPatchTarget(windowId, () => beginThreadOperation());
        withWindowPatchTarget(windowId, () => setAgentState({ activity: attempt > 0 ? rt("retryingConversation", { attempt }) : rt("creatingConversation") }));
        void fetchAgentJson<AgentWorkspaceResponse>(endpoint, token, agentApiPath("/threads/reset"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: clientIdRef.current, permissionMode }) })
            .then((result) => {
                // 被更新的操作抢了（切窗/用户手动新建）：这次结果作废，但不能把重试状态一起废掉。
                if (threadOperationRef.current !== operation) return;
                if (!result.conversation) throw new Error(rt("newConversationFailed"));
                // 新建窗即建独立线程：结果只写发起准备的那一窗，绝不落到别的窗。
                applyConversationState(result.conversation, false, windowId);
                // 只在成功后标记已准备；失败路径必须能再次进入。
                preparedWindowRef.current = windowId;
                clearThreadResetRetry();
            })
            .catch((error) => {
                if (threadOperationRef.current !== operation) return;
                const retryDelay = threadResetRetryDelay(attempt + 1, error);
                if (retryDelay !== null && threadPrepareNeeded(windowId)) {
                    threadResetTargetRef.current = windowId;
                    threadResetAttemptRef.current = attempt + 1;
                    if (attempt === 0) addWindowEventLog(windowId, rt("newConversationRetrying"), error);
                    threadResetTimerRef.current = setTimeout(() => {
                        threadResetTimerRef.current = null;
                        runThreadResetRef.current(windowId, attempt + 1);
                    }, retryDelay);
                    return;
                }
                // 非瞬时错 / 重试耗尽：落到可读失败态，别让 activity 永远停在「正在新建对话」。
                clearThreadResetRetry();
                preparedWindowRef.current = "";
                addWindowEventLog(windowId, rt("newConversationFailed"), error);
                // 桥端带回的 state 可能属于别的窗（忙时快照是运行中窗的会话），
                // 这里只在自己这窗落一个可读失败态，不转发别人的状态。
                withWindowPatchTarget(windowId, () => {
                    const latest = useAgentStore.getState().windows.find((item) => item.id === windowId);
                    if (!latest || latest.activeThreadId) return;
                    const failed = { ...latest.conversation, status: "failed" as const, error: normalizeText(error) || rt("newConversationFailed") };
                    setAgentState({ activity: rt("newConversationFailed"), conversation: failed, ...conversationBootstrapView(failed) });
                });
            })
            .finally(() => withWindowPatchTarget(windowId, () => finishThreadOperation(operation)));
    };

    // 渲染时刷新 ref（不是 effect）：hello 补准备与定时器回调都能拿到最新闭包，
    // 且任何异步回调执行前 ref 一定已就位（否则新窗会静默漏发一次请求）。
    runThreadResetRef.current = runThreadReset;

    // 新建/切换会话窗时补一次会话准备：新窗口的 activeThreadId 为空、conversation.status 永远
    // 停在 idle，输入框会一直禁用（点 + 新建后根本发不出消息）。这里在窗口成为激活窗时补一次
    // threads/reset，让它进入 preparing → ready。已有线程/已在准备的窗口不动；
    // 失败走 runThreadReset 的退避重试，不留下永久禁用的新窗。
    useEffect(() => {
        if (!connected || !activeWindowId) return;
        const current = useAgentStore.getState();
        const window = current.windows.find((item) => item.id === activeWindowId);
        if (!window) return;
        if (!needsThreadPrepare(window)) {
            // 已有线程 / 已在准备 / 已定性失败：标记已准备，并清掉可能残留的重试。
            preparedWindowRef.current = activeWindowId;
            clearThreadResetRetry();
            return;
        }
        if (preparedWindowRef.current === activeWindowId) return;
        // 请求在飞或正等下一次重试：同一窗不并发第二个 reset。
        if (threadResetTargetRef.current === activeWindowId) return;
        // 忙时不发（deps 里的 sending/waiting/loadingThreads 保证「忙 → 闲」会再触发一次）。
        if (current.sending || current.waiting || current.loadingThreads || threadOperationRef.current) return;
        threadResetTargetRef.current = activeWindowId;
        runThreadResetRef.current(activeWindowId, 0);
    }, [activeWindowId, connected, applyConversationState, addEventLog, endpoint, permissionMode, setAgentState, token, sending, waiting, loadingThreads, clearThreadResetRetry]);

    // 窗口被关 / 切走：清掉挂起的重试定时器，不能在离开后继续往旧窗写状态。
    useEffect(() => {
        const leavingWindowId = activeWindowId;
        return () => {
            if (threadResetTargetRef.current && threadResetTargetRef.current === leavingWindowId) clearThreadResetRetry();
        };
    }, [activeWindowId, clearThreadResetRetry]);

    const upsertActivityMessage = (item: AgentChatItem) => {
        setAgentState({ messages: upsertAgentMessage(useAgentStore.getState().messages, item) });
    };

    const appendActivityDelta = (event: AgentEventPayload) => {
        const item = event.item;
        if (!item?.id) return;
        const text = stringText(item.text) || stringText(item.delta);
        const isDelta = Boolean(stringText(item.delta));
        if (!text) return;
        if (item.type === "reasoning") {
            const scoped = scopeEventChatItem(event, activityDeltaFallback(item, text), "synthetic:reasoning");
            const current = useAgentStore.getState().messages.find((message) => message.id === scoped.id);
            const activityItems = { ...(current?.activityItems || {}) };
            const previous = activityItems[item.id] || "";
            activityItems[item.id] = isDelta ? `${previous === activityPlaceholder("reasoning") ? "" : previous}${text}` : text;
            upsertActivityMessage({ ...scoped, title: i18n.t("agent.events.reasoning"), text: reasoningActivityText(activityItems), activityItems, detail: activityDetail(current?.detail || scoped.detail, "reasoning", "inProgress") });
            return;
        }
        const scoped = scopeEventChatItem(event, activityDeltaFallback(item, text), item.id);
        const currentMessages = useAgentStore.getState().messages;
        const index = currentMessages.findIndex((message) => message.id === scoped.id);
        if (index < 0) {
            if (!text.trim()) return;
            upsertActivityMessage(scoped);
            return;
        }
        const current = currentMessages[index];
        if (item.type === "command_execution") {
            const detail = activityDetail(current.detail, "command", "inProgress");
            detail.output = isDelta ? `${stringText(detail.output)}${text}` : text;
            setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, detail } : message) });
            return;
        }
        const placeholder = activityPlaceholder(item.type);
        if (!text.trim() && current.text === placeholder) return;
        const nextText = isDelta ? `${current.text === placeholder ? "" : current.text}${text}` : mergeStreamText(current.text, text);
        setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, text: nextText, detail: { ...activityDetail(message.detail, activityKind(item.type), "inProgress") } } : message) });
    };

    const upsertEventActivity = (event: AgentEventPayload, item: Omit<AgentChatItem, "id">) => {
        const itemId = event.item?.id;
        if (!itemId) return;
        if (event.item?.type === "reasoning") {
            const scoped = scopeEventChatItem(event, { ...item, id: "synthetic:reasoning" }, "synthetic:reasoning");
            const current = useAgentStore.getState().messages.find((message) => message.id === scoped.id);
            const activityItems = { ...(current?.activityItems || {}) };
            const previous = activityItems[itemId] || "";
            const incoming = normalizeText(item.text);
            activityItems[itemId] = incoming === "已完成分析" && previous && previous !== activityPlaceholder("reasoning") ? previous : incoming;
            upsertActivityMessage({ ...scoped, title: i18n.t("agent.events.reasoning"), text: reasoningActivityText(activityItems, incoming), activityItems });
            return;
        }
        upsertActivityMessage(scopeEventChatItem(event, { ...item, id: itemId }, itemId));
    };

    const finishEmptyReasoningActivity = (event: AgentEventPayload) => {
        const itemId = event.item?.id;
        if (!itemId) return;
        const scopedId = scopeEventChatItem(event, { id: "synthetic:reasoning", role: "tool", text: "" }, "synthetic:reasoning").id;
        const currentMessages = useAgentStore.getState().messages;
        const index = currentMessages.findIndex((message) => message.id === scopedId);
        if (index < 0) return;
        const current = currentMessages[index];
        const activityItems = { ...(current.activityItems || {}) };
        delete activityItems[itemId];
        if (!Object.values(activityItems).some(isReasoningSummary)) {
            setAgentState({ messages: currentMessages.filter((_, itemIndex) => itemIndex !== index) });
            return;
        }
        setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, text: reasoningActivityText(activityItems), activityItems, detail: activityDetail(message.detail, "reasoning", "completed") } : message) });
    };

    const finishPlanActivity = (event: AgentEventPayload) => {
        const id = scopeEventChatItem(event, { id: "synthetic:plan", role: "tool", text: "" }, "synthetic:plan").id;
        const currentMessages = useAgentStore.getState().messages;
        const index = currentMessages.findIndex((message) => message.id === id);
        if (index < 0) return;
        const current = currentMessages[index];
        const detail = activityDetail(current.detail, "todo", turnPlanStatus(current.detail, event.status));
        setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, detail } : message) });
    };

    const showAgentError = (value: unknown, event?: AgentEventPayload, log = true) => {
        const error = agentErrorView(value);
        const item = event
            ? scopeEventChatItem(event, { id: "synthetic:error", role: "error", title: error.title, text: error.text }, "synthetic:error")
            : scopeChatItem({ id: createId(), role: "error", title: error.title, text: error.text }, useAgentStore.getState().activeThreadId, useAgentStore.getState().activeTurnId);
        const state = useAgentStore.getState();
        const current = state.messages.find((message) => message.id === item.id);
        if (current && !normalizeText(value)) return;
        upsertActivityMessage(item);
        setAgentState({ activity: rt("processingFailed"), pendingApprovals: [] });
        if (log) addEventLog(rt("processingFailed"), error.text, value);
    };

    // 非激活会话窗的后台事件：只写目标窗切片 + 累加该窗未读，绝不触碰激活窗的扁平字段。
    // 复用与激活窗相同的 formatter 帮助函数，保证两窗渲染一致。
    const handleBackgroundEvent = (windowId: string, payload: unknown) => {
        if (useAgentStore.getState().activeWindowId === windowId) return;
        const produced = withWindowPatchTarget(windowId, () => {
            const initial = agentWindowById(useAgentStore.getState(), windowId);
            if (!initial) return false;
            const conversation = payload as Partial<AgentConversationState> | null;
            if (conversation && typeof conversation === "object" && typeof conversation.revision === "number" && typeof conversation.conversationId === "string") {
                // conversation_changed：只有同一线程才更新该窗会话状态。
                if (!conversation.threadId || conversation.threadId !== initial.conversation.threadId) return false;
                const next = conversation as AgentConversationState;
                setAgentState({ conversation: next, ...conversationBootstrapView(next) });
                return true;
            }
            const chat = payload as AgentChatEvent | null;
            if (chat && chat.message) {
                const threadId = chat.threadId || chat.message.threadId || initial.activeThreadId || "";
                const turnId = chat.turnId ?? chat.message.turnId ?? "";
                setAgentState({ messages: upsertAgentMessage(initial.messages, scopeChatItem(chat.message, threadId, turnId)) });
                return true;
            }
            const event = payload as AgentEventPayload;
            const scope = eventScope(event);
            if (!scope.threadId) return false;
            if (event.type === "usage.updated") {
                setAgentState({ tokenUsage: eventUsage(event) });
                return true;
            }
            if (event.type === "turn.started") {
                const messages = scope.turnId ? bindPendingTurnMessages(initial.messages, scope.threadId, scope.turnId) : initial.messages;
                setAgentState({ activeTurnId: scope.turnId, waiting: true, sending: false, activity: rt("codexRunning"), bootstrapStatus: null, mcpStartupStatuses: {}, messages });
                return true;
            }
            if (event.type === "turn.completed") {
                const messages = initial.messages.map((message) => message.threadId === scope.threadId && message.turnId === scope.turnId && message.streamId ? { ...message, streamId: undefined } : message);
                setAgentState({
                    activeTurnId: initial.activeTurnId === scope.turnId ? "" : initial.activeTurnId,
                    waiting: false,
                    sending: false,
                    activity: event.status === "failed" ? rt("processingFailed") : event.status === "interrupted" ? rt("turnStopped") : rt("completed"),
                    messages,
                });
                return true;
            }
            if (event.type === "item.updated" && event.item?.type === "agent_message" && event.item.id) {
                const delta = stringText(event.item.delta);
                const text = delta || stringText(event.item.text);
                if (!text) return false;
                const scoped = scopeEventChatItem(event, { id: event.item.id, role: "assistant", title: "Codex", text, streamId: event.item.id }, event.item.id);
                const index = initial.messages.findIndex((message) => message.id === scoped.id);
                const messages = index < 0
                    ? [...initial.messages, scoped]
                    : initial.messages.map((message, itemIndex) => itemIndex === index ? { ...message, text: delta ? `${message.text}${text}` : mergeStreamText(message.text, text) } : message);
                setAgentState({ messages });
                return true;
            }
            if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.id) {
                const text = stringText(event.item.text);
                const scoped = scopeEventChatItem(event, { id: event.item.id, role: "assistant", title: "Codex", text }, event.item.id);
                const index = initial.messages.findIndex((message) => message.id === scoped.id);
                const messages = index >= 0
                    ? initial.messages.map((message, itemIndex) => itemIndex === index ? { ...message, text: text || message.text, streamId: undefined } : message)
                    : upsertAgentMessage(initial.messages, scoped);
                setAgentState({ messages });
                return true;
            }
            // 其它事件：只把日志记进该窗，配合未读提示。
            const log = formatAgentEventLog(event);
            if (!log) return false;
            setAgentState({ eventLogs: withAppendedEventLog(initial, { id: `${Date.now()}-${Math.random()}`, time: dayjs().format("YYYY-MM-DD HH:mm:ss"), title: log.title, text: log.text }).eventLogs });
            return true;
        });
        // 未读按「消息 / turn」计数：流式 delta、日志类事件不带 dedupeKey，不累加。
        const unreadKey = produced ? backgroundUnreadKey(payload) : null;
        if (unreadKey) useAgentStore.getState().noteWindowOutput(windowId, unreadKey);
    };

    const handleAgentEvent = async (event: AgentEventPayload) => {
        if (event.type === "usage.updated") setAgentState({ tokenUsage: eventUsage(event) });
        // Claude driver 的事件形状：assistant_delta 是增量，assistant_message 是最终全文。
        if ((event.type === "assistant_delta" || event.type === "assistant_message") && typeof event.text === "string" && event.text) {
            const chunk: string = event.text;
            const threadId = event.threadId || event.thread_id || "";
            const id = `claude-stream-${threadId}`;
            const isDelta = event.type === "assistant_delta";
            const currentMessages = useAgentStore.getState().messages;
            const index = currentMessages.findIndex((message) => message.id === id);
            if (index < 0) {
                pushMessage({ id, threadId, role: "assistant", title: "Claude", text: chunk, streamId: isDelta ? id : undefined });
                return;
            }
            setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, text: isDelta ? `${message.text}${chunk}` : chunk, streamId: isDelta ? id : undefined } : message) });
            return;
        }
        if (event.type === "tool_use" && event.name) {
            addEventLog(event.name, JSON.stringify(event.input ?? {}).slice(0, 500));
            return;
        }
        const log = event.replayed ? null : formatAgentEventLog(event);
        const activity = formatAgentActivity(event);
        if (log) addEventLog(log.title, log.text);
        if (event.type === "turn.started" && (event.turnId || event.turn_id)) {
            const scope = eventScope(event);
            const current = useAgentStore.getState();
            if (!scope.threadId || !scope.turnId) return;
            liveTurnKeysRef.current.add(`${scope.threadId}\0${scope.turnId}`);
            setAgentState({ activeTurnId: scope.turnId, bootstrapStatus: null, mcpStartupStatuses: {}, messages: bindPendingTurnMessages(current.messages, scope.threadId, scope.turnId) });
        }
        if (event.type === "item.updated" && event.item?.type === "agent_message" && event.item.id) {
            const delta = stringText(event.item.delta);
            appendStreamText(event, delta || stringText(event.item.text), Boolean(delta));
            return;
        }
        if (event.type === "item.updated" && event.item) {
            appendActivityDelta(event);
            return;
        }
        if (event.type === "plan.updated" && event.turn_id) {
            const plan = formatAgentPlan(event);
            if (plan) upsertActivityMessage(scopeEventChatItem(event, { ...plan, id: "synthetic:plan" }, "synthetic:plan"));
            return;
        }
        if (event.type === "item.completed" && event.item?.type === "error") {
            showAgentError(event.item.message, event, !event.replayed);
            return;
        }
        if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.id) {
            const scoped = scopeEventChatItem(event, { id: event.item.id, role: "assistant", title: "Codex", text: stringText(event.item.text) }, event.item.id);
            const currentMessages = useAgentStore.getState().messages;
            const index = currentMessages.findIndex((message) => message.id === scoped.id);
            if (index >= 0) {
                const text = stringText(event.item.text);
                setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, text: text || message.text, streamId: undefined } : message) });
                return;
            }
            addMessage(scoped);
            return;
        }
        if (event.type === "item.completed" && event.item?.type === "reasoning" && !activity) {
            finishEmptyReasoningActivity(event);
            return;
        }
        if (event.type === "item.completed" && !activity && event.item?.id && event.item.type === "plan") {
            const id = scopeEventChatItem(event, { id: event.item.id, role: "tool", text: "" }, event.item.id).id;
            setAgentState({ messages: useAgentStore.getState().messages.filter((item) => item.id !== id) });
            return;
        }
        if (!event.replayed && event.type === "item.completed" && event.item?.type === "image_generation" && event.item.id && event.sourceClientId === clientIdRef.current) {
            const generated = await importGeneratedImages(endpoint, token, event.item);
            if (generated.length) {
                const context = canvasContextRef.current;
                if (context) {
                    const right = Math.max(0, ...context.snapshot.nodes.map((node) => node.position.x + node.width)) + 80;
                    const ops = generated.map<CanvasAgentOp>((image, index) => {
                        const size = fitNodeSize(image.upload.width, image.upload.height);
                        return {
                            type: "add_node",
                            id: `image-${createId()}`,
                            nodeType: "image",
                            title: image.name,
                            position: { x: right + index * 40, y: index * 40 },
                            ...size,
                            metadata: imageMetadata(image.upload),
                        };
                    });
                    const newNodeIds = ops.flatMap((op) => (op.type === "add_node" && op.id ? [op.id] : []));
                    const links = referenceConnectionOps(turnReferenceNodeIdsRef.current, newNodeIds, context.snapshot.nodes.map((node) => node.id));
                    const result = context.applyOps([...ops, ...links]);
                    void postState(endpoint, token, clientIdRef.current, result);
                    requestAgentCaptureSilently(endpoint, token, { nodeId: newNodeIds[0], tag: "generate" });
                }
                addEventLog(rt("importGeneratedImages"), rt(context ? "addedToSourceCanvas" : "imageGenerated"));
            }
        }
        if (activity && event.item?.id) {
            upsertEventActivity(event, activity);
            return;
        }
        if (event.type === "turn.completed") {
            turnReferenceNodeIdsRef.current = [];
            const scope = eventScope(event);
            if (scope.turnId) {
                finishPlanActivity(event);
                liveTurnKeysRef.current.add(`${scope.threadId}\0${scope.turnId}`);
            }
            const current = useAgentStore.getState();
            setAgentState({
                activeTurnId: current.activeTurnId === scope.turnId ? "" : current.activeTurnId,
                messages: current.messages.map((message) => message.threadId === scope.threadId && message.turnId === scope.turnId && message.streamId ? { ...message, streamId: undefined } : message),
            });
            if (event.status === "failed") showAgentError(event.error?.message, event, !event.replayed);
        }
        const item = formatAgentEvent(event);
        if (item) addMessage(scopeEventChatItem(event, { ...item, id: event.item?.id || createId() }, event.item?.id || createId()));
    };

    const appendStreamText = (event: AgentEventPayload, text: string, isDelta = false) => {
        if (!text) return;
        const itemId = event.item?.id;
        if (!itemId) return;
        const scoped = scopeEventChatItem(event, { id: itemId, role: "assistant", title: "Codex", text, streamId: itemId }, itemId);
        const currentMessages = useAgentStore.getState().messages;
        const index = currentMessages.findIndex((message) => message.id === scoped.id);
        if (index < 0) {
            pushMessage(scoped);
            return;
        }
        setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, text: isDelta ? `${message.text}${text}` : mergeStreamText(message.text, text) } : message) });
    };

    const connectionStatus = t(connectError ? "agent.status.failed" : connected ? "agent.status.connected" : enabled ? "agent.status.connecting" : "agent.status.disconnected");
    const connectionStatusColor = connectError ? "#dc2626" : connected ? "#16a34a" : enabled ? "#d97706" : theme.node.muted;
    const content = (
        <>
            <AgentWindowTabs />
            <AgentPanelTabs
                value={activeTab}
                theme={theme}
                leading={
                    <div className="flex items-center gap-1">
                        <span className="grid size-8 place-items-center">
                            <Bot className="size-4" />
                        </span>
                        <div className="hidden text-base font-semibold leading-5 @min-[560px]:block">Agent</div>
                        <Tooltip title={t("agent.panel.connectionSettings", { status: connectionStatus })} placement="bottom">
                            <Button size="small" type="text" className="!h-8 !w-8 !min-w-8 !px-0 @min-[560px]:!w-auto @min-[560px]:!min-w-0 @min-[560px]:!px-[7px]" aria-label={t("agent.panel.connectionSettingsLabel", { status: connectionStatus })} icon={<PlugZap className="size-3.5" style={{ color: connectionStatusColor }} />} onClick={() => setAgentState({ activeTab: "setup" })}>
                                <span className="hidden @min-[560px]:inline">{connectionStatus}</span>
                            </Button>
                        </Tooltip>
                    </div>
                }
                items={[
                    { value: "chat", label: t("agent.panel.chat"), icon: <MessageSquare className="size-3.5" /> },
                    { value: "history", label: t("agent.panel.history"), icon: <History className="size-3.5" />, count: threads.length },
                    { value: "skills", label: t("agent.panel.skills"), icon: <Sparkles className="size-3.5" />, count: skillCount },
                    { value: "log", label: t("agent.panel.logs"), icon: <Terminal className="size-3.5" />, count: eventLogs.length },
                    { value: "wall", label: t("agent.panel.wall"), icon: <Images className="size-3.5" /> },
                ]}
                onChange={(activeTab) => {
                    setAgentState({ activeTab });
                    if (activeTab === "history") void loadThreads();
                }}
                right={
                    <>
                        <AgentRepoBadge />
                        {drivers.length > 1 ? (
                            <Segmented
                                size="small"
                                value={driverId}
                                aria-label={t("agent.panel.driver")}
                                onChange={(value) => switchAgentDriver(value as AgentDriverId)}
                                options={drivers.map((entry) => ({ label: entry.available ? entry.label : `${entry.label} · ${t("agent.panel.driverMissing")}`, value: entry.id, disabled: !entry.available }))}
                            />
                        ) : null}
                        <Segmented
                            size="small"
                            value={cliMode ? "cli" : "gui"}
                            aria-label={t("agent.panel.viewMode")}
                            onChange={(value) => setAgentState({ cliMode: value === "cli" })}
                            options={[
                                { label: t("agent.panel.gui"), value: "gui" },
                                { label: t("agent.panel.cli"), value: "cli" },
                            ]}
                        />
                        <Tooltip title={t("agent.history.newThread")} placement="bottom">
                            <Button size="small" type="text" className="!h-8 !w-8 !min-w-8 !px-0 @min-[560px]:!w-auto @min-[560px]:!min-w-0 @min-[560px]:!px-[7px]" aria-label={t("agent.history.newThread")} disabled={!connected || loadingThreads || sending || waiting || conversationBusy} icon={<MessageSquarePlus className="size-3.5" />} onClick={startNewThread}>
                                <span className="hidden @min-[560px]:inline">{t("agent.history.newThread")}</span>
                            </Button>
                        </Tooltip>
                        <Tooltip title={t("agent.panel.collapse")}>
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" aria-label={t("agent.panel.collapseLabel")} style={{ color: theme.node.muted }} icon={<PanelRightClose className="size-4" />} onClick={closePanel} />
                        </Tooltip>
                    </>
                }
            />

            {quotaKey ? (
                <div
                    role="status"
                    className="mx-3 mt-2 rounded-md px-3 py-1.5 text-xs"
                    style={{
                        background: quota.level === "exhausted" ? "rgba(239,68,68,0.12)" : "rgba(245,158,11,0.12)",
                        color: quota.level === "exhausted" ? "#ef4444" : "#f59e0b",
                    }}
                >
                    {quotaText}
                </div>
            ) : null}

            {cliMode ? (
                <EmbeddedTerminal agentUrl={endpoint} agentToken={token} canvasId={`agent-panel-${activeWindowId}`} session={cliSession} onSession={(id) => setAgentState({ cliSession: id })} />
            ) : activeTab === "setup" ? (
                <AgentConnectView
                    theme={theme}
                    url={url}
                    token={token}
                    enabled={enabled}
                    connected={connected}
                    activity={activity}
                    connectError={connectError}
                    onUrlChange={(url) => setAgentState({ url, connectError: "" })}
                    onTokenChange={(token) => setAgentState({ token, connectError: "" })}
                    onToggleEnabled={toggleAgentConnection}
                />
            ) : activeTab === "skills" ? (
                <AgentSkillsView clientId={clientIdRef.current} />
            ) : activeTab === "history" ? (
                <AgentHistoryView
                    theme={theme}
                    threads={threads}
                    activeThreadId={activeThreadId}
                    workspacePath={workspacePath}
                    loading={loadingThreads}
                    busy={sending || waiting || conversationBusy}
                    connected={connected}
                    onRefresh={() => void loadThreads()}
                    onNewThread={() => void startNewThread()}
                    onResumeThread={(threadId) => void resumeThread(threadId)}
                    onDeleteThreads={confirmDeleteThreads}
                />
            ) : activeTab === "wall" ? (
                <AgentWallView theme={theme} endpoint={endpoint} token={token} connected={connected} />
            ) : activeTab === "log" ? (
                <AgentLogView
                    logs={eventLogs}
                    theme={theme}
                    context={{ endpoint, connected, enabled, activity, waiting, sending, messages: messageCount, pendingTool: pendingTool?.name }}
                    onClear={clearEventLogs}
                    onCopied={(text) => message.success(text)}
                    onCopyBlocked={(text) => message.warning(text)}
                />
            ) : (
                <>
                    <AgentContextBar theme={theme} />
                    <AgentChatTimeline theme={theme} pendingTool={pendingTool} pendingApprovals={pendingApprovals} sending={sending} waiting={waiting} onRejectTool={rejectPendingTool} onApproveTool={approvePendingTool} onApprovalDecision={decideApproval} />
                    <AgentTaskProgress theme={theme} busy={sending || waiting} />
                    {tokenUsage ? <AgentUsageBar usage={tokenUsage} theme={theme} /> : null}
                    <AgentChatComposer
                        prompt={prompt}
                        attachments={attachments.map((attachment) => agentAttachmentToChatAttachment(attachment, endpoint, token))}
                        disabled={!connected || !conversationReady || loadingThreads}
                        sending={sending || waiting}
                        placeholder={conversation.status === "idle" || conversation.status === "preparing"
                            ? t("agent.panel.mcpInitializing")
                            : conversation.status === "failed"
                                ? t("agent.panel.initFailed")
                                : t("agent.panel.placeholder")}
                        theme={theme}
                        onPromptChange={(prompt) => setAgentState({ prompt })}
                        onSubmit={sendPrompt}
                        onStop={stopTurn}
                        onAddFiles={addAttachments}
                        onRemoveAttachment={removeAttachment}
                        confirmTools={confirmTools}
                        onConfirmToolsChange={(confirmTools) => setAgentState({ confirmTools })}
                        permissionMode={permissionMode}
                        onPermissionModeChange={changePermissionMode}
                        models={models}
                        model={model}
                        reasoningEffort={reasoningEffort}
                        onModelChange={(model) => {
                            const selected = models.find((item) => item.model === model);
                            if (!selected) return;
                            const effort = selected.defaultReasoningEffort || selected.supportedReasoningEfforts[0]?.reasoningEffort;
                            localStorage.setItem("canvas-agent-model", model);
                            if (effort) localStorage.setItem("canvas-agent-reasoning-effort", effort);
                            setAgentState({ model, ...(effort ? { reasoningEffort: effort } : {}) });
                        }}
                        onReasoningEffortChange={(reasoningEffort) => {
                            localStorage.setItem("canvas-agent-reasoning-effort", reasoningEffort);
                            setAgentState({ reasoningEffort });
                        }}
                        left={
                            attachments.length ? (
                                <span className="hidden text-[11px] @min-[660px]:inline" style={{ color: theme.node.muted }}>
                                    {formatBytes(attachmentPayloadBytes(attachments))} / 30MB
                                </span>
                            ) : null
                        }
                    />
                </>
            )}
        </>
    );

    if (headless) return null;
    return embedded ? content : null;
}

function acquireAgentClientId() {
    const scope = globalThis as AgentClientGlobal;
    scope.__canvasAgentsClientIdPromise ||= (async () => {
        const storedClientId = readAgentClientId();
        let clientId = storedClientId || randomId();
        if (!navigator.locks) {
            if (!storedClientId) saveAgentClientId(clientId);
            return clientId;
        }
        while (true) {
            const acquired = await new Promise<boolean>((resolve, reject) => {
                void navigator.locks.request(`${APP_ID}-agent:${clientId}`, { ifAvailable: true }, async (lock) => {
                    if (!lock) return resolve(false);
                    resolve(true);
                    await new Promise<void>(() => undefined);
                }).catch(reject);
            });
            if (acquired) {
                saveAgentClientId(clientId);
                return clientId;
            }
            clientId = randomId();
        }
    })().catch(() => {
        const clientId = randomId();
        saveAgentClientId(clientId);
        return clientId;
    });
    return scope.__canvasAgentsClientIdPromise;
}

function readAgentClientId() {
    try {
        return sessionStorage.getItem("canvas-agent-client-id") || "";
    } catch {
        return "";
    }
}

function saveAgentClientId(clientId: string) {
    try {
        sessionStorage.setItem("canvas-agent-client-id", clientId);
    } catch {
        // The in-memory identity still keeps request ownership consistent within the current page session.
    }
}

function eventScope(event: AgentEventPayload) {
    return {
        threadId: event.threadId || event.thread_id || "",
        turnId: event.turnId || event.turn_id || "",
    };
}

function scopeEventChatItem(event: AgentEventPayload, item: AgentChatItem, itemId: string) {
    const scope = eventScope(event);
    return scopeChatItem({ ...item, itemId }, scope.threadId, scope.turnId);
}

function approvalActivity(pendingApprovals: AgentPendingApproval[], waiting: boolean, fallback: string) {
    if (pendingApprovals.length) return rt("awaitingApproval");
    return waiting ? rt("codexRunning") : fallback;
}

async function attachmentNodeOps(endpoint: string, token: string, clientId: string, value: unknown): Promise<CanvasAgentOp[]> {
    const nodes = Array.isArray(value) ? value : [];
    if (!nodes.length) throw new Error(rt("noImageAttachments"));
    return await Promise.all(
        nodes.map(async (value) => {
            const item = value as { id?: unknown; attachmentId?: unknown; title?: unknown; position?: unknown };
            const id = String(item.id || "");
            const attachmentId = String(item.attachmentId || "");
            if (!id || !attachmentId) throw new Error(rt("invalidAttachmentNode"));
            const res = await fetch(`${endpoint}/agent/attachments/${encodeURIComponent(attachmentId)}?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`);
            if (!res.ok) {
                const body = (await res.json().catch(() => null)) as { error?: string } | null;
                throw new Error(body?.error || rt("attachmentReadFailed"));
            }
            const image = await uploadImage(await res.blob());
            const size = fitNodeSize(image.width, image.height);
            const position = item.position && typeof item.position === "object" ? (item.position as { x?: unknown; y?: unknown }) : {};
            return {
                type: "add_node" as const,
                id,
                nodeType: "image" as const,
                title: String(item.title || rt("referenceImage")),
                position: { x: Number(position.x) || 0, y: Number(position.y) || 0 },
                width: size.width,
                height: size.height,
                metadata: imageMetadata(image),
            };
        }),
    );
}

function createId() {
    return randomId();
}

async function createMessageAttachmentMetadata(item: AgentAttachment) {
    const url = Math.max(item.width, item.height) > MESSAGE_PREVIEW_LONG_EDGE || item.dataUrl.length > MESSAGE_PREVIEW_MAX_LENGTH
        ? await upscaleDataUrl(item.dataUrl, { targetLongEdge: MESSAGE_PREVIEW_LONG_EDGE, algorithm: "high" })
        : item.dataUrl;
    return { id: item.id, name: item.name, type: item.type, size: item.size, width: item.width, height: item.height, url };
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

async function importGeneratedImages(endpoint: string, token: string, item: AgentEventItem) {
    const sources = Array.from(generatedImageSources(item));
    return await Promise.all(
        sources.map(async (source, index) => {
            const response = source.startsWith("data:image/")
                ? await fetch(source)
                : await fetch(`${endpoint}/agent/local-image?token=${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: source }) });
            if (!response.ok) throw new Error(rt("generatedImageReadFailed"));
            const blob = await response.blob();
            const upload = await uploadImage(blob);
            const dataUrl = await readDataUrl(blob);
            const name = source.startsWith("/") ? source.split("/").at(-1) || rt("generatedImageName", { index: index + 1 }) : rt("generatedImageName", { index: index + 1 });
            return { upload, name, attachment: { id: createId(), name, type: blob.type || upload.mimeType, size: blob.size, width: upload.width, height: upload.height, url: upload.url, dataUrl } };
        }),
    );
}

function generatedImageSources(value: unknown, result = new Set<string>()) {
    if (typeof value === "string") {
        if (value.startsWith("data:image/") || (/^\/.+\.(?:avif|gif|jpe?g|png|webp)$/i.test(value) && !value.includes("\n"))) result.add(value);
        return result;
    }
    if (Array.isArray(value)) value.forEach((item) => generatedImageSources(item, result));
    else if (value && typeof value === "object") Object.values(value).forEach((item) => generatedImageSources(item, result));
    return result;
}

function readDataUrl(file: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error(rt("imageReadFailed")));
        reader.readAsDataURL(file);
    });
}

function delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
