import { describe, expect, test } from "bun:test";

import {
    approvalForThread,
    availableQueueActions,
    lastUserPrompt,
    queueActionNeedsConfirm,
    queueApprovalDecision,
    queueStatusAfter,
    type QueueApprovalRequest,
    type QueueStatus,
} from "../src/lib/agent/agent-queue-actions";

/**
 * H2「队列即入口」的决策层。
 *
 * 这里守的是队列按钮的**规则**，不是它长什么样：
 * ① 状态 → 可用动作的映射（没 requestId 就不许批；只有失败/等输入才有「继续」）；
 * ② 只有「拒绝」要二次确认，批准与继续都是单击；
 * ③ 任何真动作做完，这条立刻变成 running（乐观反馈），不是继续显示旧状态。
 *
 * 只看 UI 变色不算过：这些函数就是 UI 的依据，规则错了界面一定跟着错。
 */

const approval = (patch: Partial<QueueApprovalRequest> = {}): QueueApprovalRequest => ({ requestId: "req-1", threadId: "thread-a", ...patch });

describe("availableQueueActions", () => {
    test("任何一条都能打开会话（跳窗能力不因加按钮退步）", () => {
        const statuses: QueueStatus[] = ["approval", "running", "waiting-input", "idle", "failed"];
        for (const status of statuses) {
            expect(availableQueueActions({ status, approval: null })).toContain("open");
        }
    });

    test("权限确认 + 有 requestId 才能批准/拒绝", () => {
        expect(availableQueueActions({ status: "approval", approval: approval() })).toEqual(["open", "approve", "decline"]);
    });

    test("权限确认但拿不到 requestId 时不给批准按钮（否则点了也白点）", () => {
        expect(availableQueueActions({ status: "approval", approval: null })).toEqual(["open"]);
        expect(availableQueueActions({ status: "approval", approval: approval({ requestId: "" }) })).toEqual(["open"]);
    });

    test("失败与等待输入可以继续", () => {
        expect(availableQueueActions({ status: "failed", approval: null })).toEqual(["open", "continue"]);
        expect(availableQueueActions({ status: "waiting-input", approval: null })).toEqual(["open", "continue"]);
    });

    test("运行中 / 空闲既不能批也不能续，只有打开", () => {
        expect(availableQueueActions({ status: "running", approval: approval() })).toEqual(["open"]);
        expect(availableQueueActions({ status: "idle", approval: approval() })).toEqual(["open"]);
    });

    test("动作顺序固定：打开在前，危险动作殿后", () => {
        expect(availableQueueActions({ status: "approval", approval: approval() })).toEqual(["open", "approve", "decline"]);
    });
});

describe("queueActionNeedsConfirm", () => {
    test("只有拒绝需要二次确认", () => {
        expect(queueActionNeedsConfirm("decline")).toBe(true);
        expect(queueActionNeedsConfirm("approve")).toBe(false);
        expect(queueActionNeedsConfirm("continue")).toBe(false);
        expect(queueActionNeedsConfirm("open")).toBe(false);
    });
});

describe("queueStatusAfter", () => {
    test("批准 / 拒绝 / 继续之后这条立刻转 running", () => {
        expect(queueStatusAfter("approve", "approval")).toBe("running");
        expect(queueStatusAfter("decline", "approval")).toBe("running");
        expect(queueStatusAfter("continue", "failed")).toBe("running");
        expect(queueStatusAfter("continue", "waiting-input")).toBe("running");
    });

    test("打开只是跳转，不改状态", () => {
        expect(queueStatusAfter("open", "approval")).toBe("approval");
        expect(queueStatusAfter("open", "failed")).toBe("failed");
    });
});

describe("queueApprovalDecision", () => {
    test("按钮动作映射到桥端 decision", () => {
        expect(queueApprovalDecision("approve")).toBe("accept");
        expect(queueApprovalDecision("decline")).toBe("decline");
    });
});

describe("approvalForThread", () => {
    test("按 threadId 精确匹配", () => {
        const list = [approval({ requestId: "req-a", threadId: "thread-a" }), approval({ requestId: "req-b", threadId: "thread-b" })];
        expect(approvalForThread("thread-b", list)?.requestId).toBe("req-b");
        expect(approvalForThread("thread-c", list)).toBeNull();
    });

    test("桥端没报 threadId 的全局审批：只有唯一一条时才算给它", () => {
        const single = [approval({ requestId: "req-g", threadId: "" })];
        expect(approvalForThread("thread-a", single)?.requestId).toBe("req-g");
        const ambiguous = [approval({ requestId: "req-g1", threadId: "" }), approval({ requestId: "req-g2", threadId: "" })];
        expect(approvalForThread("thread-a", ambiguous)).toBeNull();
    });

    test("空清单 / 缺 threadId 都不炸", () => {
        expect(approvalForThread("thread-a", [])).toBeNull();
        expect(approvalForThread("thread-a", undefined)).toBeNull();
        expect(approvalForThread("", [approval()])).toBeNull();
    });
});

describe("lastUserPrompt", () => {
    const fallback = "继续";

    test("取最后一条用户输入", () => {
        expect(lastUserPrompt([{ role: "user", text: "第一句" }, { role: "assistant", text: "回话" }, { role: "user", text: "第二句" }], fallback)).toBe("第二句");
    });

    test("没有用户输入 / 历史缺失时退回固定指令", () => {
        expect(lastUserPrompt([{ role: "assistant", text: "只有回话" }], fallback)).toBe(fallback);
        expect(lastUserPrompt([], fallback)).toBe(fallback);
        expect(lastUserPrompt(undefined, fallback)).toBe(fallback);
        expect(lastUserPrompt([{ role: "user", text: "   " }], fallback)).toBe(fallback);
    });
});
