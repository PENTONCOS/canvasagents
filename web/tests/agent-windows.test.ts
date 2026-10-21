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
    parsePersistedWindows,
    projectPersistedWindows,
    toWindowTabHint,
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
        expect(toWindowTabLabel(win("a", { title: "精灵模式" }))).toBe("精灵模式");
        expect(toWindowTabLabel(win("b", { title: "landingpage 改版" }))).toBe("landingpage 改版");
    });

    test("tab 提示带快捷键序号", () => {
        expect(toWindowTabHint(win("a", { title: "会话 1" }), 0)).toBe("⌘1 · 会话 1");
        expect(toWindowTabHint(win("b", { title: "改版" }), 8)).toBe("⌘9 · 改版");
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

describe("窗口布局持久化", () => {
    test("projectPersistedWindows 只落骨架，不含消息/附件/对话", () => {
        const windows = [
            win("a", { title: "会话 1", cliMode: true, cliSession: "tty-1", messages: [{ id: "m1", role: "user", text: "秘密" }], activeThreadId: "th-1" }),
            win("b", { title: "landingpage 改版" }),
        ];
        const projected = projectPersistedWindows(windows, "b");
        expect(projected.activeWindowId).toBe("b");
        expect(projected.windows).toEqual([
            { id: "a", title: "会话 1", cliMode: true, cliSession: "tty-1" },
            { id: "b", title: "landingpage 改版", cliMode: false, cliSession: "" },
        ]);
        const raw = JSON.stringify(projected);
        expect(raw.includes("秘密")).toBe(false);
        expect(raw.includes("messages")).toBe(false);
        expect(raw.includes("th-1")).toBe(false);
    });

    test("parsePersistedWindows 能还原骨架，且默认空白可用", () => {
        const parsed = parsePersistedWindows(JSON.stringify({ activeWindowId: "b", windows: [{ id: "a", title: "会话 1" }, { id: "b", title: "会话 2", cliMode: true, cliSession: "tty-9" }] }));
        expect(parsed).not.toBeNull();
        expect(parsed!.windows.map((item) => item.id)).toEqual(["a", "b"]);
        expect(parsed!.activeWindowId).toBe("b");
        const restored = parsed!.windows[1];
        expect(restored.cliMode).toBe(true);
        expect(restored.cliSession).toBe("tty-9");
        expect(restored.messages).toEqual([]);
        expect(restored.conversation.status).toBe("idle");
        expect(restored.activeThreadId).toBe("");
    });

    test("activeWindowId 不在列表时回退首个窗口", () => {
        const parsed = parsePersistedWindows(JSON.stringify({ activeWindowId: "不存在", windows: [{ id: "a", title: "会话 1" }] }));
        expect(parsed!.activeWindowId).toBe("a");
    });

    test("坏数据一律回退为 null（不会卡成零窗口）", () => {
        expect(parsePersistedWindows(null)).toBeNull();
        expect(parsePersistedWindows("")).toBeNull();
        expect(parsePersistedWindows("{不是 json")).toBeNull();
        expect(parsePersistedWindows("[1,2,3]")).toBeNull();
        expect(parsePersistedWindows(JSON.stringify({ windows: [] }))).toBeNull();
        expect(parsePersistedWindows(JSON.stringify({ windows: [{ id: "", title: "x" }, { id: "a", title: "" }] }))).toBeNull();
    });

    test("丢弃重复 id 并截断到上限", () => {
        const dup = parsePersistedWindows(JSON.stringify({ windows: [{ id: "a", title: "会话 1" }, { id: "a", title: "重复" }] }));
        expect(dup!.windows).toHaveLength(1);
        const many = { windows: Array.from({ length: AGENT_WINDOW_LIMIT + 4 }, (_, index) => ({ id: `w${index}`, title: `会话 ${index}` })) };
        expect(parsePersistedWindows(JSON.stringify(many))!.windows).toHaveLength(AGENT_WINDOW_LIMIT);
    });
});
