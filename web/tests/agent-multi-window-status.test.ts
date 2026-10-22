import { describe, expect, test } from "bun:test";

import { agentWindowIdForThread, useAgentStore, withWindowPatchTarget } from "../src/stores/use-agent-store";
import {
    createAgentWindow,
    deriveWindowStatus,
    emptyAgentConversation,
    windowLabelForThread,
    type AgentWindow,
} from "../src/lib/agent/agent-windows";

/**
 * B3 多窗并行：两个会话窗各跑各的。
 *
 * 这里守的四件事都是「数据层契约」，组件只负责把它们画出来：
 * ① 两窗可以同时 running；
 * ② 一个窗收尾（agent_done）只结束自己，不能把另一个窗的输入框一起解锁；
 * ③ 投喂排队 = queued（不是 running，也不是 idle），发出/作废要清掉；
 * ④ 同窗第二次发送仍被既有守卫挡住（跨窗则不该被挡）。
 */

const conversation = (threadId: string) => ({ ...emptyAgentConversation(), threadId, conversationId: `conv-${threadId}`, status: "ready" as const });

const win = (id: string, patch: Partial<AgentWindow> = {}) => createAgentWindow({ id, title: `会话 ${id}`, ...patch });

/** 取一个干净的两窗状态（本文件共用一个 store 单例，逐个用例复位，避免互相污染）。 */
function resetTwoWindows(): { a: string; b: string } {
    const store = useAgentStore;
    while (store.getState().windows.length < 2) {
        if (!store.getState().addWindow()) break;
    }
    store.setState((state) => ({
        feedSendRequest: null,
        windows: state.windows.map((window) => ({
            ...window,
            sending: false,
            waiting: false,
            queued: false,
            status: "idle" as const,
            pendingApprovals: [],
        })),
    }));
    const state = store.getState();
    const [first, second] = state.windows;
    store.getState().selectWindow(first.id);
    return { a: first.id, b: second.id };
}

function windowOf(id: string): AgentWindow {
    const found = useAgentStore.getState().windows.find((window) => window.id === id);
    if (!found) throw new Error(`窗口 ${id} 不存在`);
    return found;
}

/** 模拟组件里的写法：把 patch 显式写进某一窗（后台窗也走同一条路）。 */
function patchWindow(windowId: string, patch: Record<string, unknown>) {
    withWindowPatchTarget(windowId, () => useAgentStore.getState().setAgentState(patch));
}

/** 给两窗各绑一条独立线程，模拟「新窗已建好线程、可以发」。 */
function bindThreads(a: string, b: string) {
    patchWindow(a, { conversation: conversation("thread-a"), activeThreadId: "thread-a" });
    patchWindow(b, { conversation: conversation("thread-b"), activeThreadId: "thread-b" });
}

describe("两窗同时 running", () => {
    test("各自 sending 时两窗都是 running，互不覆盖", () => {
        const { a, b } = resetTwoWindows();
        bindThreads(a, b);

        patchWindow(a, { sending: true });
        patchWindow(b, { sending: true });

        expect(windowOf(a).sending).toBe(true);
        expect(windowOf(b).sending).toBe(true);
        // 状态是按窗推导的：不是「站点只有一个 busy」那种全局单例。
        expect(windowOf(a).status).toBe("running");
        expect(windowOf(b).status).toBe("running");
        // 扁平投影只代表激活窗（a），后台窗的写不能污染它。
        expect(useAgentStore.getState().sending).toBe(true);
    });

    test("切窗后扁平 sending 跟着激活窗走（后台窗在跑不等于当前窗在跑）", () => {
        const { a, b } = resetTwoWindows();
        bindThreads(a, b);

        patchWindow(b, { sending: true });
        const store = useAgentStore;

        // 激活窗是 a：它没在跑，输入框不该被后台窗的运行状态锁住。
        expect(store.getState().activeWindowId).toBe(a);
        expect(store.getState().sending).toBe(false);

        store.getState().selectWindow(b);
        expect(store.getState().sending).toBe(true);

        store.getState().selectWindow(a);
        expect(store.getState().sending).toBe(false);
        // 切来切去后台窗的运行状态仍在被保留，没有被切窗动作洗掉。
        expect(windowOf(b).status).toBe("running");
    });
});

describe("停一个不影响另一个（agent_done 写归属窗）", () => {
    test("收尾事件按 threadId 只清自己那窗，另一窗保持 running", () => {
        const { a, b } = resetTwoWindows();
        bindThreads(a, b);
        patchWindow(a, { sending: true, waiting: true });
        patchWindow(b, { sending: true, waiting: true });

        // 组件里 agent_done 的写法：threadId → 归属窗 → 显式写该窗。
        const threadId = "thread-b";
        const targetWindowId = agentWindowIdForThread(useAgentStore.getState(), threadId);
        expect(targetWindowId).toBe(b);
        patchWindow(targetWindowId!, { sending: false, waiting: false });

        expect(windowOf(b).sending).toBe(false);
        expect(windowOf(b).status).toBe("idle");
        // 关键：a 窗没被「顺手收尾」。
        expect(windowOf(a).sending).toBe(true);
        expect(windowOf(a).waiting).toBe(true);
        expect(windowOf(a).status).toBe("running");
    });

    test("未知线程不写任何窗（不回退激活窗）", () => {
        const { a, b } = resetTwoWindows();
        bindThreads(a, b);
        patchWindow(a, { sending: true });

        expect(agentWindowIdForThread(useAgentStore.getState(), "thread-unknown")).toBeNull();
        // 归属不出来就不动：激活窗仍在跑。
        expect(windowOf(a).sending).toBe(true);
        expect(windowOf(b).sending).toBe(false);
    });
});

describe("投喂排队 queued", () => {
    test("requestFeedSend 置 queued 并同步状态，clearFeedSend 清掉", () => {
        const { a, b } = resetTwoWindows();
        bindThreads(a, b);
        const store = useAgentStore;

        store.getState().requestFeedSend({ text: "把这段投喂过去", windowId: b });
        expect(windowOf(b).queued).toBe(true);
        // queued 必须是独立态：既不是 running（没发出去），也不是 idle（还在等）。
        expect(windowOf(b).status).toBe("queued");
        expect(windowOf(a).queued).toBe(false);
        expect(useAgentStore.getState().feedSendRequest?.windowId).toBe(b);

        store.getState().clearFeedSend();
        expect(windowOf(b).queued).toBe(false);
        expect(windowOf(b).status).toBe("idle");
        expect(useAgentStore.getState().feedSendRequest).toBeNull();
    });

    test("排队换目标窗时，旧窗不再挂 queued", () => {
        const { a, b } = resetTwoWindows();
        bindThreads(a, b);
        const store = useAgentStore;

        store.getState().requestFeedSend({ text: "第一条", windowId: b });
        expect(windowOf(b).queued).toBe(true);

        store.getState().requestFeedSend({ text: "第二条", windowId: a });
        expect(windowOf(b).queued).toBe(false);
        expect(windowOf(b).status).toBe("idle");
        expect(windowOf(a).queued).toBe(true);
        expect(windowOf(a).status).toBe("queued");

        store.getState().clearFeedSend();
        expect(windowOf(a).queued).toBe(false);
    });

    test("running 优先于 queued：已经在跑的窗不显示排队", () => {
        const { a, b } = resetTwoWindows();
        bindThreads(a, b);
        patchWindow(b, { sending: true });
        useAgentStore.getState().requestFeedSend({ text: "排队", windowId: b });

        expect(windowOf(b).queued).toBe(true);
        expect(windowOf(b).status).toBe("running");
        // 纯函数同口径：sending 赢过 queued。
        expect(deriveWindowStatus({ status: "idle", sending: true, waiting: false, queued: true })).toBe("running");
        expect(deriveWindowStatus({ status: "idle", sending: false, waiting: false, queued: true })).toBe("queued");
        expect(deriveWindowStatus({ status: "error", sending: false, waiting: false, queued: true })).toBe("error");
    });
});

describe("同窗重复发送仍排队（守住既有语义）", () => {
    test("同窗在跑时扁平 sending 为真，第二次发送会被守卫挡住", () => {
        const { a, b } = resetTwoWindows();
        bindThreads(a, b);
        patchWindow(a, { sending: true });

        // sendPrompt 的守卫读的就是这两个扁平字段（激活窗切片）。
        expect(useAgentStore.getState().activeWindowId).toBe(a);
        expect(useAgentStore.getState().sending).toBe(true);
        expect(useAgentStore.getState().waiting).toBe(false);
    });

    test("别的窗在跑不会让当前窗的发送被误挡", () => {
        const { a, b } = resetTwoWindows();
        bindThreads(a, b);
        patchWindow(b, { sending: true });

        expect(useAgentStore.getState().activeWindowId).toBe(a);
        expect(useAgentStore.getState().sending).toBe(false);
        expect(useAgentStore.getState().waiting).toBe(false);
        expect(windowOf(a).status).toBe("idle");
    });
});

describe("队列里的窗口维度", () => {
    test("windowLabelForThread 给出「序号:名称」，未知线程返回空串", () => {
        const windows = [
            win("x", { title: "会话 1", activeThreadId: "thread-a", conversation: conversation("thread-a") }),
            win("y", { title: "蓝色调改图", activeThreadId: "thread-b", conversation: conversation("thread-b") }),
        ];
        expect(windowLabelForThread(windows, "thread-a")).toBe("会话 1");
        // 改过名的窗补序号：队列里要能对上是哪个窗。
        expect(windowLabelForThread(windows, "thread-b")).toBe("2:蓝色调改图");
        expect(windowLabelForThread(windows, "thread-other")).toBe("");
        expect(windowLabelForThread(windows, "")).toBe("");
    });

    test("conversation.threadId 命中同样算归属（切过线程的窗）", () => {
        const windows = [win("z", { title: "会话 1", activeThreadId: "thread-new", conversation: conversation("thread-old") })];
        // 标题末尾编号正好等于位置时不重复加前缀（与 tab 文案同一规则）。
        expect(windowLabelForThread(windows, "thread-old")).toBe("会话 1");
        expect(windowLabelForThread(windows, "thread-new")).toBe("会话 1");
    });
});
