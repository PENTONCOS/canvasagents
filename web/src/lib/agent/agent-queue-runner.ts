import i18n from "@/i18n";
import { acquireAgentClientId } from "@/lib/agent/agent-client-id";
import { agentApiPath } from "@/lib/agent/agent-driver";
import { lastUserPrompt, type QueueApprovalRequest } from "@/lib/agent/agent-queue-actions";
import { fetchAgentJson, postCodexApproval } from "@/services/api/canvas-agent";
import { agentWindowById, agentWindowIdForThread, useAgentStore, withWindowPatchTarget } from "@/stores/use-agent-store";

/**
 * H2：队列里直接操作的那几个动作的服务层。
 *
 * 两条铁律：
 * 1. 不新开通道 —— 批准走 `/approval`，继续走 `/turn`，开窗走 `/threads/:id/resume`，
 *    全是面板本来就在用的端点；
 * 2. 失败必须能看见 —— 每个函数都把桥端的错误原样抛出，由队列视图落成可读错误，
 *    不允许静默吞掉。
 */

type ThreadDetailResponse = { conversation?: unknown; messages?: unknown[] };

/** 在队列里批准 / 拒绝：requestId 是桥端认的唯一凭据，decision 只允许 accept / decline。 */
export async function decideQueueApproval(endpoint: string, token: string, requestId: string, decision: "accept" | "decline") {
    await postCodexApproval(endpoint, token, requestId, decision);
    // 服务端已经处置了这条审批：本地窗口里挂着的那张卡片要立刻消失，
    // 否则同一件事在队列（已处置）和面板（还在等）里会显示两个状态。
    dropPendingApproval(requestId);
}

/** 把某条审批从持有它的会话窗里摘掉（找不到持有窗就什么都不做）。 */
function dropPendingApproval(requestId: string) {
    const state = useAgentStore.getState();
    const owner = state.windows.find((window) => window.pendingApprovals.some((item) => item.requestId === requestId));
    if (!owner) return;
    const pendingApprovals = owner.pendingApprovals.filter((item) => item.requestId !== requestId);
    withWindowPatchTarget(owner.id, () => state.setAgentState({ pendingApprovals }));
}

/**
 * 点击队列项：跳到持有该线程的会话窗；没有窗持有它时，按既有 resume 端点把它接进激活窗。
 * 返回宿主窗 id —— 调用方据此决定后续动作落在哪个窗。
 */
export async function openQueueThread(endpoint: string, token: string, threadId: string): Promise<string> {
    const state = useAgentStore.getState();
    state.openPanel();
    const existing = agentWindowIdForThread(state, threadId);
    if (existing) {
        useAgentStore.getState().selectWindow(existing);
        return existing;
    }
    const windowId = state.activeWindowId;
    const clientId = await acquireAgentClientId();
    const result = await fetchAgentJson<ThreadDetailResponse>(endpoint, token, agentApiPath(`/threads/${encodeURIComponent(threadId)}/resume`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, permissionMode: state.permissionMode }),
    });
    const latest = useAgentStore.getState();
    const conversation = result.conversation as typeof latest.conversation | undefined;
    withWindowPatchTarget(windowId, () => latest.setAgentState({
        activeThreadId: threadId,
        conversation: conversation ?? latest.conversation,
        messages: Array.isArray(result.messages) ? (result.messages as typeof latest.messages) : [],
        activeTurnId: "",
        pendingTool: null,
        pendingApprovals: [],
        tokenUsage: null,
    }));
    useAgentStore.getState().selectWindow(windowId);
    return windowId;
}

/** 「继续」要重发的句子：优先用该窗已缓存的消息，其次读线程历史，最后退回固定指令。 */
async function continuePromptFor(endpoint: string, token: string, threadId: string, windowId: string) {
    const fallback = i18n.t("agent.queue.continuePrompt");
    const cached = lastUserPrompt(agentWindowById(useAgentStore.getState(), windowId)?.messages, "");
    if (cached) return cached;
    try {
        const detail = await fetchAgentJson<ThreadDetailResponse>(endpoint, token, agentApiPath(`/threads/${encodeURIComponent(threadId)}`));
        return lastUserPrompt(detail.messages as Array<{ role?: string; text?: string }> | undefined, fallback);
    } catch (error) {
        // 历史读不到不该让「继续」失效：退回固定指令，并保留错误原因供调用方落日志。
        void error;
        return fallback;
    }
}

/**
 * 失败 / 暂停的条目「继续」：先把这个线程接进窗（没有的话），再用既有的 `/turn` 端点起新一轮。
 * 桥端会照常广播 chat_message / codex_state，所以窗里的气泡与运行态不用前端另写一套。
 */
export async function continueQueueThread(endpoint: string, token: string, threadId: string) {
    const windowId = await openQueueThread(endpoint, token, threadId);
    const prompt = await continuePromptFor(endpoint, token, threadId, windowId);
    const state = useAgentStore.getState();
    const window = agentWindowById(state, windowId);
    const clientId = await acquireAgentClientId();
    await fetchAgentJson<{ ok?: boolean; threadId?: string; turnId?: string }>(endpoint, token, agentApiPath("/turn"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            prompt,
            messageText: prompt,
            messageId: `${threadId}:queue-continue:${Date.now()}`,
            clientId,
            threadId,
            conversationId: window?.conversation.conversationId || "",
            expectedRevision: window?.conversation.revision || 0,
            permissionMode: state.permissionMode,
            model: state.model || undefined,
            effort: state.reasoningEffort || undefined,
        }),
    });
    return { windowId, prompt };
}

/** 队列里拿到的审批请求可能没有 threadId：给按钮做归属判断用。 */
export function approvalBelongsTo(request: QueueApprovalRequest | null | undefined, threadId: string) {
    if (!request?.requestId) return false;
    return !request.threadId || request.threadId === threadId;
}
