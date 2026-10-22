import type { AcResultInput } from "@/lib/delivery/run-results";
import { lastMeaningfulLine, type VerifyPayload } from "@/lib/delivery/verify-plan";
import type { DeliveryRunRound } from "@/types/delivery";

/**
 * E2/E3: 桥端 `delivery_verify` 事件（或 `/delivery/verify` 响应）→ 面板数据。
 *
 * 数字全部来自桥端解析后的摘要（summary），前端不做二次推断：
 * - 无锚点用例在桥端已记 skip，这里不再把它算成通过。
 * - parse-error 明确落到 error 轮次，不因为「0 条失败」变绿。
 *
 * 幂等键是 reportId（报告内容哈希）：同一份报告重复到达只累计一轮。
 * 纯函数：不读 store、不发请求。
 */

export type VerifyCaseStatus = "pass" | "fail" | "skip";

export type VerifyReportCase = {
    acId: string | null;
    title: string;
    status: VerifyCaseStatus;
    raw?: VerifyCaseStatus;
    file?: string;
};

export type VerifyReportStatus = "parsed" | "skipped" | "parse-error";

export type VerifyReportSummary = {
    reportId: string;
    reportType: string;
    reportPath: string;
    status: VerifyReportStatus;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    unanchored?: number;
    cases: VerifyReportCase[];
    error?: string;
};

/** 事件额外带的轮次信息；纯摘要（响应里的 summary）没有这些字段。 */
export type VerifyReportTiming = { startedAt?: string; finishedAt?: string; exitCode?: number | null; output?: string };

export type VerifyReportEvent = VerifyReportSummary & VerifyReportTiming & {
    type?: "delivery_verify";
    runId?: string;
    roundIndex?: number;
    /** 桥端事件带的命令输出最后一行（响应路径用 command.output）。 */
    outputTail?: string;
};

function count(results: VerifyReportCase[], status: VerifyCaseStatus): number {
    return results.filter((item) => item.status === status).length;
}

/** 老桥端（只有 results、没有 summary）的兼容路径：仍然不给假绿。 */
export function summaryFromVerifyPayload(payload: VerifyPayload): VerifyReportSummary {
    if (payload.summary) return payload.summary;
    const results = payload.results || [];
    if (payload.error) {
        return { reportId: "", reportType: payload.report?.type || "", reportPath: payload.report?.path || "", status: "parse-error", total: 0, passed: 0, failed: 0, skipped: 0, cases: [], error: payload.error };
    }
    const cases: VerifyReportCase[] = results.map((item) => ({
        acId: item.acId || null,
        title: item.acId || "",
        status: item.acId ? item.result : "skip",
        raw: item.result,
        file: "",
    }));
    return {
        reportId: "",
        reportType: payload.report?.type || "",
        reportPath: payload.report?.path || "",
        status: results.length ? "parsed" : "skipped",
        total: cases.length,
        passed: count(cases, "pass"),
        failed: count(cases, "fail"),
        skipped: count(cases, "skip"),
        unanchored: cases.filter((item) => !item.acId).length,
        cases,
    };
}

/**
 * 一轮的判定：解析失败 / 退出码非 0 / 有 AC 失败 → failed；一条可判定的通过都没有 → skipped。
 * 注意 skipped 不是通过（编排器会升级让人补锚点）。
 */
export function roundStatusFromReport(summary: VerifyReportSummary, exitCode?: number | null): DeliveryRunRound["status"] {
    if (summary.status === "parse-error") return "error";
    if (typeof exitCode === "number" && exitCode !== 0) return "failed";
    if (summary.failed > 0) return "failed";
    if (summary.status === "skipped") return "skipped";
    if (summary.total === 0 || summary.passed === 0) return "skipped";
    return "passed";
}

/** 失败条目只留 AC 与可读消息。
 *  一个 AC 可能对应多条失败用例，这里收敛到 AC 粒度：和旧的 `failuresFromVerify` 一致，
 *  否则同一 AC 会在轮次详情里重复出现好几行。
 *
 *  消息优先用命令输出的最后一行——报告里的用例标题名每轮都一样，拿它做失败签名会让
 *  「连续 3 轮签名一致」的护栏误判成原地打转（真实的两轮修复往往只差在报错信息上）。
 */
function failuresFromReport(summary: VerifyReportSummary, message?: string): DeliveryRunRound["failures"] {
    const seen = new Set<string>();
    const failures: DeliveryRunRound["failures"] = [];
    for (const item of summary.cases) {
        if (item.status !== "fail" || !item.acId) continue;
        if (seen.has(item.acId)) continue;
        seen.add(item.acId);
        const text = message || item.title;
        failures.push({ acId: item.acId, ...(text ? { message: text } : {}) });
    }
    return failures;
}

export function roundFromVerifyReport(
    summary: VerifyReportSummary & VerifyReportTiming,
    index: number,
    fallbackStartedAt?: string,
): DeliveryRunRound {
    const finishedAt = summary.finishedAt || new Date().toISOString();
    return {
        index,
        startedAt: summary.startedAt || fallbackStartedAt || finishedAt,
        finishedAt,
        status: roundStatusFromReport(summary, summary.exitCode),
        passed: summary.passed,
        failed: summary.failed,
        skipped: summary.skipped,
        total: summary.total,
        unanchored: summary.unanchored ?? 0,
        reportId: summary.reportId || "",
        reportPath: summary.reportPath || "",
        failures: failuresFromReport(summary, lastMeaningfulLine(summary.output)),
    };
}

/** 回填 AC：只保留有锚点的条目；skip 交给 applyAcResults 自己忽略。 */
export function acResultsFromVerifyReport(summary: VerifyReportSummary): AcResultInput[] {
    const merged = new Map<string, VerifyCaseStatus>();
    for (const item of summary.cases) {
        if (!item.acId) continue;
        const previous = merged.get(item.acId);
        if (previous === "fail" || item.status === "fail") merged.set(item.acId, "fail");
        else if (previous === "pass" || item.status === "pass") merged.set(item.acId, "pass");
        else merged.set(item.acId, "skip");
    }
    return [...merged.entries()].map(([acId, result]) => ({ acId, result }));
}

/** 幂等：同一份报告（相同 reportId）已经在某一轮里出现过就不再累计。 */
export function isDuplicateReport(rounds: DeliveryRunRound[] | undefined, reportId: string): boolean {
    if (!reportId) return false;
    return (rounds || []).some((round) => round.reportId === reportId);
}

/** E3 一行摘要用的数据；组件只负责排版与 i18n。 */
export type VerifySummaryParts = {
    status: DeliveryRunRound["status"];
    passed: number;
    failed: number;
    skipped: number;
    unanchored: number;
    failingAcIds: string[];
};

export function verifySummaryParts(round: DeliveryRunRound): VerifySummaryParts {
    const failingAcIds: string[] = [];
    for (const failure of round.failures) {
        if (failure.acId && !failingAcIds.includes(failure.acId)) failingAcIds.push(failure.acId);
    }
    return {
        status: round.status,
        passed: round.passed,
        failed: round.failed,
        skipped: round.skipped,
        unanchored: round.unanchored ?? 0,
        failingAcIds,
    };
}
