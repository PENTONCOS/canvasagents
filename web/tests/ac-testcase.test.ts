import { describe, expect, test } from "bun:test";

import { acAnchor, buildAcTestCasePrompt, createTestCaseDraft, nextTestCaseId, withAcRelations } from "@/lib/delivery/ac-testcase";
import type { AcceptanceCriterion, DeliveryTestCase, Journey, JourneyStep } from "@/types/delivery";

function makeAc(overrides: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
    return {
        id: "AC-01",
        statement: "点击「去结算」后进入订单详情页，且金额与购物车一致。",
        journeyIds: [],
        stepIds: [],
        testCaseIds: [],
        status: "draft",
        ...overrides,
    };
}

const journey: Journey = { id: "J-01", title: "下单", stepIds: ["J-01-S1", "J-01-S2"] };
const steps: JourneyStep[] = [
    { id: "J-01-S2", journeyId: "J-01", order: 2, title: "提交订单" },
    { id: "J-01-S1", journeyId: "J-01", order: 1, title: "加入购物车" },
];

describe("acAnchor", () => {
    test("标准编号原样生成两位锚点", () => {
        expect(acAnchor("AC-01")).toBe("@AC-01");
        expect(acAnchor("AC-12")).toBe("@AC-12");
    });

    test("个位数编号补零，避免 @AC-1 / @AC-01 各记一套", () => {
        expect(acAnchor("AC-1")).toBe("@AC-01");
        expect(acAnchor(" ac-7 ")).toBe("@AC-07");
    });

    test("不符合编号规则时退化为原样加 @（不猜）", () => {
        expect(acAnchor("BUG-X")).toBe("@BUG-X");
    });
});

describe("nextTestCaseId / createTestCaseDraft", () => {
    test("编号按现有 TC 顺延，两位补齐", () => {
        expect(nextTestCaseId([])).toBe("TC-01");
        expect(nextTestCaseId(["TC-01", "TC-09", "BUG-03"])).toBe("TC-10");
    });

    test("草稿同时写死 acId 与锚点，标题去空白", () => {
        const draft = createTestCaseDraft({ acId: "AC-01", title: "  结算跳转  ", existingIds: ["TC-01"] });
        expect(draft.id).toBe("TC-02");
        expect(draft.acId).toBe("AC-01");
        expect(draft.selector).toBe("@AC-01");
        expect(draft.title).toBe("结算跳转");
    });
});

describe("buildAcTestCasePrompt", () => {
    test("带 AC 正文、旅程与步骤（按 order 排）和已有用例", () => {
        const existing: DeliveryTestCase[] = [{ id: "TC-01", acId: "AC-01", title: "已有用例" }];
        const prompt = buildAcTestCasePrompt({ ac: makeAc(), journey, steps, existing });
        expect(prompt).toContain("@AC-01");
        expect(prompt).toContain("AC-01：点击「去结算」后进入订单详情页，且金额与购物车一致。");
        expect(prompt).toContain("J-01 下单");
        expect(prompt).toContain("J-01-S1 加入购物车");
        expect(prompt).toContain("J-01-S2 提交订单");
        // 步骤按 order 排：S1 必须在 S2 前面，否则 Agent 拿到的流程是乱的。
        expect(prompt.indexOf("J-01-S1")).toBeLessThan(prompt.indexOf("J-01-S2"));
        expect(prompt).toContain("TC-01 已有用例");
    });

    test("没有旅程/步骤/用例时也不留空洞占位", () => {
        const prompt = buildAcTestCasePrompt({ ac: makeAc(), steps: [], existing: [] });
        expect(prompt).toContain("@AC-01");
        expect(prompt).not.toContain("J-01");
        expect(prompt).toContain("@AC-01");
    });

    test("锚点要求逐条写明（缺锚点记 skipped）", () => {
        const prompt = buildAcTestCasePrompt({ ac: makeAc() });
        const anchorLines = prompt.split("\n").filter((line) => line.includes("@AC-01"));
        expect(anchorLines.length).toBeGreaterThanOrEqual(2);
        expect(prompt).toContain("skipped");
    });
});

describe("withAcRelations", () => {
    test("老记录缺关联数组时补空数组，其余字段不动", () => {
        const legacy = { id: "AC-02", statement: "老数据", status: "ready" } as unknown as AcceptanceCriterion;
        const normalized = withAcRelations(legacy);
        expect(normalized.journeyIds).toEqual([]);
        expect(normalized.stepIds).toEqual([]);
        expect(normalized.testCaseIds).toEqual([]);
        expect(normalized.statement).toBe("老数据");
        expect(normalized.status).toBe("ready");
    });
});
