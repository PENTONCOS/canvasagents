import { describe, expect, test } from "bun:test";

import { agentWindowById, agentWindowIdForThread, useAgentStore, withWindowPatchTarget } from "../src/stores/use-agent-store";
import { createAgentWindow, emptyAgentConversation, type AgentWindow } from "../src/lib/agent/agent-windows";

const win = (id: string, patch: Partial<AgentWindow> = {}) => createAgentWindow({ id, title: `会话 ${id}`, ...patch });

describe("agentWindowIdForThread", () => {
    const state = {
        windows: [
            win("a", { activeThreadId: "t-active", conversation: { ...emptyAgentConversation(), threadId: "t-conv" } }),
            win("b", { activeThreadId: "t-b" }),
        ],
    };

    test("命中 conversation.threadId", () => {
        expect(agentWindowIdForThread(state, "t-conv")).toBe("a");
    });

    test("命中 activeThreadId", () => {
        expect(agentWindowIdForThread(state, "t-active")).toBe("a");
        expect(agentWindowIdForThread(state, "t-b")).toBe("b");
    });

    test("未命中返回 null", () => {
        expect(agentWindowIdForThread(state, "no-such-thread")).toBeNull();
    });

    test("空 threadId 返回 null，不误配空白窗", () => {
        expect(agentWindowIdForThread({ windows: [win("a")] }, "")).toBeNull();
    });
});

describe("agentWindowById", () => {
    test("取指定窗；找不到返回 undefined，绝不回退激活窗", () => {
        const state = { windows: [win("a"), win("b")], activeWindowId: "b" };
        expect(agentWindowById(state, "a")?.id).toBe("a");
        // 后台写入路径拿到 undefined 必须放弃写入 —— 回退激活窗就是把后台内容串进当前窗。
        expect(agentWindowById(state, "missing")).toBeUndefined();
    });
});

function ensureTwoWindows(): { activeId: string; backgroundId: string } {
    const store = useAgentStore;
    if (store.getState().windows.length < 2) store.getState().addWindow();
    const state = store.getState();
    const activeId = state.activeWindowId;
    const backgroundId = state.windows.find((window) => window.id !== activeId)!.id;
    return { activeId, backgroundId };
}

describe("后台事件写非激活窗", () => {
    test("withWindowPatchTarget 写非激活窗只改 windows，扁平字段原样不动", () => {
        const store = useAgentStore;
        const { activeId, backgroundId } = ensureTwoWindows();
        const beforeFlat = store.getState().messages;
        withWindowPatchTarget(backgroundId, () => store.getState().setAgentState({ messages: [{ id: "bg-1", role: "assistant", text: "背景" }] }));
        const after = store.getState();
        expect(after.activeWindowId).toBe(activeId);
        // 关键：激活窗的扁平投影没有被后台写污染（同一个引用都没换）。
        expect(after.messages).toBe(beforeFlat);
        expect(after.windows.find((window) => window.id === backgroundId)!.messages.map((item) => item.text)).toEqual(["背景"]);
    });

    test("noteWindowOutput 只给非激活窗累加未读", () => {
        const store = useAgentStore;
        const { activeId, backgroundId } = ensureTwoWindows();
        const before = store.getState().windows.find((window) => window.id === backgroundId)!.unread;
        store.getState().noteWindowOutput(backgroundId);
        expect(store.getState().windows.find((window) => window.id === backgroundId)!.unread).toBe(before + 1);
        store.getState().noteWindowOutput(activeId);
        expect(store.getState().windows.find((window) => window.id === activeId)!.unread).toBe(0);
    });

    test("写激活窗仍旧投影扁平字段（单窗行为不回归）", () => {
        const store = useAgentStore;
        const activeId = store.getState().activeWindowId;
        withWindowPatchTarget(activeId, () => store.getState().setAgentState({ activity: "后台路由测试" }));
        expect(store.getState().activity).toBe("后台路由测试");
    });
});
