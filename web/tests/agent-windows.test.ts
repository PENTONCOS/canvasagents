import { describe, expect, test } from "bun:test";

import {
    AGENT_WINDOW_EVENT_LOG_LIMIT,
    AGENT_WINDOW_LIMIT,
    appendAgentWindow,
    bumpUnread,
    clearUnread,
    closeAgentWindow,
    closeAgentWindowWithFallback,
    createAgentWindow,
    deriveWindowStatus,
    findAgentWindow,
    nextActiveIdAfterClose,
    nextWindowNumber,
    toWindowTabLabel,
    updateAgentWindow,
    withAppendedChatItem,
    withAppendedEventLog,
    type AgentWindow,
} from "../src/lib/agent/agent-windows";

const win = (id: string, patch: Partial<AgentWindow> = {}) => createAgentWindow({ id, title: `会话 ${id}`, ...patch });

describe("createAgentWindow", () => {
    test("默认是空白可用的窗口", () => {
        const window = win("a");
        expect(window.id).toBe("a");
        expect(window.status).toBe("idle");
        expect(window.unread).toBe(0);
        expect(window.messages).toEqual([]);
        expect(window.eventLogs).toEqual([]);
        expect(window.canvasReferences).toEqual([]);
        expect(window.conversation).toEqual({ revision: 0, conversationId: "", threadId: "", status: "idle", mcpStatuses: {} });
        expect(window.activeThreadId).toBe("");
        expect(window.sending).toBe(false);
        expect(window.waiting).toBe(false);
    });

    test("patch 覆盖默认值", () => {
        const window = win("a", { status: "running", unread: 3, activeThreadId: "t-1" });
        expect(window.status).toBe("running");
        expect(window.unread).toBe(3);
        expect(window.activeThreadId).toBe("t-1");
    });
});

describe("appendAgentWindow", () => {
    test("上限内追加成功", () => {
        const { windows, ok } = appendAgentWindow([win("a")], win("b"));
        expect(ok).toBe(true);
        expect(windows.map((item) => item.id)).toEqual(["a", "b"]);
    });

    test("到上限返回原列表且标记 limit，不静默丢弃", () => {
        const full = Array.from({ length: AGENT_WINDOW_LIMIT }, (_, index) => win(`w${index}`));
        const { windows, ok, reason } = appendAgentWindow(full, win("overflow"));
        expect(ok).toBe(false);
        expect(reason).toBe("limit");
        expect(windows).toBe(full);
        expect(windows.length).toBe(AGENT_WINDOW_LIMIT);
    });
});

describe("closeAgentWindow / fallback", () => {
    test("纯删除只移除目标", () => {
        const list = [win("a"), win("b"), win("c")];
        expect(closeAgentWindow(list, "b").map((item) => item.id)).toEqual(["a", "c"]);
    });

    test("关掉最后一个会自动补一个空白窗", () => {
        const remaining = closeAgentWindowWithFallback([win("a")], "a", () => win("fresh"));
        expect(remaining).toHaveLength(1);
        expect(remaining[0].id).toBe("fresh");
        expect(remaining[0].messages).toEqual([]);
    });

    test("还有别的窗口时不补位", () => {
        const remaining = closeAgentWindowWithFallback([win("a"), win("b")], "a", () => win("fresh"));
        expect(remaining.map((item) => item.id)).toEqual(["b"]);
    });
});

describe("nextActiveIdAfterClose", () => {
    const list = [win("a"), win("b"), win("c")];

    test("关的不是当前窗则当前窗不变", () => {
        expect(nextActiveIdAfterClose(list, "a", "c")).toBe("c");
    });

    test("关的是当前窗则选右邻", () => {
        expect(nextActiveIdAfterClose(list, "b", "b")).toBe("c");
    });

    test("关的是最后一个则退左邻", () => {
        expect(nextActiveIdAfterClose(list, "c", "c")).toBe("b");
    });

    test("列表空了返回空串（交给 fallback 补位）", () => {
        expect(nextActiveIdAfterClose([win("a")], "a", "a")).toBe("");
    });
});

describe("unread", () => {
    test("累加与清零", () => {
        let list = [win("a"), win("b")];
        list = bumpUnread(list, "b");
        list = bumpUnread(list, "b", 2);
        expect(findAgentWindow(list, "b")?.unread).toBe(3);
        list = clearUnread(list, "b");
        expect(findAgentWindow(list, "b")?.unread).toBe(0);
    });

    test("不能累成负数且未知 id 不影响列表", () => {
        let list = updateAgentWindow([win("a")], "a", { unread: 1 });
        list = bumpUnread(list, "a", -5);
        expect(findAgentWindow(list, "a")?.unread).toBe(0);
        expect(bumpUnread(list, "nope")).toBe(list);
        expect(clearUnread(list, "nope")).toBe(list);
    });

    test("激活窗收到消息视为已读，非激活窗累加未读", () => {
        const active = withAppendedChatItem(win("a", { unread: 2 }), { id: "m1", role: "assistant", text: "hi" }, true);
        expect(active.unread).toBe(0);
        expect(active.messages).toHaveLength(1);
        const background = withAppendedChatItem(win("b"), { id: "m2", role: "assistant", text: "hi" }, false);
        expect(background.unread).toBe(1);
    });
});

describe("event log", () => {
    test("按窗口截断到上限", () => {
        let window = win("a");
        for (let index = 0; index < AGENT_WINDOW_EVENT_LOG_LIMIT + 5; index += 1) {
            window = withAppendedEventLog(window, { id: `e${index}`, time: "00:00", title: "t", text: "x" });
        }
        expect(window.eventLogs).toHaveLength(AGENT_WINDOW_EVENT_LOG_LIMIT);
        expect(window.eventLogs.at(-1)?.id).toBe(`e${AGENT_WINDOW_EVENT_LOG_LIMIT + 4}`);
        expect(window.eventLogs[0].id).toBe("e5");
    });
});

describe("展示辅助", () => {
    test("tab 文案从 1 开始", () => {
        expect(toWindowTabLabel(win("a", { title: "精灵模式" }), 0)).toBe("1: 精灵模式");
        expect(toWindowTabLabel(win("b", { title: "landingpage 改版" }), 1)).toBe("2: landingpage 改版");
    });

    test("状态推导：发送/等待即 running，error 优先", () => {
        expect(deriveWindowStatus({ status: "idle", sending: true, waiting: false })).toBe("running");
        expect(deriveWindowStatus({ status: "idle", sending: false, waiting: true })).toBe("running");
        expect(deriveWindowStatus({ status: "idle", sending: false, waiting: false })).toBe("idle");
        expect(deriveWindowStatus({ status: "error", sending: true, waiting: false })).toBe("error");
    });
});

describe("窗口编号", () => {
    test("nextWindowNumber 分配最小未占用编号", () => {
        expect(nextWindowNumber([])).toBe(1);
        expect(nextWindowNumber([win("a", { title: "会话 1" })])).toBe(2);
        expect(nextWindowNumber([win("a", { title: "会话 2" })])).toBe(1);
        expect(nextWindowNumber([win("a", { title: "会话 1" }), win("b", { title: "会话 3" })])).toBe(2);
    });

    test("nextWindowNumber 忽略不是编号结尾的标题", () => {
        expect(nextWindowNumber([win("a", { title: "landingpage 改版" })])).toBe(1);
        expect(nextWindowNumber([win("a", { title: "精灵模式" }), win("b", { title: "会话 2" })])).toBe(1);
    });
});
