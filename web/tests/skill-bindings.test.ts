import { describe, expect, test } from "bun:test";

import {
    MAX_BOUND_SKILLS,
    bindSkill,
    boundSkills,
    forgetWindow,
    isSkillBound,
    normalizeBindings,
    normalizeSkillNames,
    skillPromptPrefix,
    toggleSkill,
    unbindSkill,
    type SkillBindings,
} from "@/lib/agent/skill-bindings";

describe("normalizeSkillNames", () => {
    test("过滤非法名、去重并保序", () => {
        expect(normalizeSkillNames(["a", "a", "Bad Name", "b-2", "", null, 42])).toEqual(["a", "b-2"]);
    });

    test("超过上限截断", () => {
        const many = Array.from({ length: MAX_BOUND_SKILLS + 5 }, (_, index) => `s-${index}`);
        expect(normalizeSkillNames(many)).toHaveLength(MAX_BOUND_SKILLS);
    });

    test("非数组当空", () => {
        expect(normalizeSkillNames("abc")).toEqual([]);
        expect(normalizeSkillNames(null)).toEqual([]);
    });
});

describe("normalizeBindings", () => {
    test("坏数据一律当空，不抛", () => {
        expect(normalizeBindings(null)).toEqual({});
        expect(normalizeBindings([1, 2])).toEqual({});
        expect(normalizeBindings("x")).toEqual({});
    });

    test("丢掉空窗口与空技能列表", () => {
        expect(normalizeBindings({ "w1": ["a"], "w2": [], "": ["b"], "w3": ["bad name"] })).toEqual({ w1: ["a"] });
    });
});

describe("绑定操作", () => {
    test("绑定后可查，重复绑定返回原引用", () => {
        const start: SkillBindings = {};
        const once = bindSkill(start, "w1", "alpha");
        expect(boundSkills(once, "w1")).toEqual(["alpha"]);
        expect(bindSkill(once, "w1", "alpha")).toBe(once);
        expect(isSkillBound(once, "w1", "alpha")).toBe(true);
    });

    test("不同窗口互不影响", () => {
        const bindings = bindSkill(bindSkill({}, "w1", "alpha"), "w2", "beta");
        expect(boundSkills(bindings, "w1")).toEqual(["alpha"]);
        expect(boundSkills(bindings, "w2")).toEqual(["beta"]);
        expect(boundSkills(bindings, "w3")).toEqual([]);
    });

    test("达到上限不再增长", () => {
        let bindings: SkillBindings = {};
        for (let index = 0; index < MAX_BOUND_SKILLS; index += 1) bindings = bindSkill(bindings, "w1", `s-${index}`);
        const capped = bindSkill(bindings, "w1", "overflow");
        expect(capped).toBe(bindings);
        expect(boundSkills(capped, "w1")).toHaveLength(MAX_BOUND_SKILLS);
    });

    test("解绑最后一个技能时删掉窗口键，避免留下空数组", () => {
        const bindings = bindSkill({}, "w1", "alpha");
        const empty = unbindSkill(bindings, "w1", "alpha");
        expect(empty).toEqual({});
        expect("w1" in empty).toBe(false);
    });

    test("解绑不存在的技能返回原引用", () => {
        const bindings = bindSkill({}, "w1", "alpha");
        expect(unbindSkill(bindings, "w1", "beta")).toBe(bindings);
    });

    test("toggle 一次装一次卸", () => {
        const on = toggleSkill({}, "w1", "alpha");
        expect(isSkillBound(on, "w1", "alpha")).toBe(true);
        const off = toggleSkill(on, "w1", "alpha");
        expect(isSkillBound(off, "w1", "alpha")).toBe(false);
    });

    test("删除窗口时清掉它的绑定", () => {
        const bindings = bindSkill(bindSkill({}, "w1", "alpha"), "w2", "beta");
        expect(forgetWindow(bindings, "w1")).toEqual({ w2: ["beta"] });
        expect(forgetWindow(bindings, "w9")).toBe(bindings);
    });
});

describe("skillPromptPrefix", () => {
    test("没装技能时不加任何前缀", () => {
        expect(skillPromptPrefix({}, "w1", "做个登录页")).toBe("");
    });

    test("装了就拼成一行技能声明", () => {
        const bindings = bindSkill(bindSkill({}, "w1", "alpha"), "w1", "beta");
        expect(skillPromptPrefix(bindings, "w1", "做个登录页")).toBe("技能：$alpha $beta\n");
    });

    test("提示词里已经写过的技能不重复加", () => {
        const bindings = bindSkill({}, "w1", "alpha");
        expect(skillPromptPrefix(bindings, "w1", "用 $alpha 做登录页")).toBe("");
    });

    test("前缀匹配不误伤同名更长技能（$alpha 不该吃掉 $alphabet）", () => {
        const bindings = bindSkill({}, "w1", "alpha");
        expect(skillPromptPrefix(bindings, "w1", "用 $alphabet 做")).toBe("技能：$alpha\n");
    });
});
