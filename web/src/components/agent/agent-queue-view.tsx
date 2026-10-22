import { useCallback, useEffect, useMemo, useState } from "react";

import { Modal } from "antd";
import { Ban, CheckCircle2, Clock, LoaderCircle, RefreshCw, ShieldQuestion } from "lucide-react";
import { useTranslation } from "react-i18next";

import { agentApiPath } from "@/lib/agent/agent-driver";
import { windowLabelForThread } from "@/lib/agent/agent-windows";
import { fetchAgentJson } from "@/services/api/canvas-agent";
import { useAgentStore } from "@/stores/use-agent-store";

// M5: global task queue. Aggregates every agent thread and labels each one with a
// single glanceable state (approval / running / waiting-input / idle / failed).
export type QueueStatus = "waiting-input" | "approval" | "running" | "idle" | "failed";

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

type QueueResponse = { ok?: boolean; data?: QueueItem[]; busyThreadIds?: string[] };
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
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
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
            } catch (fallback) {
                const reason = fallback instanceof Error ? fallback.message : String(fallback);
                setError(primary instanceof Error ? `${primary.message} · ${reason}` : reason);
                setItems([]);
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
            const upgraded = active && !running && ["running", "approval", "failed"].includes(liveStatus);
            return { ...item, status: upgraded ? liveStatus : item.status, running, active };
        });
    }, [items, threads, activeThreadId, liveStatus, busyThreadIds]);

    const groups = useMemo(
        () => STATUS_ORDER.map((status) => ({ status, list: derived.filter((item) => item.status === status) })).filter((group) => group.list.length > 0),
        [derived],
    );

    const statusLabel = (status: QueueStatus) => t(`agent.queue.statuses.${status === "waiting-input" ? "waitingInput" : status}`);
    const statusIcon = (status: QueueStatus) => {
        if (status === "approval") return <ShieldQuestion className="size-3.5 text-amber-600" />;
        if (status === "running") return <LoaderCircle className="size-3.5 animate-spin text-blue-600" />;
        if (status === "waiting-input") return <Clock className="size-3.5 text-indigo-600" />;
        if (status === "failed") return <Ban className="size-3.5 text-red-600" />;
        return <CheckCircle2 className="size-3.5 text-stone-400" />;
    };

    return (
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
                                    return (
                                    <div
                                        key={item.id}
                                        data-queue-thread={item.id}
                                        data-queue-running={item.running ? "true" : "false"}
                                        className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 px-3 py-2 text-sm dark:border-stone-800"
                                    >
                                        <span className={`min-w-0 flex-1 truncate ${item.active ? "font-medium" : ""}`}>{item.title || item.id}</span>
                                        {windowLabel ? <span data-queue-window={windowLabel} className="shrink-0 rounded bg-stone-100 px-1.5 text-[11px] text-stone-500 dark:bg-stone-800">{windowLabel}</span> : null}
                                        {item.running ? <span data-queue-running-label className="shrink-0 text-[11px] text-blue-600">{t("agent.window.status.running")}</span> : null}
                                        {item.active ? <span className="shrink-0 rounded bg-stone-100 px-1.5 text-[11px] text-stone-500 dark:bg-stone-800">{t("agent.queue.current")}</span> : null}
                                        {item.waitingFor ? <span className="max-w-32 shrink-0 truncate text-[11px] text-amber-600">{item.waitingFor}</span> : null}
                                    </div>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </div>
            ) : null}
        </Modal>
    );
}
