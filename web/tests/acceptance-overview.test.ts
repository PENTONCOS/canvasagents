import { describe, expect, test } from "bun:test";

import { buildAcceptanceOverview, inferTestLayer } from "@/lib/delivery/acceptance-overview";
import type { AcceptanceCriterion, DeliveryBug, DeliveryTestCase, Journey, JourneyStep } from "@/types/delivery";

function ac(overrides: Partial<AcceptanceCriterion> & Pick<AcceptanceCriterion, "id">): AcceptanceCriterion {
    return { statement: overrides.id, journeyIds: [], stepIds: [], testCaseIds: [], status: "draft", ...overrides };
}

function step(overrides: Partial<JourneyStep> & Pick<JourneyStep, "id" | "journeyId">): JourneyStep {
    return { order: 1, title: overrides.id, ...overrides };
}

function journey(overrides: Partial<Journey> & Pick<Journey, "id">): Journey {
    return { title: overrides.id, stepIds: [], ...overrides };
}

function testCase(overrides: Partial<DeliveryTestCase> & Pick<DeliveryTestCase, "id" | "acId">): DeliveryTestCase {
    return { title: overrides.id, ...overrides };
}

function bug(overrides: Partial<DeliveryBug> & Pick<DeliveryBug, "id">): DeliveryBug {
    return { title: overrides.id, severity: "major", violates: [], status: "open", fixRunIds: [], ...overrides };
}

describe("F1 验收一览", () => {
    test("没有数据时是空表，不会伪造行", () => {
        const overview = buildAcceptanceOverview({});
        expect(overview.rows).toEqual([]);
        expect(overview.totalAcs).toBe(0);
        expect(overview.unprovenAcs).toBe(0);
    });

    test("旅程步骤成为用户故事行，AC 挂在中间列", () => {
        const overview = buildAcceptanceOverview({
            journeys: { "J-01": journey({ id: "J-01", title: "一键上线" }) },
            steps: { "J-01-S1": step({ id: "J-01-S1", journeyId: "J-01", title: "创建需求" }) },
            acceptance: { "AC-01": ac({ id: "AC-01", statement: "能创建需求节点", stepIds: ["J-01-S1"], status: "passing" }) },
        });
        expect(overview.rows).toHaveLength(1);
        expect(overview.rows[0]).toMatchObject({ key: "J-01-S1", storyId: "J-01-S1", storyTitle: "创建需求", journeyTitle: "一键上线" });
        expect(overview.rows[0].acs[0]).toMatchObject({ id: "AC-01", statement: "能创建需求节点", status: "passing" });
    });

    test("挂在旅程上但没细到步骤的 AC 落在旅程行", () => {
        const overview = buildAcceptanceOverview({
            journeys: { "J-02": journey({ id: "J-02", title: "验收闭环" }) },
            acceptance: { "AC-07": ac({ id: "AC-07", journeyIds: ["J-02"] }) },
        });
        expect(overview.rows).toHaveLength(1);
        expect(overview.rows[0].key).toBe("J-02");
        expect(overview.rows[0].acs.map((item) => item.id)).toEqual(["AC-07"]);
    });

    test("没挂到任何故事的 AC 必须出现，不能静默丢掉", () => {
        const overview = buildAcceptanceOverview({ acceptance: { "AC-99": ac({ id: "AC-99" }) } });
        expect(overview.rows).toHaveLength(1);
        expect(overview.rows[0].key).toBe("unassigned");
        expect(overview.rows[0].acs.map((item) => item.id)).toEqual(["AC-99"]);
    });

    test("同一条 AC 不会因为同时挂在步骤和旅程上而重复出现", () => {
        const overview = buildAcceptanceOverview({
            journeys: { "J-01": journey({ id: "J-01" }) },
            steps: { "J-01-S1": step({ id: "J-01-S1", journeyId: "J-01" }) },
            acceptance: { "AC-01": ac({ id: "AC-01", stepIds: ["J-01-S1"], journeyIds: ["J-01"] }) },
        });
        expect(overview.totalAcs).toBe(1);
        expect(overview.rows).toHaveLength(1);
        expect(overview.rows[0].key).toBe("J-01-S1");
    });

    test("一条用例都没有的 AC 标成无测试兜底", () => {
        const overview = buildAcceptanceOverview({ acceptance: { "AC-02": ac({ id: "AC-02", status: "passing" }) } });
        expect(overview.rows[0].acs[0].unproven).toBe(true);
        expect(overview.unprovenAcs).toBe(1);
    });

    test("用例按层级归类，并统计每层数量", () => {
        const overview = buildAcceptanceOverview({
            acceptance: { "AC-03": ac({ id: "AC-03" }) },
            testCases: {
                "T-1": testCase({ id: "T-1", acId: "AC-03", title: "纯函数", file: "tests/ac.test.ts" }),
                "T-2": testCase({ id: "T-2", acId: "AC-03", title: "页面", file: "e2e/flow.e2e.ts" }),
                "T-3": testCase({ id: "T-3", acId: "AC-03", title: "故事", file: "src/a.stories.tsx" }),
            },
        });
        const item = overview.rows[0].acs[0];
        expect(item.unproven).toBe(false);
        expect(item.layers.unit).toEqual(["纯函数"]);
        expect(item.layers.e2e).toEqual(["页面"]);
        expect(item.layers.component).toEqual(["故事"]);
        expect(overview.layerCounts).toMatchObject({ unit: 1, component: 1, daemon: 0, e2e: 1, manual: 0 });
    });

    test("违反 AC 的问题单出现在怎么验一列", () => {
        const overview = buildAcceptanceOverview({
            acceptance: { "AC-04": ac({ id: "AC-04", status: "failing" }) },
            bugs: { "BUG-03": bug({ id: "BUG-03", violates: ["AC-04"] }), "BUG-09": bug({ id: "BUG-09", violates: ["AC-08"] }) },
        });
        expect(overview.rows[0].acs[0].bugs).toEqual(["BUG-03"]);
        expect(overview.failingAcs).toBe(1);
    });

    test("用例层级推断：e2e 锚点 > story > 桥端目录 > 默认纯函数", () => {
        expect(inferTestLayer(testCase({ id: "a", acId: "AC-01", file: "e2e/x.e2e.ts" }))).toBe("e2e");
        expect(inferTestLayer(testCase({ id: "b", acId: "AC-01", selector: "@BOT-2" }))).toBe("e2e");
        expect(inferTestLayer(testCase({ id: "c", acId: "AC-01", file: "src/x.stories.tsx" }))).toBe("component");
        expect(inferTestLayer(testCase({ id: "d", acId: "AC-01", file: "canvas-agent/src/a.test.ts" }))).toBe("daemon");
        expect(inferTestLayer(testCase({ id: "e", acId: "AC-01", file: "web/tests/a.test.ts" }))).toBe("unit");
    });

    test("显式写了 layer 就按写的算，不被路径推断覆盖", () => {
        expect(inferTestLayer(testCase({ id: "f", acId: "AC-01", file: "e2e/x.e2e.ts", layer: "manual" }))).toBe("manual");
    });

    test("顶部层级统计把人工走查也算进去", () => {
        const overview = buildAcceptanceOverview({
            testCases: {
                "T-1": testCase({ id: "T-1", acId: "AC-01", layer: "manual", title: "人工过一遍" }),
            },
        });
        expect(overview.layerCounts.manual).toBe(1);
    });
});
