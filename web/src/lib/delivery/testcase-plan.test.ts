import { describe, expect, test } from "bun:test";
import type { AcceptanceCriterion, DeliveryTestCase } from "@/types/delivery";
import { mergeParsedCases, parseTestCaseReply, planCasesForAc } from "./testcase-plan";

const ac: AcceptanceCriterion = {
    id: "AC-04",
    statement: "提交预约时必须校验时间段冲突",
    journeyIds: ["J-01"],
    stepIds: [],
    testCaseIds: [],
    status: "ready",
};

describe("planCasesForAc", () => {
    test("为一条 AC 生成三层用例，且都带 @AC-04 锚点", () => {
        const made = planCasesForAc(ac, []);
        expect(made.length).toBe(3);
        expect(made.map((item) => item.layer)).toEqual(["unit", "component", "e2e"]);
        for (const item of made) {
            expect(item.acId).toBe("AC-04");
            expect(item.selector).toBe("@AC-04");
            expect(item.title).toContain("提交预约时必须校验时间段冲突");
        }
    });

    test("重复生成不产生重复用例", () => {
        const first = planCasesForAc(ac, []);
        const second = planCasesForAc(ac, first as DeliveryTestCase[]);
        expect(second.length).toBe(0);
    });
});

describe("parseTestCaseReply", () => {
    test("解析 fenced JSON 用例清单", () => {
        const text = '这里是结果\n```json\n{"testCases":[{"acId":"AC-04","title":"冲突时段被拒绝","layer":"e2e"}]}\n```';
        const parsed = parseTestCaseReply(text, new Set(["AC-04"]));
        expect(parsed).toEqual([{ acId: "AC-04", title: "冲突时段被拒绝", layer: "e2e", file: undefined }]);
    });

    test("解析带锚点的列表行并归一化编号", () => {
        const parsed = parseTestCaseReply("- [unit] 校验冲突 @AC-4", new Set(["AC-04"]));
        expect(parsed.length).toBe(1);
        expect(parsed[0].acId).toBe("AC-04");
        expect(parsed[0].title).toBe("校验冲突");
        expect(parsed[0].layer).toBe("unit");
    });

    test("丢弃不存在的 AC 与重复项", () => {
        const text = '```json\n{"testCases":[{"acId":"AC-99","title":"x"},{"acId":"AC-04","title":"y"},{"acId":"AC-04","title":"y"}]}\n```';
        const parsed = parseTestCaseReply(text, new Set(["AC-04"]));
        expect(parsed.length).toBe(1);
        expect(parsed[0].title).toBe("y");
    });
});

describe("mergeParsedCases", () => {
    test("只落库有效 AC 的用例并返回新增数", () => {
        const stored: DeliveryTestCase[] = [];
        const added = mergeParsedCases(
            [{ acId: "AC-04", title: "a" }, { acId: "AC-04", title: "a" }, { acId: "AC-99", title: "b" }],
            { acceptance: { "AC-04": ac }, testCases: {} },
            (testCase) => stored.push(testCase),
        );
        expect(added).toBe(1);
        expect(stored.length).toBe(1);
        expect(stored[0].selector).toBe("@AC-04");
    });
});
