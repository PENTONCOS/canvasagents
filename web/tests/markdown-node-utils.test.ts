import { describe, expect, test } from "bun:test";

import { isMarkdownBlank, markdownDocStats } from "@/lib/canvas/markdown-node-utils";

describe("markdown node utils (A1)", () => {
    test("blank detection treats whitespace-only as blank", () => {
        expect(isMarkdownBlank("")).toBe(true);
        expect(isMarkdownBlank("   \n\t ")).toBe(true);
        expect(isMarkdownBlank(undefined)).toBe(true);
        expect(isMarkdownBlank(null)).toBe(true);
        expect(isMarkdownBlank("# 标题")).toBe(false);
    });

    test("counts lines and characters, normalizing CRLF", () => {
        const stats = markdownDocStats("# 标题\n- a\n- b");
        expect(stats.lines).toBe(3);
        expect(stats.characters).toBe("# 标题\n- a\n- b".length);
        expect(markdownDocStats("a\r\nb").lines).toBe(2);
    });

    test("counts ATX headings outside fenced code blocks", () => {
        const source = ["# 一级", "## 二级", "```js", "# 这是代码注释", "```", "####### 七个井号不算标题", "#没有空格也不算"].join("\n");
        expect(markdownDocStats(source).headings).toBe(2);
    });

    test("tilde fences are recognized too", () => {
        const source = ["~~~", "# not a heading", "~~~", "### 真标题"].join("\n");
        expect(markdownDocStats(source).headings).toBe(1);
    });

    test("empty input yields zeroed stats", () => {
        expect(markdownDocStats("")).toEqual({ characters: 0, lines: 0, headings: 0 });
        expect(markdownDocStats(undefined as unknown as string)).toEqual({ characters: 0, lines: 0, headings: 0 });
    });

    test("setext-style headings are not miscounted as ATX", () => {
        expect(markdownDocStats("标题\n====").headings).toBe(0);
    });
});
