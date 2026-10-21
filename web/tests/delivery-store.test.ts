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
