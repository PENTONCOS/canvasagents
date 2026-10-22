/**
 * H2「队列即入口」的纯决策层：队列里每一条能做什么、要不要二次确认、做完之后这条该显示什么状态。
 *
 * 刻意不碰 store / fetch / React：队列视图只负责把服务端状态喂进来、把这里的结论渲染成按钮，
 * 单测也就能直接证明「哪些状态可批准 / 可继续」而不是靠点一遍 UI 去猜。
 */

export type QueueStatus = "waiting-input" | "approval" | "running" | "idle" | "failed";

export type QueueActionId = "open" | "approve" | "decline" | "continue";

/** 服务端 `/agent/queue` 带回的一条待审批请求（批准要按 requestId 回传）。 */
export type QueueApprovalRequest = {
    requestId: string;
    threadId?: string;
    method?: string;
    reason?: string;
};

export type QueueActionInput = {
    status: QueueStatus;
    /** 该线程当前挂着的审批；没有 requestId 就不能在队列里批。 */
    approval?: QueueApprovalRequest | null;
};

/** 展示顺序：先看（打开），再低风险的批准/继续，最后才是危险动作。 */
export const QUEUE_ACTION_ORDER: QueueActionId[] = ["open", "continue", "approve", "decline"];

/**
 * 一条队列项可用的动作。
 * - `open`：任何一条都能跳到对应会话窗（H1 的跳转，不因加了按钮而退步）。
 * - `approve` / `decline`：只有「权限确认」态且拿得到 requestId 才能直接处置。
 * - `continue`：失败 / 等待输入的线程可以直接续跑，其余状态不该有「继续」。
 */
export function availableQueueActions({ status, approval }: QueueActionInput): QueueActionId[] {
    const actions: QueueActionId[] = ["open"];
    if (status === "approval" && approval?.requestId) actions.push("approve", "decline");
    if (status === "failed" || status === "waiting-input") actions.push("continue");
    return QUEUE_ACTION_ORDER.filter((action) => actions.includes(action));
}

/**
 * 危险动作必须二次确认：拒绝会让这一轮直接拿不到权限且不可撤回；
 * 批准与继续都是一键即可的低风险动作，多一步确认只会让人懒得用。
 */
export function queueActionNeedsConfirm(action: QueueActionId): boolean {
    return action === "decline";
}

/** 队列按钮上的动作 → 桥端 `/approval` 的 decision。 */
export function queueApprovalDecision(action: "approve" | "decline"): "accept" | "decline" {
    return action === "approve" ? "accept" : "decline";
}

/**
 * 操作后这条队列项该立刻变成什么状态（乐观反馈，随后以服务端 reload 为准）。
 * 批准 / 拒绝 / 继续都会让线程重新动起来；打开什么都没改变。
 */
export function queueStatusAfter(action: QueueActionId, status: QueueStatus): QueueStatus {
    if (action === "open") return status;
    return "running";
}

/** 按线程取审批请求：队列项只有 threadId，requestId 得从服务端给的清单里对出来。 */
export function approvalForThread(threadId: string, approvals: QueueApprovalRequest[] | undefined | null): QueueApprovalRequest | null {
    if (!threadId || !Array.isArray(approvals)) return null;
    // 老桥端可能不报 threadId（全局审批）：这种空 threadId 的请求也认，但只在没有更精确匹配时。
    const exact = approvals.find((item) => item.requestId && item.threadId === threadId);
    if (exact) return exact;
    const scoped = approvals.filter((item) => item.requestId && !item.threadId);
    return scoped.length === 1 ? scoped[0] : null;
}

type QueuePromptMessage = { role?: string; text?: string };

/**
 * 「继续」要重发哪一句：取该线程里最后一条用户输入。
 * 拿不到历史时退回固定续跑指令（调用方传入本地化文案），不静默什么都不发。
 */
export function lastUserPrompt(messages: QueuePromptMessage[] | undefined | null, fallback: string): string {
    if (!Array.isArray(messages)) return fallback;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const item = messages[index];
        if (item?.role !== "user") continue;
        const text = (item.text || "").trim();
        if (text) return text;
    }
    return fallback;
}
