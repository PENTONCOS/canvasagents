import { describe, expect, test } from "bun:test";

import en from "../src/i18n/locales/en-US";
import zh from "../src/i18n/locales/zh-CN";

/**
 * 组件里写的是 `t("agent.worktree.badgeLabel")` 这类字面量键，
 * 键被放到错误的层级时不会报错，只会在界面上直接显示键名——所以在这里钉住路径。
 * （E4 就踩过：worktree 段落被插进 `agent.repo` 里，键变成 `agent.repo.worktree.*`。）
 */

function read(source: unknown, path: string): unknown {
    return path.split(".").reduce<unknown>((node, key) => {
        if (!node || typeof node !== "object") return undefined;
        return (node as Record<string, unknown>)[key];
    }, source);
}

const WORKTREE_KEYS = [
    "badgeLabel",
    "mainWorkspace",
    "mainHint",
    "current",
    "tooltipOn",
    "tooltipOff",
    "enable",
    "refresh",
    "disable",
    "remove",
    "created",
    "reused",
    "removed",
    "invalidPath",
    "failed",
];

const BRANCH_KEYS = ["ahead", "inSync", "merge", "mergeIdle", "mergeDone", "mergeConflict", "mergeFailed"];

describe("agent.worktree 文案路径", () => {
    test.each(WORKTREE_KEYS)("中英文都有 agent.worktree.%s 且是非空字符串", (key) => {
        for (const locale of [zh, en]) {
            const value = read(locale, `agent.worktree.${key}`);
            expect(typeof value).toBe("string");
            expect(String(value).length).toBeGreaterThan(0);
        }
    });

    test("不再挂在 agent.repo 下面（否则界面上会显示键名）", () => {
        expect(read(zh, "agent.repo.worktree")).toBeUndefined();
        expect(read(en, "agent.repo.worktree")).toBeUndefined();
    });
});

describe("agent.branch 文案路径", () => {
    test.each(BRANCH_KEYS)("中英文都有 agent.branch.%s 且是非空字符串", (key) => {
        for (const locale of [zh, en]) {
            const value = read(locale, `agent.branch.${key}`);
            expect(typeof value).toBe("string");
            expect(String(value).length).toBeGreaterThan(0);
        }
    });

    test("带插值的键保留占位符，翻译时不会被吃掉", () => {
        expect(String(read(zh, "agent.branch.ahead"))).toContain("{{target}}");
        expect(String(read(zh, "agent.branch.ahead"))).toContain("{{count}}");
        expect(String(read(en, "agent.branch.mergeDone"))).toContain("{{commit}}");
        expect(String(read(en, "agent.branch.mergeConflict"))).toContain("{{files}}");
    });
});
