import { describe, expect, test } from "bun:test";

import {
    THREAD_RESET_BASE_DELAY_MS,
    THREAD_RESET_MAX_ATTEMPTS,
    THREAD_RESET_MAX_DELAY_MS,
    describeThreadResetError,
    isTransientThreadResetError,
    needsThreadPrepare,
    nextRetryDelay,
    shouldRetryThreadReset,
    threadResetRetryDelay,
} from "../src/lib/agent/agent-thread-retry";

/** 桥端 409：任一 turn 运行中 reset 被拒（真机复现的原文）。 */
const conversationBusy = () => Object.assign(new Error("Codex 正在运行或正在切换会话，请稍后重试"), {
    name: "AgentApiError",
    status: 409,
    response: { ok: false, code: "CONVERSATION_BUSY", error: "Codex 正在运行或正在切换会话，请稍后重试" },
});

describe("isTransientThreadResetError", () => {
    test("桥端忙（409 + CONVERSATION_BUSY + 中文文案）判为瞬时错", () => {
        expect(isTransientThreadResetError(conversationBusy())).toBe(true);
    });

    test("只有忙文案、没有状态码也算瞬时（防桥端换状态码）", () => {
        expect(isTransientThreadResetError(new Error("Codex 正在运行或正在切换会话，请稍后重试"))).toBe(true);
        expect(isTransientThreadResetError({ ok: false, error: "busy, try again later" })).toBe(true);
    });

    test("网络层报错（无状态码）判为瞬时错", () => {
        expect(isTransientThreadResetError(new TypeError("Failed to fetch"))).toBe(true);
        expect(isTransientThreadResetError(undefined)).toBe(true);
        expect(isTransientThreadResetError("socket hang up")).toBe(true);
    });

    test("5xx / 429 / 408 判为瞬时错", () => {
        expect(isTransientThreadResetError({ status: 500, response: {} })).toBe(true);
        expect(isTransientThreadResetError({ status: 503, response: {} })).toBe(true);
        expect(isTransientThreadResetError({ status: 429, response: {} })).toBe(true);
        expect(isTransientThreadResetError({ status: 408, response: {} })).toBe(true);
    });

    test("400 参数错 / 鉴权错不重试（否则就是无限重试）", () => {
        expect(isTransientThreadResetError({ status: 400, response: { code: "INVALID_ARGUMENT", error: "permissionMode invalid" } })).toBe(false);
        expect(isTransientThreadResetError({ status: 401, response: { error: "unauthorized" } })).toBe(false);
        expect(isTransientThreadResetError({ status: 403, response: { error: "forbidden" } })).toBe(false);
        expect(isTransientThreadResetError({ status: 404, response: { error: "not found" } })).toBe(false);
    });

    test("describeThreadResetError 从 AgentApiError 取 status/code/message", () => {
        expect(describeThreadResetError(conversationBusy())).toEqual({
            status: 409,
            code: "CONVERSATION_BUSY",
            message: "Codex 正在运行或正在切换会话，请稍后重试",
        });
        expect(describeThreadResetError(new Error("boom")).status).toBe(0);
    });
});

describe("nextRetryDelay", () => {
    test("退避序列 1s → 2s → 4s → 8s 后封顶", () => {
        expect(nextRetryDelay(1)).toBe(1000);
        expect(nextRetryDelay(2)).toBe(2000);
        expect(nextRetryDelay(3)).toBe(4000);
        expect(nextRetryDelay(4)).toBe(THREAD_RESET_MAX_DELAY_MS);
        expect(nextRetryDelay(5)).toBe(THREAD_RESET_MAX_DELAY_MS);
        expect(nextRetryDelay(15)).toBe(THREAD_RESET_MAX_DELAY_MS);
    });

    test("单调不减且不超过封顶（0/负数/非数字也安全）", () => {
        const delays = Array.from({ length: 20 }, (_, index) => nextRetryDelay(index + 1));
        for (let index = 1; index < delays.length; index += 1) {
            expect(delays[index]).toBeGreaterThanOrEqual(delays[index - 1]);
            expect(delays[index]).toBeLessThanOrEqual(THREAD_RESET_MAX_DELAY_MS);
        }
        expect(nextRetryDelay(0)).toBe(THREAD_RESET_BASE_DELAY_MS);
        expect(nextRetryDelay(-3)).toBe(THREAD_RESET_BASE_DELAY_MS);
        expect(nextRetryDelay(Number.NaN)).toBe(THREAD_RESET_BASE_DELAY_MS);
    });

    test("首次重试不等待（attempt<=0 归一为基线），正常路径不被拖慢", () => {
        // 首轮（attempt 0 那次调用）不经过这里，退避只为失败后的下一次服务。
        expect(threadResetRetryDelay(1, conversationBusy())).toBe(THREAD_RESET_BASE_DELAY_MS);
    });
});

describe("shouldRetryThreadReset / threadResetRetryDelay", () => {
    test("瞬时错在次数上限内继续重试", () => {
        expect(shouldRetryThreadReset(1, conversationBusy())).toBe(true);
        expect(shouldRetryThreadReset(THREAD_RESET_MAX_ATTEMPTS - 1, conversationBusy())).toBe(true);
        expect(threadResetRetryDelay(3, conversationBusy())).toBe(4000);
    });

    test("到达上限即停止（不再无限重试）", () => {
        expect(shouldRetryThreadReset(THREAD_RESET_MAX_ATTEMPTS, conversationBusy())).toBe(false);
        expect(shouldRetryThreadReset(THREAD_RESET_MAX_ATTEMPTS + 5, conversationBusy())).toBe(false);
        expect(threadResetRetryDelay(THREAD_RESET_MAX_ATTEMPTS, conversationBusy())).toBeNull();
    });

    test("非瞬时错（400）即使次数没到也不重试", () => {
        const badRequest = { status: 400, response: { code: "INVALID_ARGUMENT", error: "bad body" } };
        expect(shouldRetryThreadReset(1, badRequest)).toBe(false);
        expect(threadResetRetryDelay(1, badRequest)).toBeNull();
    });

    test("上限可覆盖（便于测试/调整）", () => {
        expect(shouldRetryThreadReset(2, conversationBusy(), 2)).toBe(false);
        expect(shouldRetryThreadReset(1, conversationBusy(), 2)).toBe(true);
    });
});

describe("needsThreadPrepare", () => {
    test("空窗（无线程 + idle）需要补建线程", () => {
        expect(needsThreadPrepare({ activeThreadId: "", conversation: { status: "idle" } })).toBe(true);
        expect(needsThreadPrepare({ activeThreadId: "" })).toBe(true);
    });

    test("已有线程不需要再补", () => {
        expect(needsThreadPrepare({ activeThreadId: "t-1", conversation: { status: "ready" } })).toBe(false);
    });

    test("准备中/运行中/就绪/告警都不需要再补（避免重复 reset）", () => {
        for (const status of ["preparing", "running", "ready", "warning"]) {
            expect(needsThreadPrepare({ activeThreadId: "", conversation: { status } })).toBe(false);
        }
    });

    test("failed 视为已定性，不再自动 reset（否则每次状态变化都变成隐形轮询）", () => {
        expect(needsThreadPrepare({ activeThreadId: "", conversation: { status: "failed" } })).toBe(false);
    });

    test("窗口不存在时返回 false（关掉的窗不能再写状态）", () => {
        expect(needsThreadPrepare(undefined)).toBe(false);
        expect(needsThreadPrepare(null)).toBe(false);
    });
});
