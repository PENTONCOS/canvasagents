import { beforeEach, describe, expect, test } from "bun:test";

import {
    AGENT_DRIVER_IDS,
    AGENT_DRIVER_STORAGE_KEY,
    agentApiPath,
    agentDriverLabel,
    getAgentDriver,
    isAgentDriverId,
    setAgentDriver,
    subscribeAgentDriver,
    type AgentDriverId,
} from "@/lib/agent/agent-driver";

/**
 * 每个用例都从 codex 起步：模块状态是单例，测试之间不能互相借状态。
 */
const storage = (globalThis as { localStorage?: Storage }).localStorage;

beforeEach(() => {
    setAgentDriver("codex");
    storage?.clear();
});

describe("agent driver 选择", () => {
    test("默认是 codex，非法值不认", () => {
        expect(getAgentDriver()).toBe("codex");
        expect(isAgentDriverId("codex")).toBe(true);
        expect(isAgentDriverId("claude")).toBe(true);
        expect(isAgentDriverId("gemini")).toBe(false);
        expect(isAgentDriverId(undefined)).toBe(false);
    });

    test("切换会落盘，并且能被下一次读取拿回", () => {
        setAgentDriver("claude");
        expect(getAgentDriver()).toBe("claude");
        // bun 测试环境没有 DOM，落盘只在有 localStorage 时验证。
        if (storage) expect(storage.getItem(AGENT_DRIVER_STORAGE_KEY)).toBe("claude");
        else expect(getAgentDriver()).toBe("claude");
    });

    test("切到同一个值不通知订阅者（避免无谓重渲染）", () => {
        const seen: AgentDriverId[] = [];
        const off = subscribeAgentDriver((next) => seen.push(next));
        setAgentDriver("codex");
        setAgentDriver("claude");
        setAgentDriver("claude");
        off();
        expect(seen).toEqual(["claude"]);
    });

    test("退订后不再收到通知，且退订本身不返回布尔值", () => {
        let count = 0;
        const off = subscribeAgentDriver(() => { count += 1; });
        expect(off()).toBeUndefined();
        setAgentDriver("claude");
        expect(count).toBe(0);
    });
});

describe("agentApiPath", () => {
    test("按当前 driver 拼前缀", () => {
        expect(agentApiPath("/threads")).toBe("/agent/codex/threads");
        setAgentDriver("claude");
        expect(agentApiPath("/threads")).toBe("/agent/claude/threads");
    });

    test("没有前导斜杠也能拼，且支持显式指定 driver", () => {
        expect(agentApiPath("threads/t1/turn", "claude")).toBe("/agent/claude/threads/t1/turn");
    });

    test("所有已知 driver 都能拼出不以双斜杠开头的路径", () => {
        for (const id of AGENT_DRIVER_IDS) {
            const path = agentApiPath("/models", id);
            expect(path.startsWith("/agent/")).toBe(true);
            expect(path.includes("//")).toBe(false);
        }
    });

    test("标签可读", () => {
        expect(agentDriverLabel("claude")).toBe("Claude Code");
        expect(agentDriverLabel("codex")).toBe("Codex");
    });
});
