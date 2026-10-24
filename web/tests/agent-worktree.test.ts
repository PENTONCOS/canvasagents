import { describe, expect, test } from "bun:test";

import { createAgentWindow, parsePersistedWindows, projectPersistedWindows } from "../src/lib/agent/agent-windows";
import { readWorktreeList, readWorktreeResult, threadWorktreeCwd, worktreeLabel, worktreeTaskId } from "../src/lib/agent/agent-worktree";

describe("worktreeTaskId", () => {
    test("用会话窗标题当任务名，去掉首尾空白", () => {
        expect(worktreeTaskId("  蓝色调改图  ", "win-1")).toBe("蓝色调改图");
    });

    test("标题为空时退回窗口 id", () => {
        expect(worktreeTaskId("   ", "win-1")).toBe("win-1");
    });

    test("标题与 id 都为空时返回空串，由桥端报「缺少任务 id」", () => {
        expect(worktreeTaskId("", "")).toBe("");
    });
});

describe("readWorktreeResult", () => {
    test("收窄正常响应", () => {
        const result = readWorktreeResult({ ok: true, taskId: " 任务 A ", path: "/tmp/wt/任务-a-abc123", branch: "canvas/task-abc123", created: true });
        expect(result).toEqual({ taskId: "任务 A", path: "/tmp/wt/任务-a-abc123", branch: "canvas/task-abc123", created: true });
    });

    test("相对路径视为失败：把相对路径当 cwd 等于在桥端进程目录里跑 agent", () => {
        expect(readWorktreeResult({ path: "tmp/wt" })).toBeNull();
    });

    test("缺路径或非对象一律 null", () => {
        expect(readWorktreeResult({})).toBeNull();
        expect(readWorktreeResult({ path: "  " })).toBeNull();
        expect(readWorktreeResult(null)).toBeNull();
        expect(readWorktreeResult("不是对象")).toBeNull();
    });

    test("created 只认 true，其余当复用", () => {
        expect(readWorktreeResult({ path: "/tmp/a", created: "yes" })?.created).toBe(false);
        expect(readWorktreeResult({ path: "/tmp/a" })?.created).toBe(false);
    });
});

describe("readWorktreeList", () => {
    test("过滤掉空路径与相对路径条目", () => {
        const list = readWorktreeList({ worktrees: [{ path: "/tmp/a", taskId: "A" }, { path: "" }, { path: "b" }, null] });
        expect(list).toHaveLength(1);
        expect(list[0].path).toBe("/tmp/a");
    });

    test("结构不对时返回空数组而不是抛错", () => {
        expect(readWorktreeList(null)).toEqual([]);
        expect(readWorktreeList({ worktrees: "nope" })).toEqual([]);
        expect(readWorktreeList({})).toEqual([]);
    });
});

describe("worktreeLabel", () => {
    test("取目录末段", () => {
        expect(worktreeLabel("/Users/x/.canvasagents/worktrees/repo/task-01-abc123")).toBe("task-01-abc123");
    });

    test("末尾斜杠不影响", () => {
        expect(worktreeLabel("/tmp/a/b/")).toBe("b");
    });

    test("空路径返回空串", () => {
        expect(worktreeLabel("")).toBe("");
        expect(worktreeLabel("   ")).toBe("");
    });
});

describe("threadWorktreeCwd", () => {
    test("有 worktree 时作为 cwd 传给桥端", () => {
        expect(threadWorktreeCwd({ worktreePath: "/tmp/wt" })).toBe("/tmp/wt");
    });

    test("没有 worktree 时传空串，桥端按 repoId / 站点工作空间解析（E4 之前的行为）", () => {
        expect(threadWorktreeCwd({ worktreePath: "" })).toBe("");
        expect(threadWorktreeCwd(null)).toBe("");
    });
});

describe("worktreePath 持久化", () => {
    test("会话窗骨架带上任务 worktree 路径", () => {
        const window = createAgentWindow({ id: "win-1", title: "任务 A", worktreePath: "/tmp/wt/task-a" });
        const saved = projectPersistedWindows([window], "win-1");
        expect(saved.windows[0]).toEqual({ id: "win-1", title: "任务 A", cliMode: false, cliSession: "", worktreePath: "/tmp/wt/task-a" });
    });

    test("刷新恢复绝对路径的 worktree", () => {
        const raw = JSON.stringify({ activeWindowId: "win-1", windows: [{ id: "win-1", title: "任务 A", worktreePath: "/tmp/wt/task-a" }] });
        const restored = parsePersistedWindows(raw);
        expect(restored?.windows[0].worktreePath).toBe("/tmp/wt/task-a");
    });

    test("相对路径 / 空值 / 非字符串一律退回主工作区，不把 cwd 交给猜出来的位置", () => {
        const raw = JSON.stringify({
            activeWindowId: "win-1",
            windows: [
                { id: "win-1", title: "A", worktreePath: "relative/path" },
                { id: "win-2", title: "B", worktreePath: "   " },
                { id: "win-3", title: "C", worktreePath: 42 },
            ],
        });
        const restored = parsePersistedWindows(raw);
        expect(restored?.windows.map((item) => item.worktreePath)).toEqual(["", "", ""]);
    });
});
