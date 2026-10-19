import { describe, expect, test } from "bun:test";

import { agentWindowById, agentWindowIdForConversation, agentWindowIdForThread, useAgentStore, withWindowPatchTarget } from "../src/stores/use-agent-store";
import { AGENT_WINDOW_LIMIT, AGENT_WINDOW_UNREAD_KEY_LIMIT, backgroundUnreadKey, bumpUnreadOnce, createAgentWindow, emptyAgentConversation, type AgentWindow } from "../src/lib/agent/agent-windows";

const win = (id: string, patch: Partial<AgentWindow> = {}) => createAgentWindow({ id, title: `会话 ${id}`, ...patch });
const conversation = (threadId: string, conversationId: string) => ({ ...emptyAgentConversation(), threadId, conversationId, status: "ready" as const });

/** 保证 store 里至少有两个窗，返回激活窗与非激活窗 id（本测试文件共用，避免互相污染）。 */
function ensureTwoWindows(): { activeId: string; backgroundId: string } {
    const store = useAgentStore;
    while (store.getState().windows.length < 2 && store.getState().windows.length < AGENT_WINDOW_LIMIT) {
        if (!store.getState().addWindow()) break;
    }
    const state = store.getState();
    const activeId = state.activeWindowId;
    const backgroundId = state.windows.find((window) => window.id !== activeId)!.id;
    return { activeId, backgroundId };
}

describe("两窗各绑独立线程后的路由", () => {
    const state = {
        windows: [
            win("win-a", { activeThreadId: "thread-a", conversation: conversation("thread-a", "conv-a") }),
            win("win-b", { activeThreadId: "thread-b", conversation: conversation("thread-b", "conv-b") }),
        ],
        activeWindowId: "win-a",
    };

    test("按 threadId 只命中对应窗", () => {
        expect(agentWindowIdForThread(state, "thread-a")).toBe("win-a");
        expect(agentWindowIdForThread(state, "thread-b")).toBe("win-b");
    });

    test("conversation_changed 按 threadId 只写归属窗，不落到激活窗", () => {
        // 后台窗（win-b）的会话更新必须路由到 win-b，即使激活窗是 win-a。
        expect(agentWindowIdForConversation(state, conversation("thread-b", "conv-b"))).toBe("win-b");
        expect(agentWindowIdForConversation(state, conversation("thread-a", "conv-a"))).toBe("win-a");
    });

    test("同一线程撞多窗时只认激活窗；激活窗不在其中视为无归属", () => {
        const collide = {
            windows: [win("win-a", { activeThreadId: "thread-same" }), win("win-b", { activeThreadId: "thread-same" })],
            activeWindowId: "win-b",
        };
        expect(agentWindowIdForThread(collide, "thread-same")).toBe("win-b");
        expect(agentWindowIdForThread({ ...collide, activeWindowId: "win-c" }, "thread-same")).toBeNull();
    });

    test("未知 threadId 的会话：唯一 conversationId 持有者兜底，否则才用激活窗", () => {
        const state2 = {
            windows: [win("win-a", { conversation: conversation("thread-a", "conv-a") }), win("win-b")],
            activeWindowId: "win-b",
        };
        // conversationId 只被 win-a 持有 → 即便激活窗是 win-b，也写 win-a。
        expect(agentWindowIdForConversation(state2, { ...conversation("", "conv-a") })).toBe("win-a");
        // 全新会话（无 threadId、无持有者）落到激活窗。
        expect(agentWindowIdForConversation(state2, conversation("", "conv-new"))).toBe("win-b");
    });
});

describe("无归属 threadId 的后台事件被丢弃", () => {
    test("路由返回 null 时调用方必须丢弃，不写任何窗", () => {
        const { activeId } = ensureTwoWindows();
        const state = useAgentStore.getState();
        const ghostThread = `ghost-${Date.now()}`;
        expect(agentWindowIdForThread(state, ghostThread)).toBeNull();
        const windowsBefore = state.windows;
        expect(agentWindowIdForThread(useAgentStore.getState(), ghostThread)).toBeNull();
        // 没有任何窗被这个线程写脏。
        expect(useAgentStore.getState().windows).toBe(windowsBefore);
        expect(useAgentStore.getState().windows.some((window) => window.activeThreadId === ghostThread || window.conversation.threadId === ghostThread)).toBe(false);
        expect(useAgentStore.getState().activeWindowId).toBe(activeId);
    });

    test("withWindowPatchTarget 指向已关闭的窗：窗口级写入直接放弃，激活窗零变化", () => {
        const { activeId } = ensureTwoWindows();
        const before = useAgentStore.getState();
        withWindowPatchTarget(`closed-${Date.now()}`, () => useAgentStore.getState().setAgentState({ messages: [{ id: "ghost", role: "assistant", text: "不该出现" }], activeThreadId: "ghost-thread" }));
        const after = useAgentStore.getState();
        // 后台写入找不到目标窗时不得回退激活窗。
        expect(after.messages).toBe(before.messages);
        expect(after.activeThreadId).toBe(before.activeThreadId);
        expect(after.activeWindowId).toBe(activeId);
        expect(agentWindowById(after, activeId)!.messages.some((item) => item.id === "ghost")).toBe(false);
        expect(after.windows.some((window) => window.activeThreadId === "ghost-thread")).toBe(false);
    });
});

describe("新建会话窗即建独立线程", () => {
    test("addWindow 后新窗线程为空且独立；写入新窗后旧窗切片零变化", () => {
        const { activeId } = ensureTwoWindows();
        const oldThread = `thread-old-${Date.now()}`;
        const oldConversation = conversation(oldThread, `conv-old-${Date.now()}`);
        withWindowPatchTarget(activeId, () => useAgentStore.getState().setAgentState({ conversation: oldConversation, activeThreadId: oldThread }));
        const oldWindowBefore = JSON.stringify(agentWindowById(useAgentStore.getState(), activeId));

        expect(useAgentStore.getState().addWindow()).toBe(true);
        const newWindow = useAgentStore.getState().windows.find((window) => window.id === useAgentStore.getState().activeWindowId)!;
        expect(newWindow.id).not.toBe(activeId);
        // 新窗不继承旧窗线程：面板随后用 threads/reset 给它建自己的线程。
        expect(newWindow.activeThreadId).toBe("");
        expect(newWindow.conversation.threadId).toBe("");

        const newThread = `thread-new-${Date.now()}`;
        const newConversation = conversation(newThread, `conv-new-${Date.now()}`);
        withWindowPatchTarget(newWindow.id, () => useAgentStore.getState().setAgentState({ conversation: newConversation, activeThreadId: newThread }));

        const state = useAgentStore.getState();
        expect(agentWindowById(state, newWindow.id)!.activeThreadId).toBe(newThread);
        expect(agentWindowById(state, newWindow.id)!.conversation.threadId).toBe(newThread);
        // 旧窗切片完全没被新窗的准备过程污染（逐字段 JSON 对比）。
        expect(JSON.stringify(agentWindowById(state, activeId))).toBe(oldWindowBefore);
        // 两窗线程不同，路由各归各。
        expect(agentWindowIdForThread(state, oldThread)).toBe(activeId);
        expect(agentWindowIdForThread(state, newThread)).toBe(newWindow.id);
    });
});

describe("未读按消息 / turn 计数", () => {
    test("同一条 assistant 消息累加多次也只 +1", () => {
        const { backgroundId } = ensureTwoWindows();
        const key = backgroundUnreadKey({ message: { id: "msg-1", role: "assistant" } });
        expect(key).toBe("message:msg-1");
        const before = agentWindowById(useAgentStore.getState(), backgroundId)!.unread;
        useAgentStore.getState().noteWindowOutput(backgroundId, key!);
        useAgentStore.getState().noteWindowOutput(backgroundId, key!);
        useAgentStore.getState().noteWindowOutput(backgroundId, key!);
        expect(agentWindowById(useAgentStore.getState(), backgroundId)!.unread).toBe(before + 1);
    });

    test("流式 delta 不计数；turn.completed 每个 turn 只 +1", () => {
        const { backgroundId } = ensureTwoWindows();
        // 流式增量 / item.updated / 用户消息都不产生未读键。
        expect(backgroundUnreadKey({ type: "item.updated", item: { type: "agent_message", delta: "字" }, threadId: "t", turnId: "turn-1" })).toBeNull();
        expect(backgroundUnreadKey({ message: { id: "msg-user", role: "user" } })).toBeNull();
        const turnKey = backgroundUnreadKey({ type: "turn.completed", threadId: "t", turnId: "turn-1" });
        expect(turnKey).toBe("turn:t:turn-1");
        const before = agentWindowById(useAgentStore.getState(), backgroundId)!.unread;
        useAgentStore.getState().noteWindowOutput(backgroundId, turnKey!);
        useAgentStore.getState().noteWindowOutput(backgroundId, turnKey!);
        expect(agentWindowById(useAgentStore.getState(), backgroundId)!.unread).toBe(before + 1);
    });

    test("bumpUnreadOnce 去重键按上限截断且不再重复计数", () => {
        const list = [win("w", { unread: 0 })];
        let next = list;
        for (let index = 0; index <= AGENT_WINDOW_UNREAD_KEY_LIMIT + 5; index += 1) next = bumpUnreadOnce(next, "w", `key-${index}`);
        const window = next[0];
        expect(window.unread).toBe(AGENT_WINDOW_UNREAD_KEY_LIMIT + 6);
        expect(window.unreadKeys.length).toBe(AGENT_WINDOW_UNREAD_KEY_LIMIT);
        const again = bumpUnreadOnce(next, "w", `key-${AGENT_WINDOW_UNREAD_KEY_LIMIT + 5}`);
        expect(again[0].unread).toBe(window.unread);
    });
});
