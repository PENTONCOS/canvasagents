import { describe, expect, it } from "bun:test";

import { compareStats, splitCompareItems } from "./compare-node-utils";

describe("splitCompareItems", () => {
    it("按行拆条并丢掉空行", () => {
        expect(splitCompareItems("第一条\n\n  第二条  \n")).toEqual(["第一条", "第二条"]);
    });

    it("剥掉 - / * / 1. 这类列表前缀", () => {
        expect(splitCompareItems("- 甲\n* 乙\n1. 丙\n2) 丁")).toEqual(["甲", "乙", "丙", "丁"]);
    });

    it("空文本返回空数组", () => {
        expect(splitCompareItems("   \n\n ")).toEqual([]);
    });
});

describe("compareStats", () => {
    it("两侧条数相同算配平", () => {
        expect(compareStats("a\nb", "c\nd")).toEqual({ problems: 2, solutions: 2, balanced: true, score: 1 });
    });

    it("一侧多一条时不配平，score 是少/多", () => {
        expect(compareStats("a\nb\nc", "d\ne")).toMatchObject({ problems: 3, solutions: 2, balanced: false });
        expect(compareStats("a\nb\nc", "d\ne").score).toBeCloseTo(2 / 3);
    });

    it("任意一侧为空时 score 为 0", () => {
        expect(compareStats("", "d")).toMatchObject({ problems: 0, solutions: 1, balanced: false, score: 0 });
        expect(compareStats("a", "")).toMatchObject({ problems: 1, solutions: 0, balanced: false, score: 0 });
    });
});
