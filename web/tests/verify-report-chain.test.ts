import { beforeEach, describe, expect, test } from "bun:test";

import type { VerifyPayload } from "@/lib/delivery/verify-plan";
import {
    acResultsFromVerifyReport,
    roundFromVerifyReport,
    roundStatusFromReport,
    summaryFromVerifyPayload,
    verifySummaryParts,
    type VerifyReportSummary,
} from "@/lib/delivery/verify-report";
import { useDeliveryStore } from "@/stores/use-delivery-store";
import type { AcceptanceCriterion } from "@/types/delivery";

/**
 * E2/E3 链路：桥端响应 → 摘要 → 一轮运行 + AC 回填（真实 store action）。
 *
 * 四类必须分开验证，且都不能靠「0 条失败」推断通过：
 * 有锚点回填 / 无锚点记 skip / 同一 reportId 幂等 / parse-error 不烧绿。
 */

function makeAc(id: string, overrides: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
    return { id, statement: `stmt ${id}`, journeyIds: [], stepIds: [], testCaseIds: [], status: "draft", ...overrides };
}

function makeSummary(overrides: Partial<VerifyReportSummary> = {}): VerifyReportSummary {
    return {
        reportId: "fp-default",
        reportType: "playwright",
        reportPath: "/tmp/report.json",
        status: "parsed",
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        unanchored: 0,
        cases: [],
        ...overrides,
    };
}

/** 模拟桥端 `POST /delivery/verify` 的响应体（新桥端带 summary）。 */
function bridgePayload(summary: VerifyReportSummary, exitCode: number | null = 0): VerifyPayload {
    return {
        ok: exitCode === 0 && summary.status === "parsed",
        startedAt: "2026-10-22T12:00:00.000Z",
        finishedAt: "2026-10-22T12:00:03.000Z",
        report: summary.reportPath ? { type: summary.reportType, path: summary.reportPath, cases: summary.total, withoutAc: summary.unanchored } : null,
        results: summary.cases.filter((item) => item.acId).map((item) => ({ acId: item.acId as string, result: item.status })),
        command: { ok: exitCode === 0, exitCode, output: "" },
        summary,
        runId: "RUN-1",
        roundIndex: 1,
    };
}

/** 走真实链路：响应 → 摘要 → 轮次 → store.applyVerifyReport。 */
function applyPayload(payload: VerifyPayload, index = payload.roundIndex || 1) {
    const summary = summaryFromVerifyPayload(payload);
    const round = roundFromVerifyReport(
        { ...summary, startedAt: payload.startedAt, finishedAt: payload.finishedAt, exitCode: payload.command?.exitCode ?? null },
        index,
    );
    return useDeliveryStore.getState().applyVerifyReport({ runId: "RUN-1", round, acResults: acResultsFromVerifyReport(summary) });
}

function seedRun() {
    useDeliveryStore.getState().upsertRun({
        id: "RUN-1",
        kind: "test",
        command: "bun test",
        cwd: "/repo",
        startedAt: "2026-10-22T11:59:00.000Z",
        status: "running",
        results: [],
        rounds: [],
    });
}

beforeEach(() => {
    useDeliveryStore.getState().resetDelivery();
    seedRun();
});

describe("E2: 有锚点回填", () => {
    test("通过的 AC 变 passing、失败的变 failing，轮次数字来自摘要", () => {
        const store = useDeliveryStore.getState();
        store.upsertAc(makeAc("AC-04"));
        store.upsertAc(makeAc("AC-07"));

        const summary = makeSummary({
            reportId: "fp-round1",
            total: 2,
            passed: 1,
            failed: 1,
            skipped: 0,
            cases: [
                { acId: "AC-04", title: "改约成功", status: "pass", raw: "pass", file: "e2e/acceptance.spec.ts" },
                { acId: "AC-07", title: "支付失败", status: "fail", raw: "fail", file: "e2e/acceptance.spec.ts" },
            ],
        });

        const result = applyPayload(bridgePayload(summary, 1));
        expect(result.applied).toBe(true);

        const state = useDeliveryStore.getState();
        expect(state.acceptance["AC-04"].status).toBe("passing");
        expect(state.acceptance["AC-07"].status).toBe("failing");
        expect(state.acceptance["AC-07"].lastRunId).toBe("RUN-1");

        const run = state.runs["RUN-1"];
        expect(run.rounds).toHaveLength(1);
        expect(run.rounds?.[0]).toMatchObject({ index: 1, status: "failed", passed: 1, failed: 1, total: 2, reportId: "fp-round1" });
        expect(run.status).toBe("failed");

        // 面板一行摘要的数据：失败的 AC 可点回节点，通过的不会被列进去。
        expect(verifySummaryParts(run.rounds![0])).toMatchObject({ status: "failed", passed: 1, failed: 1, failingAcIds: ["AC-07"] });
    });
});

describe("E2: 无锚点不算通过", () => {
    test("无 @AC 锚点的用例记 skip，AC 回填不把 draft 推成 passing", () => {
        useDeliveryStore.getState().upsertAc(makeAc("AC-01"));

        const summary = makeSummary({
            reportId: "fp-unanchored",
            total: 2,
            passed: 0,
            failed: 0,
            skipped: 2,
            unanchored: 2,
            cases: [
                { acId: null, title: "改了标题但没写锚点", status: "skip", raw: "pass", file: "tests/foo.test.ts" },
                { acId: null, title: "另一条也没锚点", status: "skip", raw: "pass", file: "tests/bar.test.ts" },
            ],
        });

        // 摘要层面：skip 不计入 passed，报告里的原始 pass 只留在 raw 里。
        expect(summary.passed).toBe(0);
        expect(summary.skipped).toBe(2);
        expect(roundStatusFromReport(summary, 0)).toBe("skipped");

        const result = applyPayload(bridgePayload(summary, 0));
        expect(result.applied).toBe(true);

        const state = useDeliveryStore.getState();
        // 没有可回填的锚点：AC 保持 draft，不能被「跑过了」顺手点亮。
        expect(state.acceptance["AC-01"].status).toBe("draft");
        expect(state.acceptance["AC-01"].lastRunId).toBeUndefined();

        const round = state.runs["RUN-1"].rounds![0];
        expect(round.status).toBe("skipped");
        expect(round.passed).toBe(0);
        expect(round.skipped).toBe(2);
        expect(round.unanchored).toBe(2);
        expect(round.failures).toEqual([]);
        expect(state.runs["RUN-1"].status).not.toBe("passed");
    });
});

describe("E2: 同一 reportId 幂等", () => {
    test("HTTP 响应与事件流重复到达同一份报告，只累计一轮、AC 只回填一次", () => {
        useDeliveryStore.getState().upsertAc(makeAc("AC-01"));

        const summary = makeSummary({
            reportId: "fp-same",
            total: 1,
            passed: 1,
            failed: 0,
            cases: [{ acId: "AC-01", title: "带锚点 @AC-01", status: "pass", raw: "pass" }],
        });
        const payload = bridgePayload(summary, 0);

        const first = applyPayload(payload);
        const second = applyPayload(payload);

        expect(first).toEqual({ applied: true });
        expect(second).toEqual({ applied: false, reason: "duplicate" });

        const state = useDeliveryStore.getState();
        expect(state.runs["RUN-1"].rounds).toHaveLength(1);
        expect(state.runs["RUN-1"].rounds?.[0].reportId).toBe("fp-same");
        expect(state.acceptance["AC-01"].status).toBe("passing");

        // 换一份报告（新 reportId）仍要能记新一轮：去重只认内容指纹，不是「一轮封顶」。
        const next = applyPayload(bridgePayload(makeSummary({ reportId: "fp-next", total: 1, cases: [{ acId: "AC-01", title: "再跑一次", status: "fail", raw: "fail" }] }), 1), 2);
        expect(next.applied).toBe(true);
        const after = useDeliveryStore.getState();
        expect(after.runs["RUN-1"].rounds).toHaveLength(2);
        expect(after.runs["RUN-1"].rounds?.[1].index).toBe(2);
        expect(after.acceptance["AC-01"].status).toBe("failing");
    });
});

describe("E2: parse-error 不烧绿", () => {
    test("报告解析失败落成 error 轮次，不抛异常、不给 AC 假通过", () => {
        useDeliveryStore.getState().upsertAc(makeAc("AC-01"));

        const broken = makeSummary({
            reportId: "fp-broken",
            status: "parse-error",
            error: "报告解析失败：Unexpected token } in JSON at position 1",
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            cases: [],
        });
        const payload = bridgePayload(broken, 1);

        let result: ReturnType<typeof applyPayload> | undefined;
        expect(() => {
            result = applyPayload(payload);
        }).not.toThrow();
        expect(result?.applied).toBe(true);

        const state = useDeliveryStore.getState();
        const round = state.runs["RUN-1"].rounds![0];
        expect(round.status).toBe("error");
        expect(round.passed).toBe(0);
        expect(round.failed).toBe(0);
        expect(state.runs["RUN-1"].status).toBe("error");
        expect(state.acceptance["AC-01"].status).toBe("draft");

        // 面板读的是保存下来的轮次：error 不是绿，也不列失败 AC（避免编造 AC 结果）。
        const parts = verifySummaryParts(round);
        expect(parts.status).toBe("error");
        expect(parts.passed).toBe(0);
        expect(parts.failingAcIds).toEqual([]);
    });
});
