import { createHash } from "node:crypto";

import { parseReport, type ParsedTestResult, type ReportType } from "./test-report.js";

/**
 * E2: 一轮测试跑完 → 结构化报告摘要 → agent 事件流。
 *
 * 判定原则（和 test-report.ts 一致，不在这里另立一套）：
 * - AC 结果只认 `@AC-xx` 锚点；没有锚点的用例记 skip，**不算通过**。
 * - 报告读不出来 / JSON 解析失败 → parse-error，给出可读错误，绝不当「0 条失败 = 全绿」。
 * - 没有报告文件 → skipped（跑了但没东西可判），也不是通过。
 *
 * 幂等：reportId 由 reportFingerprint() 算出——把 `reportType\0reportPath\0startedAt\0text`
 * 用 NUL 分隔拼接后取 sha256 的前 16 位十六进制字符（顺序固定，字段不会互相串味）。
 * startedAt 是该轮开始时间，默认空串：不传时「同类型 + 同路径 + 同原文」就是同一个 id；
 * 桥端调用时传入本轮 startedAt，所以下一轮即使报告内容完全相同也不会被旧 id 去重掉
 * （修复循环必须能记新一轮）。同一轮的 HTTP 响应与事件流用同一组入参，得到同一个 id。
 * summarizeVerifyReport 本身不 hash：reportId 由调用方给，空串表示不可去重
 * （没有报告原文 / 没有报告路径时，调用方拿不到稳定指纹）。
 */

export type VerifyCaseStatus = "pass" | "fail" | "skip";

export type VerifyReportCase = {
    acId: string | null;
    title: string;
    /** 判定状态：无锚点一律 skip（不参与通过计数）。 */
    status: VerifyCaseStatus;
    /** 报告里的原始状态，便于面板解释「为什么这条被 skip」。 */
    raw: VerifyCaseStatus;
    file: string;
};

export type VerifyReportStatus = "parsed" | "skipped" | "parse-error";

export type VerifyReportSummary = {
    /** 同一份报告的稳定指纹；空串表示不可去重（无报告 / 读不出原文）。 */
    reportId: string;
    reportType: ReportType;
    reportPath: string;
    status: VerifyReportStatus;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    /** 报告里没有 @AC 锚点的用例数；它们计入 skipped，不计入 passed。 */
    unanchored: number;
    cases: VerifyReportCase[];
    error?: string;
};

/** 事件流里的完整一轮：摘要 + 轮次归属 + 命令结果。 */
export type VerifyRunEvent = VerifyReportSummary & {
    type: "delivery_verify";
    runId: string;
    roundIndex: number;
    startedAt: string;
    finishedAt: string;
    exitCode: number | null;
    /** 命令输出的最后一行（截断）：前端拿它做失败签名，才能分辨「这一轮到底改了没」。 */
    outputTail?: string;
};

/** 只取最后一行非空输出，够定位是哪条断言，又不会把整段日志塞进事件流。 */
export function outputTail(output: string | undefined): string | undefined {
    if (!output) return undefined;
    const lines = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (lines.length === 0) return undefined;
    return lines[lines.length - 1].slice(0, 200);
}

export const VERIFY_EVENT_TYPE = "delivery_verify";

export function reportFingerprint(reportType: string, reportPath: string, text: string, startedAt = ""): string {
    // startedAt 进指纹：同一轮（HTTP 响应 + 事件流）得到同一个 id；下一轮就算报告内容一样也算新一轮。
    return createHash("sha256").update(`${reportType}\u0000${reportPath}\u0000${startedAt}\u0000${text}`).digest("hex").slice(0, 16);
}

/**
 * 把解析结果收敛成面板与事件流共用的摘要。
 *
 * `parsed` 不传且没有 error：调用方没有报告（没填路径），按 skipped 处理。
 */
export function summarizeVerifyReport(input: {
    reportType: ReportType;
    reportPath: string;
    reportId?: string;
    parsed?: ParsedTestResult[];
    error?: string;
}): VerifyReportSummary {
    const base = {
        reportId: input.reportId || "",
        reportType: input.reportType,
        reportPath: input.reportPath,
        cases: [] as VerifyReportCase[],
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        unanchored: 0,
    };

    if (input.error) {
        return { ...base, status: "parse-error", error: input.error };
    }
    if (!input.parsed) {
        return { ...base, status: "skipped" };
    }

    const cases: VerifyReportCase[] = input.parsed.map((item) => {
        const raw = item.result;
        // 无锚点 = 判不了：即便用例本身跑过，也不能算通过。
        const status: VerifyCaseStatus = item.acId ? raw : "skip";
        return { acId: item.acId ?? null, title: item.title, status, raw, file: item.file || "" };
    });
    const passed = cases.filter((item) => item.status === "pass").length;
    const failed = cases.filter((item) => item.status === "fail").length;
    return {
        ...base,
        status: "parsed",
        cases,
        total: cases.length,
        passed,
        failed,
        skipped: cases.length - passed - failed,
        unanchored: cases.filter((item) => !item.acId).length,
    };
}

/** 事件/响应共用的入口：原始报告 JSON → 摘要（解析异常也收敛成 parse-error，不抛）。 */
export function summarizeVerifyRaw(input: {
    reportType: ReportType;
    reportPath: string;
    reportId: string;
    raw: unknown;
}): VerifyReportSummary {
    try {
        const parsed = parseReport(input.reportType, input.raw);
        return summarizeVerifyReport({ ...input, parsed });
    } catch (error) {
        return summarizeVerifyReport({
            reportType: input.reportType,
            reportPath: input.reportPath,
            reportId: input.reportId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
