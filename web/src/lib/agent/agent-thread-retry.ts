/**
 * 「新会话窗建线程」的退避重试判定（纯函数，无 DOM / store 依赖）。
 *
 * 背景：桥端 reset 在任一 turn 运行时直接拒绝（409 CONVERSATION_BUSY /
 * 「Codex 正在运行或正在切换会话，请稍后重试」）。前端补准备失败后若不重试，
 * 新窗的 conversation.threadId 永远为空 → 输入框永久禁用。
 *
 * 这里只放「该不该重试 / 等多久 / 什么算瞬时错」的判定，便于单测；
 * 定时器与请求编排留在组件里。
 */

/** 单个窗最多尝试多少次（首次 + 重试）。 */
export const THREAD_RESET_MAX_ATTEMPTS = 15;
/** 首次重试等待（毫秒）。 */
export const THREAD_RESET_BASE_DELAY_MS = 1000;
/** 退避封顶（毫秒）。 */
export const THREAD_RESET_MAX_DELAY_MS = 8000;

/**
 * 透传桥端错误里需要判定重启的字段。
 * 不依赖 AgentApiError 实例，避免把浏览器侧模块拖进单测。
 */
export type ThreadResetErrorInfo = { status: number; code: string; message: string };

function readString(source: unknown, key: string): string {
    if (!source || typeof source !== "object") return "";
    const value = (source as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
}

/** 归一化任意 thrown 值：AgentApiError（status + response.code/error/msg）、fetch 的 TypeError、普通 Error 都覆盖。 */
export function describeThreadResetError(error: unknown): ThreadResetErrorInfo {
    if (!error || typeof error !== "object") {
        return { status: 0, code: "", message: typeof error === "string" ? error : "" };
    }
    const rawStatus = (error as Record<string, unknown>).status;
    const status = typeof rawStatus === "number" && Number.isFinite(rawStatus) ? rawStatus : 0;
    const response = (error as Record<string, unknown>).response;
    const code = readString(response, "code") || readString(error, "code");
    const message = readString(response, "error") || readString(response, "msg") || readString(error, "error") || readString(error, "msg") || readString(error, "message");
    return { status, code, message };
}

/** 文案里出现过就说明是「稍后再来」类瞬时状态（桥端中文/英文都可能）。 */
const TRANSIENT_MESSAGE_HINTS = [
    "正在运行或正在切换会话",
    "稍后重试",
    "正在切换会话",
    "busy",
    "in progress",
    "try again later",
    "temporarily unavailable",
    "timeout",
    "timed out",
    "failed to fetch",
    "network",
    "socket",
];

/** 桥端明确的「忙」错误码。 */
const TRANSIENT_CODES = new Set(["CONVERSATION_BUSY", "CONVERSATION_PREPARING", "CONVERSATION_SWITCHING", "BUSY", "RATE_LIMITED"]);

/**
 * 是否属于「等一下再来就好」的瞬时错误：
 * - 无状态码（fetch/网络层抛错）→ 瞬时；
 * - 408 / 409 / 425 / 429 / 5xx → 瞬时；
 * - 其他 4xx（400 参数错、401/403 鉴权）→ 不重试；
 * - 文案/错误码命中忙提示 → 瞬时（防桥端换状态码）。
 */
export function isTransientThreadResetError(error: unknown): boolean {
    const { status, code, message } = describeThreadResetError(error);
    const upperCode = code.toUpperCase();
    if (upperCode && TRANSIENT_CODES.has(upperCode)) return true;
    const lowerMessage = message.toLowerCase();
    if (lowerMessage && TRANSIENT_MESSAGE_HINTS.some((hint) => lowerMessage.includes(hint.toLowerCase()))) return true;
    if (!status) return true;
    if (status === 408 || status === 409 || status === 425 || status === 429) return true;
    if (status >= 500) return true;
    return false;
}

/** 第 attempt 次失败后的退避时长（attempt 从 1 开始）：1s → 2s → 4s → 8s 封顶。 */
export function nextRetryDelay(attempt: number): number {
    const normalized = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
    const delay = THREAD_RESET_BASE_DELAY_MS * 2 ** (normalized - 1);
    return Math.min(delay, THREAD_RESET_MAX_DELAY_MS);
}

/**
 * 判定「还要不要再试」：瞬时错 + 未到上限才继续。
 * @param attempts 已完成的尝试次数（含首次失败）
 */
export function shouldRetryThreadReset(attempts: number, error: unknown, maxAttempts: number = THREAD_RESET_MAX_ATTEMPTS): boolean {
    if (attempts >= maxAttempts) return false;
    return isTransientThreadResetError(error);
}

/** 下一次重试的等待时长；不再重试时返回 null。attempts = 已完成的尝试次数。 */
export function threadResetRetryDelay(attempts: number, error: unknown, maxAttempts: number = THREAD_RESET_MAX_ATTEMPTS): number | null {
    if (!shouldRetryThreadReset(attempts, error, maxAttempts)) return null;
    return nextRetryDelay(attempts);
}

/** 这些状态说明该窗已经有线程/正在准备或已定性失败，不需要（也不该）再自动 reset。 */
export const THREAD_PREPARE_SETTLED_STATUSES = ["preparing", "running", "ready", "warning", "failed"] as const;

/**
 * 该会话窗是否还需要「补一次建线程」：没有线程，且会话状态还没定性。
 * `failed` 视为已定性——否则每次状态变化都会再自动 reset 一轮，变成隐形轮询。
 */
export function needsThreadPrepare(window: { activeThreadId?: string; conversation?: { status?: string } } | undefined | null): boolean {
    if (!window) return false;
    if (window.activeThreadId) return false;
    const status = window.conversation?.status || "idle";
    return !(THREAD_PREPARE_SETTLED_STATUSES as readonly string[]).includes(status);
}
