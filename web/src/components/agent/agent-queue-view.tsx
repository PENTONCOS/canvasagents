import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Modal } from "antd";
import { Ban, CheckCircle2, Clock, LoaderCircle, RefreshCw, ShieldQuestion } from "lucide-react";
import { useTranslation } from "react-i18next";

import { agentApiPath } from "@/lib/agent/agent-driver";
import {
    approvalForThread,
    availableQueueActions,
    queueActionNeedsConfirm,
    queueApprovalDecision,
    queueStatusAfter,
    type QueueActionId,
    type QueueApprovalRequest,
    type QueueStatus,
} from "@/lib/agent/agent-queue-actions";
import { continueQueueThread, decideQueueApproval, openQueueThread } from "@/lib/agent/agent-queue-runner";
import { windowLabelForThread } from "@/lib/agent/agent-windows";
import { fetchAgentJson } from "@/services/api/canvas-agent";
import { useAgentStore } from "@/stores/use-agent-store";

export type { QueueStatus };

// M5: global task queue. Aggregates every agent thread and labels each one with a
// single glanceable state (approval / running / waiting-input / idle / failed).
// H2: 队列即入口 —— 一条任务在队列里就能看、能批、能拒、能续，不必先跳回会话窗再找卡片。
type QueueItem = {
    id: string;
    title: string;
    status: QueueStatus;
    active: boolean;
    /** 桥端按线程上报：这条线程此刻真的在跑（后台窗也算）。 */
    running?: boolean;
    waitingFor?: string;
    updatedAt?: number;
};

type QueueResponse = {
    ok?: boolean;
    data?: QueueItem[];
    busyThreadIds?: string[];
    /** H2：每条待审批请求的 requestId + 归属线程；队列靠它一键批准。 */
    pendingApprovalRequests?: QueueApprovalRequest[];
};
type ThreadsResponse = { ok?: boolean; data?: Array<Record<string, unknown>> };

const STATUS_ORDER: QueueStatus[] = ["approval", "running", "waiting-input", "idle", "failed"];

export function AgentQueueView() {
    const { t } = useTranslation();
    const open = useAgentStore((state) => state.queueOpen);
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const endpoint = useAgentStore((state) => state.url);
    const token = useAgentStore((state) => state.token);
    const threads = useAgentStore((state) => state.threads);
    const activeThreadId = useAgentStore((state) => state.activeThreadId);
    const sending = useAgentStore((state) => state.sending);
    const waiting = useAgentStore((state) => state.waiting);
    const pendingApprovals = useAgentStore((state) => state.pendingApprovals);
    const conversation = useAgentStore((state) => state.conversation);

    const [items, setItems] = useState<QueueItem[]>([]);
    const [busyThreadIds, setBusyThreadIds] = useState<string[]>([]);
    const [approvalRequests, setApprovalRequests] = useState<QueueApprovalRequest[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    // 行级反馈：正在处理哪一条、失败原因、以及操作后的乐观状态（下一次成功 reload 后清掉）。
    const [busyAction, setBusyAction] = useState<Record<string, QueueActionId | "">>({});
    const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
    const [statusOverrides, setStatusOverrides] = useState<Record<string, QueueStatus>>({});
    const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const [modal, modalContextHolder] = Modal.useModal();
    const windows = useAgentStore((state) => state.windows);

    // Live state of the currently running turn; non-active threads are historical.
    const liveStatus: QueueStatus = useMemo(() => {
        if (pendingApprovals.length) return "approval";
        if (sending || waiting || conversation.status === "running") return "running";
        if (conversation.status === "failed") return "failed";
        return "idle";
    }, [pendingApprovals.length, sending, waiting, conversation.status]);

    const load = useCallback(async () => {
        if (!endpoint || !token) {
            setItems([]);
            return;
        }
        setLoading(true);
        setError("");
        try {
            const data = await fetchAgentJson<QueueResponse>(endpoint, token, "/agent/queue");
            setItems(Array.isArray(data.data) ? data.data : []);
            setBusyThreadIds(Array.isArray(data.busyThreadIds) ? data.busyThreadIds : []);
            setApprovalRequests(Array.isArray(data.pendingApprovalRequests) ? data.pendingApprovalRequests : []);
            // 服务端已给真值：乐观状态可以退场，避免队列一直停在「本地以为的样子」。
            setStatusOverrides({});
        } catch (primary) {
            // Older agents without /queue: fall back to the threads list.
            try {
                const data = await fetchAgentJson<ThreadsResponse>(endpoint, token, agentApiPath("/threads"));
                const list = Array.isArray(data.data) ? data.data : [];
                setItems(list.map((thread) => ({
                    id: String(thread.id || ""),
                    title: String(thread.name || thread.preview || thread.id || ""),
                    status: "idle" as QueueStatus,
                    active: false,
                })));
                setBusyThreadIds([]);
                setApprovalRequests([]);
            } catch (fallback) {
                const reason = fallback instanceof Error ? fallback.message : String(fallback);
                setError(primary instanceof Error ? `${primary.message} · ${reason}` : reason);
                setItems([]);
                setApprovalRequests([]);
            }
        } finally {
            setLoading(false);
        }
    }, [endpoint, token]);

    useEffect(() => {
        if (!open) return;
        void load();
        const timer = setInterval(() => void load(), 5000);
        return () => clearInterval(timer);
    }, [open, load]);

    // Server truth when available; otherwise derive from the local thread list.
    // 多窗并行时不能只拿激活窗的本地状态盖住别的线程：服务端已按线程报 running，
    // 只在「老桥端不报 running」时才用激活窗本地状态兜底。
    const derived: QueueItem[] = useMemo(() => {
        const source: QueueItem[] = items.length
            ? items
            : threads.map((thread) => ({ id: thread.id, title: thread.name || thread.preview || thread.id, status: "idle" as QueueStatus, active: false, running: false }));
        return source.map((item) => {
            const running = item.running === true || Boolean(item.id && busyThreadIds.includes(item.id));
            const active = Boolean(item.id && item.id === activeThreadId);
            // 操作后的乐观状态优先于服务端旧值，但优先于「激活窗本地兜底」之上：
            // 刚批完的那一条不该被另一边还没刷新的 failed 又盖回去。
            const overridden = statusOverrides[item.id];
            if (overridden) return { ...item, status: overridden, running, active };
            const upgraded = active && !running && ["running", "approval", "failed"].includes(liveStatus);
            return { ...item, status: upgraded ? liveStatus : item.status, running, active };
        });
    }, [items, threads, activeThreadId, liveStatus, busyThreadIds, statusOverrides]);

    const groups = useMemo(
        () => STATUS_ORDER.map((status) => ({ status, list: derived.filter((item) => item.status === status) })).filter((group) => group.list.length > 0),
        [derived],
    );

    const confirmDecline = useCallback((title: string) => new Promise<boolean>((resolve) => {
        modal.confirm({
            title: t("agent.queue.declineConfirmTitle"),
            content: `${title} — ${t("agent.queue.declineConfirmContent")}`,
            okText: t("agent.queue.declineConfirmOk"),
            okButtonProps: { danger: true },
            cancelText: t("common.cancel"),
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
        });
    }), [modal, t]);

    /**
     * 队列里的四个动作共用一条执行路径：确认（只有拒绝要）→ 打桥端 → 立刻改这条的状态。
     * 任何失败都落到 `rowErrors`（行内可见），绝不静默 —— 静默失败正是这次要修的东西。
     */
    const runAction = useCallback(async (item: QueueItem, action: QueueActionId, approval: QueueApprovalRequest | null) => {
        if (!endpoint || !token) return;
        if (busyAction[item.id]) return;
        if (queueActionNeedsConfirm(action) && !(await confirmDecline(item.title || item.id))) return;
        setBusyAction((state) => ({ ...state, [item.id]: action }));
        setRowErrors((state) => {
            const next = { ...state };
            delete next[item.id];
            return next;
        });
        try {
            if (action === "open") {
                await openQueueThread(endpoint, token, item.id);
                setAgentState({ activeTab: "chat", queueOpen: false });
                return;
            }
            if (action === "approve" || action === "decline") {
                if (!approval?.requestId) throw new Error(t("agent.queue.errors.approve"));
                await decideQueueApproval(endpoint, token, approval.requestId, queueApprovalDecision(action));
            } else {
                await continueQueueThread(endpoint, token, item.id);
            }
            setStatusOverrides((state) => ({ ...state, [item.id]: queueStatusAfter(action, item.status) }));
        } catch (failure) {
            const reason = failure instanceof Error ? failure.message : String(failure);
            setRowErrors((state) => ({ ...state, [item.id]: `${t(`agent.queue.errors.${action}`)}: ${reason}` }));
        } finally {
            setBusyAction((state) => ({ ...state, [item.id]: "" }));
        }
    }, [busyAction, confirmDecline, endpoint, setAgentState, t, token]);

    const statusLabel = (status: QueueStatus) => t(`agent.queue.statuses.${status === "waiting-input" ? "waitingInput" : status}`);
    const statusIcon = (status: QueueStatus) => {
        if (status === "approval") return <ShieldQuestion className="size-3.5 text-amber-600" />;
        if (status === "running") return <LoaderCircle className="size-3.5 animate-spin text-blue-600" />;
        if (status === "waiting-input") return <Clock className="size-3.5 text-indigo-600" />;
        if (status === "failed") return <Ban className="size-3.5 text-red-600" />;
        return <CheckCircle2 className="size-3.5 text-stone-400" />;
    };

    const actionLabel = (action: QueueActionId) => t(`agent.queue.actions.${action}`);

    return (
        <>
            {modalContextHolder}
            <Modal
                open={open}
                onCancel={() => setAgentState({ queueOpen: false })}
                footer={null}
                width={560}
                title={(
                    <div className="flex items-center justify-between gap-3 pr-6">
                        <span>{t("agent.queue.title")}</span>
                        <button
                            type="button"
                            onClick={() => void load()}
                            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-normal text-stone-500 transition hover:bg-stone-100 dark:hover:bg-stone-800"
                        >
                            <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
                            {t("agent.queue.refresh")}
                        </button>
                    </div>
                )}
            >
                {error ? <div className="py-6 text-center text-sm text-red-600">{error}</div> : null}
                {!error && groups.length === 0 ? (
                    <div className="py-8 text-center text-sm text-stone-400">{loading ? t("agent.queue.loading") : t("agent.queue.empty")}</div>
                ) : null}
                {!error && groups.length > 0 ? (
                    <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
                        {groups.map((group) => (
                            <div key={group.status}>
                                <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-stone-500">
                                    {statusIcon(group.status)}
                                    <span>{statusLabel(group.status)}</span>
                                    <span className="rounded-full bg-stone-100 px-1.5 text-[11px] tabular-nums dark:bg-stone-800">{group.list.length}</span>
                                </div>
                                <div className="flex flex-col gap-1">
                                    {group.list.map((item) => {
                                        // 窗口维度：这一条属于哪个会话窗（序号:名称），是否正在跑。
                                        const windowLabel = windowLabelForThread(windows, item.id);
                                        const approval = approvalForThread(item.id, approvalRequests);
                                        const actions = availableQueueActions({ status: item.status, approval });
                                        const busy = busyAction[item.id] || "";
                                        const rowError = rowErrors[item.id] || "";
                                        return (
                                            <div key={item.id} className="rounded-lg border border-stone-200 px-3 py-2 text-sm dark:border-stone-800">
                                                <div
                                                    ref={(node) => { rowRefs.current[item.id] = node; }}
                                                    role="button"
                                                    tabIndex={0}
                                                    data-queue-thread={item.id}
                                                    data-queue-status={item.status}
                                                    data-queue-running={item.running ? "true" : "false"}
                                                    data-queue-open={item.id}
                                                    aria-label={`${actionLabel("open")}: ${item.title || item.id}`}
                                                    onClick={() => void runAction(item, "open", approval)}
                                                    onKeyDown={(event) => {
                                                        if (event.key !== "Enter" && event.key !== " ") return;
                                                        event.preventDefault();
                                                        // 键盘用户先落在这一行，再跳窗：焦点确实落在「该条」上。
                                                        rowRefs.current[item.id]?.focus();
                                                        void runAction(item, "open", approval);
                                                    }}
                                                    className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-1 py-0.5 text-left outline-none transition hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-stone-300 dark:hover:bg-stone-800/60"
                                                >
                                                    <span className={`min-w-0 flex-1 truncate ${item.active ? "font-medium" : ""}`}>{item.title || item.id}</span>
                                                    {windowLabel ? <span data-queue-window={windowLabel} className="shrink-0 rounded bg-stone-100 px-1.5 text-[11px] text-stone-500 dark:bg-stone-800">{windowLabel}</span> : null}
                                                    {item.running ? <span data-queue-running-label className="shrink-0 text-[11px] text-blue-600">{t("agent.window.status.running")}</span> : null}
                                                    {item.active ? <span className="shrink-0 rounded bg-stone-100 px-1.5 text-[11px] text-stone-500 dark:bg-stone-800">{t("agent.queue.current")}</span> : null}
                                                    {item.waitingFor ? <span className="max-w-32 shrink-0 truncate text-[11px] text-amber-600">{item.waitingFor}</span> : null}
                                                    {!item.waitingFor && approval?.method ? <span className="max-w-32 shrink-0 truncate text-[11px] text-amber-600">{t("agent.queue.approvalRequest", { method: approval.method })}</span> : null}
                                                </div>
                                                {actions.length > 0 ? (
                                                    <div className="mt-1.5 flex items-center justify-end gap-1.5">
                                                        {busy ? <span data-queue-busy={item.id} className="mr-auto text-[11px] text-stone-400">{t("agent.queue.actionRunning")}</span> : null}
                                                        {actions.includes("approve") ? (
                                                            <button
                                                                type="button"
                                                                data-queue-approve={item.id}
                                                                disabled={Boolean(busy)}
                                                                onClick={(event) => { event.stopPropagation(); void runAction(item, "approve", approval); }}
                                                                className="rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white transition disabled:opacity-50"
                                                            >
                                                                {actionLabel("approve")}
                                                            </button>
                                                        ) : null}
                                                        {actions.includes("decline") ? (
                                                            <button
                                                                type="button"
                                                                data-queue-decline={item.id}
                                                                disabled={Boolean(busy)}
                                                                onClick={(event) => { event.stopPropagation(); void runAction(item, "decline", approval); }}
                                                                className="rounded-md border border-red-300 px-2 py-1 text-[11px] font-medium text-red-600 transition disabled:opacity-50 dark:border-red-900"
                                                            >
                                                                {actionLabel("decline")}
                                                            </button>
                                                        ) : null}
                                                        {actions.includes("continue") ? (
                                                            <button
                                                                type="button"
                                                                data-queue-continue={item.id}
                                                                disabled={Boolean(busy)}
                                                                onClick={(event) => { event.stopPropagation(); void runAction(item, "continue", approval); }}
                                                                className="rounded-md border border-stone-300 px-2 py-1 text-[11px] font-medium text-stone-700 transition disabled:opacity-50 dark:border-stone-700 dark:text-stone-200"
                                                            >
                                                                {actionLabel("continue")}
                                                            </button>
                                                        ) : null}
                                                    </div>
                                                ) : null}
                                                {rowError ? (
                                                    <div data-queue-error={item.id} className="mt-1.5 rounded-md bg-red-50 px-2 py-1 text-[11px] text-red-600 dark:bg-red-950/40">
                                                        {rowError}
                                                    </div>
                                                ) : null}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>
                ) : null}
            </Modal>
        </>
    );
}
