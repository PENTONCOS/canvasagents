import { describe, expect, it } from "bun:test";

import { docSectionLabel, docStats, splitDocSections } from "./doc-node-utils";

describe("splitDocSections", () => {
    it("按 ## 标题切节，正文归到对应节", () => {
        const sections = splitDocSections("## 背景\n这里说背景\n\n## 方案\n这里说方案");
        expect(sections.map((s) => s.title)).toEqual(["背景", "方案"]);
        expect(sections[0].body).toContain("这里说背景");
    });

    it("标题前的正文归到「前言」节，不编造标题", () => {
        const sections = splitDocSections("先说明两句\n\n## 第一节\n正文");
        expect(sections[0].title).toBe("");
        expect(sections[0].body).toBe("先说明两句");
    });

    it("没有标题时整篇算一节", () => {
        const sections = splitDocSections("只有正文，没有标题");
        expect(sections).toHaveLength(1);
        expect(sections[0].title).toBe("");
    });

    it("只有标题还没写正文的节也保留（人常常先立标题），完全空白的节才丢", () => {
        const sections = splitDocSections("## A\n\n## B\n内容\n\n\n");
        expect(sections.map((s) => s.title)).toEqual(["A", "B"]);
        expect(splitDocSections("   \n\n  ")).toEqual([]);
    });

    it("一级标题同样开节", () => {
        expect(splitDocSections("# 大标题\n正文").map((s) => s.title)).toEqual(["大标题"]);
    });
});

describe("docSectionLabel", () => {
    it("没标题的节用序号兜底", () => {
        expect(docSectionLabel({ id: "s1", title: "", body: "x" }, 0)).toBe("第 1 节");
        expect(docSectionLabel({ id: "s2", title: "方案", body: "x" }, 1)).toBe("方案");
    });
});

describe("docStats", () => {
    it("统计有效节数与正文字数（不含空白）", () => {
        const stats = docStats([
            { id: "s1", title: "A", body: "一二 三" },
            { id: "s2", title: "", body: "   " },
        ]);
        expect(stats.sections).toBe(1);
        expect(stats.chars).toBe(3);
    });
});
