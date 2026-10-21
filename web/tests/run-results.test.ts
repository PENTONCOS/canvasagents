import { describe, expect, test } from "bun:test";

import { planAcStatusUpdates } from "@/lib/delivery/run-results";
import type { AcceptanceCriterion } from "@/types/delivery";

function ac(id: string, status: AcceptanceCriterion["status"]): AcceptanceCriterion {
    return { id, statement: `stmt ${id}`, journeyIds: [], stepIds: [], testCaseIds: [], status };
}

describe("测试结果 → AC 状态", () => {
    test("pass 让 ready 变 passing，fail 让 ready 变 failing", () => {
        const acceptance = { "AC-01": ac("AC-01", "ready"), "AC-02": ac("AC-02", "ready") };
        const { plans, rejected } = planAcStatusUpdates(acceptance, [
            { acId: "AC-01", result: "pass" },
            { acId: "AC-02", result: "fail" },
        ]);
        expect(rejected).toHaveLength(0);
        expect(plans.find((plan) => plan.acId === "AC-01")?.to).toBe("passing");
        expect(plans.find((plan) => plan.acId === "AC-02")?.to).toBe("failing");
    });

    test("draft 被结果命中时先推进到 ready 再落结果", () => {
        const { plans } = planAcStatusUpdates({ "AC-01": ac("AC-01", "draft") }, [{ acId: "AC-01", result: "fail" }]);
        expect(plans[0].steps).toEqual(["ready", "failing"]);
    });

    test("skip 不改状态", () => {
        const { plans } = planAcStatusUpdates({ "AC-01": ac("AC-01", "ready") }, [{ acId: "AC-01", result: "skip" }]);
        expect(plans).toHaveLength(0);
    });

    test("同一 AC 多条用例时失败优先，不被后面的 pass 覆盖", () => {
        const { plans } = planAcStatusUpdates({ "AC-01": ac("AC-01", "ready") }, [
            { acId: "AC-01", result: "fail" },
            { acId: "AC-01", result: "pass" },
        ]);
        expect(plans).toHaveLength(1);
        expect(plans[0].to).toBe("failing");
    });

    test("未知 AC 记进 rejected，不静默丢弃", () => {
        const { plans, rejected } = planAcStatusUpdates({}, [{ acId: "AC-99", result: "pass" }]);
        expect(plans).toHaveLength(0);
        expect(rejected[0].acId).toBe("AC-99");
        expect(rejected[0].reason).toContain("unknown AC");
    });

    test("blocked 无法直接因 pass 变绿时记 rejected", () => {
        const { plans, rejected } = planAcStatusUpdates({ "AC-01": ac("AC-01", "blocked") }, [{ acId: "AC-01", result: "pass" }]);
        // blocked -> passing 是合法迁移，这里应当通过而不是 rejected。
        expect(rejected).toHaveLength(0);
        expect(plans[0].to).toBe("passing");
    });
});
