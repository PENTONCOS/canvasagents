import { beforeEach, describe, expect, test } from "bun:test";

import { useDeliveryStore } from "@/stores/use-delivery-store";
import type { AcceptanceCriterion, DeliveryBug } from "@/types/delivery";

function makeAc(id: string, overrides: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
    return { id, statement: `stmt ${id}`, journeyIds: [], stepIds: [], testCaseIds: [], status: "draft", ...overrides };
}

function makeBug(id: string, overrides: Partial<DeliveryBug> = {}): DeliveryBug {
    return { id, title: `bug ${id}`, severity: "P1", violates: [], status: "open", fixRunIds: [], ...overrides };
}

beforeEach(() => {
    useDeliveryStore.getState().resetDelivery();
});

describe("delivery store", () => {
    test("upsertAc and removeAc round-trip", () => {
        const { upsertAc, removeAc } = useDeliveryStore.getState();
        upsertAc(makeAc("AC-01"));
        expect(useDeliveryStore.getState().acceptance["AC-01"].statement).toBe("stmt AC-01");
        removeAc("AC-01");
        expect(useDeliveryStore.getState().acceptance["AC-01"]).toBeUndefined();
    });

    test("removeAc drops anchored test cases, keeps others", () => {
        const { upsertAc, upsertTestCase, removeAc } = useDeliveryStore.getState();
        upsertAc(makeAc("AC-01"));
        upsertTestCase({ id: "T-1", acId: "AC-01", title: "anchored" });
        upsertTestCase({ id: "T-2", acId: "AC-02", title: "other" });
        removeAc("AC-01");
        const { testCases } = useDeliveryStore.getState();
        expect(testCases["T-1"]).toBeUndefined();
        expect(testCases["T-2"].title).toBe("other");
    });

    test("setAcStatus follows the state machine and records runId", () => {
        const { upsertAc, setAcStatus } = useDeliveryStore.getState();
        upsertAc(makeAc("AC-01"));
        expect(setAcStatus("AC-01", "ready").ok).toBe(true);
        expect(useDeliveryStore.getState().acceptance["AC-01"].status).toBe("ready");
        expect(setAcStatus("AC-01", "failing", "run-1").ok).toBe(true);
        const ac = useDeliveryStore.getState().acceptance["AC-01"];
        expect(ac.status).toBe("failing");
        expect(ac.lastRunId).toBe("run-1");
    });

    test("setAcStatus rejects illegal transitions and reports unknown ids", () => {
        const { upsertAc, setAcStatus } = useDeliveryStore.getState();
        upsertAc(makeAc("AC-01"));
        expect(setAcStatus("AC-01", "passing").ok).toBe(false); // draft -> passing illegal
        expect(useDeliveryStore.getState().acceptance["AC-01"].status).toBe("draft");
        expect(setAcStatus("NOPE", "ready").ok).toBe(false);
    });

    test("setBugStatus ignores unknown ids without corrupting state", () => {
        const { upsertBug, setBugStatus } = useDeliveryStore.getState();
        upsertBug(makeBug("BUG-01"));
        setBugStatus("NOPE", "fixed");
        setBugStatus("BUG-01", "fixing");
        expect(useDeliveryStore.getState().bugs["BUG-01"].status).toBe("fixing");
    });

    test("run and environment CRUD", () => {
        const { upsertRun, upsertEnvironment, removeEnvironment } = useDeliveryStore.getState();
        upsertRun({ id: "run-1", kind: "test", command: "bun test", cwd: "/repo", startedAt: "2026-10-21T00:00:00Z", status: "passed", results: [] });
        expect(useDeliveryStore.getState().runs["run-1"].status).toBe("passed");
        upsertEnvironment({ id: "env-1", name: "staging", url: "https://stg.example.com", status: "unknown" });
        removeEnvironment("env-1");
        expect(useDeliveryStore.getState().environments["env-1"]).toBeUndefined();
    });
});

describe("delivery store · 旅程与设计版本 (M1)", () => {
    test("removeJourney 级联删除步骤与设计版本", () => {
        const store = useDeliveryStore.getState();
        store.upsertJourney({ id: "J-01", title: "改约流程", stepIds: ["J-01-S1"] });
        store.upsertJourney({ id: "J-02", title: "支付流程", stepIds: [] });
        store.upsertStep({ id: "J-01-S1", journeyId: "J-01", order: 1, title: "进入预约页" });
        store.upsertStep({ id: "J-02-S1", journeyId: "J-02", order: 1, title: "选择支付方式" });
        store.upsertDesign({ id: "D-01-A", journeyId: "J-01", label: "A", selected: true });

        store.removeJourney("J-01");

        const state = useDeliveryStore.getState();
        expect(state.journeys["J-01"]).toBeUndefined();
        expect(state.steps["J-01-S1"]).toBeUndefined();
        expect(state.designs["D-01-A"]).toBeUndefined();
        // 其他旅程不受影响，不能误删。
        expect(state.journeys["J-02"]).toBeDefined();
        expect(state.steps["J-02-S1"]).toBeDefined();
    });

    test("selectDesign 保证同一旅程至多一版选中", () => {
        const store = useDeliveryStore.getState();
        store.upsertJourney({ id: "J-01", title: "改约流程", stepIds: [] });
        store.upsertDesign({ id: "D-01-A", journeyId: "J-01", label: "A", selected: true });
        store.upsertDesign({ id: "D-01-B", journeyId: "J-01", label: "B", selected: false });

        store.selectDesign("D-01-B");

        const state = useDeliveryStore.getState();
        expect(state.designs["D-01-A"].selected).toBe(false);
        expect(state.designs["D-01-B"].selected).toBe(true);
    });

    test("upsertDesign 选中新版本时旧版本自动让位", () => {
        const store = useDeliveryStore.getState();
        store.upsertJourney({ id: "J-01", title: "改约流程", stepIds: [] });
        store.upsertDesign({ id: "D-01-A", journeyId: "J-01", label: "A", selected: true });
        store.upsertDesign({ id: "D-01-C", journeyId: "J-01", label: "C", selected: true });

        const state = useDeliveryStore.getState();
        expect(state.designs["D-01-A"].selected).toBe(false);
        expect(state.designs["D-01-C"].selected).toBe(true);
    });

    test("selectDesign 对不存在的 id 不改状态", () => {
        const store = useDeliveryStore.getState();
        store.upsertDesign({ id: "D-01-A", journeyId: "J-01", label: "A", selected: true });
        store.selectDesign("D-99-Z");
        expect(useDeliveryStore.getState().designs["D-01-A"].selected).toBe(true);
    });

    test("appendRunRound 把无锚点轮次记成 skipped，而不是 failed", () => {
        const store = useDeliveryStore.getState();
        store.upsertRun({
            id: "RUN-1",
            kind: "test",
            command: "npm test",
            cwd: "/tmp",
            startedAt: "2026-10-22T00:00:00.000Z",
            status: "running",
            results: [],
        });
        store.appendRunRound("RUN-1", {
            index: 1,
            startedAt: "2026-10-22T00:00:00.000Z",
            status: "skipped",
            passed: 0,
            failed: 0,
            skipped: 3,
            failures: [],
        });
        expect(useDeliveryStore.getState().runs["RUN-1"].status).toBe("skipped");
    });

    test("appendRunRound 里先失败后无锚点，运行仍是 failed", () => {
        const store = useDeliveryStore.getState();
        store.upsertRun({
            id: "RUN-2",
            kind: "test",
            command: "npm test",
            cwd: "/tmp",
            startedAt: "2026-10-22T00:00:00.000Z",
            status: "running",
            results: [],
        });
        store.appendRunRound("RUN-2", { index: 1, startedAt: "t1", status: "failed", passed: 0, failed: 1, skipped: 0, failures: [] });
        store.appendRunRound("RUN-2", { index: 2, startedAt: "t2", status: "skipped", passed: 0, failed: 0, skipped: 2, failures: [] });
        expect(useDeliveryStore.getState().runs["RUN-2"].status).toBe("failed");
    });
});

// D3: 用例挂 AC + AC 挂旅程/步骤。两点都必须双向一致：
// 用例上写 acId、AC 上留 testCaseIds，删一边另一边也跟着变。
describe("delivery store: AC ↔ 用例 / 旅程", () => {
    function makeStep(id: string, journeyId: string, order: number) {
        return { id, journeyId, order, title: `步骤 ${order}` };
    }

    test("createTestCaseForAc 双向挂上，并自动生成 @AC-01 锚点", () => {
        const store = useDeliveryStore.getState();
        store.upsertAc(makeAc("AC-01"));
        const created = store.createTestCaseForAc("AC-01", { title: "  点击后跳转详情  " });
        expect(created).not.toBeNull();
        expect(created?.id).toBe("TC-01");
        expect(created?.acId).toBe("AC-01");
        expect(created?.selector).toBe("@AC-01");
        expect(created?.title).toBe("点击后跳转详情");
        const state = useDeliveryStore.getState();
        expect(state.testCases["TC-01"].selector).toBe("@AC-01");
        expect(state.acceptance["AC-01"].testCaseIds).toEqual(["TC-01"]);
    });

    test("createTestCaseForAc 拒绝未知 AC 与空标题", () => {
        const store = useDeliveryStore.getState();
        store.upsertAc(makeAc("AC-01"));
        expect(store.createTestCaseForAc("AC-99", { title: "x" })).toBeNull();
        expect(store.createTestCaseForAc("AC-01", { title: "   " })).toBeNull();
        expect(Object.keys(useDeliveryStore.getState().testCases)).toEqual([]);
    });

    test("removeTestCase 摘掉 AC 上的索引，AC 本身保留", () => {
        const store = useDeliveryStore.getState();
        store.upsertAc(makeAc("AC-01"));
        const created = store.createTestCaseForAc("AC-01", { title: "用例一" });
        store.removeTestCase(created?.id ?? "");
        const state = useDeliveryStore.getState();
        expect(state.testCases[created?.id ?? ""]).toBeUndefined();
        expect(state.acceptance["AC-01"].testCaseIds).toEqual([]);
    });

    test("upsertTestCase 换 AC 时旧 AC 的索引也要摘掉", () => {
        const store = useDeliveryStore.getState();
        store.upsertAc(makeAc("AC-01"));
        store.upsertAc(makeAc("AC-02"));
        store.upsertTestCase({ id: "TC-01", acId: "AC-01", title: "换挂" });
        expect(useDeliveryStore.getState().acceptance["AC-01"].testCaseIds).toEqual(["TC-01"]);
        store.upsertTestCase({ id: "TC-01", acId: "AC-02", title: "换挂", selector: "@AC-02" });
        const state = useDeliveryStore.getState();
        expect(state.acceptance["AC-01"].testCaseIds).toEqual([]);
        expect(state.acceptance["AC-02"].testCaseIds).toEqual(["TC-01"]);
    });

    test("setAcStep 挂步骤时自动补所属旅程", () => {
        const store = useDeliveryStore.getState();
        store.upsertAc(makeAc("AC-01"));
        store.upsertJourney({ id: "J-01", title: "下单", stepIds: ["J-01-S1"] });
        store.upsertStep(makeStep("J-01-S1", "J-01", 1));
        expect(store.setAcStep("AC-01", "J-01-S1").ok).toBe(true);
        const ac = useDeliveryStore.getState().acceptance["AC-01"];
        expect(ac.journeyIds).toEqual(["J-01"]);
        expect(ac.stepIds).toEqual(["J-01-S1"]);
    });

    test("setAcStep 拒绝未知步骤，setAcJourney 摘掉不属于新旅程的步骤", () => {
        const store = useDeliveryStore.getState();
        store.upsertAc(makeAc("AC-01"));
        store.upsertJourney({ id: "J-01", title: "下单", stepIds: ["J-01-S1"] });
        store.upsertJourney({ id: "J-02", title: "退款", stepIds: ["J-02-S1"] });
        store.upsertStep(makeStep("J-01-S1", "J-01", 1));
        store.upsertStep(makeStep("J-02-S1", "J-02", 1));
        expect(store.setAcStep("AC-01", "J-99-S9").ok).toBe(false);
        store.setAcStep("AC-01", "J-01-S1");
        store.setAcJourney("AC-01", "J-02");
        const ac = useDeliveryStore.getState().acceptance["AC-01"];
        expect(ac.journeyIds).toEqual(["J-02"]);
        // 旧旅程的步骤不能跟着挂到新旅程上。
        expect(ac.stepIds).toEqual([]);
        store.setAcJourney("AC-01", undefined);
        expect(useDeliveryStore.getState().acceptance["AC-01"].journeyIds).toEqual([]);
    });
});
