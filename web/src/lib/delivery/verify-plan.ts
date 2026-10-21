import type { DeliveryRunRound } from "@/types/delivery";

/**
 * M4: 桥端 `/delivery/verify` 的响应 → 运行轮次。
 *
 * 判定原则：一轮运行算不算绿，只看「报告里有没有 AC 结果」和「进程退出码」，
 * 不看命令输出里有没有 "PASS" 字样。假绿比没跑更危险。
 *
 * 三种「说不出结论」的情况分开处理：
 * - 桥端报错 / 报告读不出来 → error（运行本身坏了）
 * - 退出码非 0 → failed（有东西红了，哪怕报告里一条 AC 都没写）
 * - 报告里一条 AC 锚点都没有 → skipped（跑了，但没法判定，交给编排器升级）
 *
 * 纯函数：不读 store、不发请求。
 */

export type VerifyAcResult = { acId: string; result: "pass" | "fail" | "skip" };

export type VerifyPayload = {
    ok: boolean;
    startedAt?: string;
    finishedAt?: string;
    report?: { type: string; path: string; cases: number; withoutAc: number } | null;
    results?: VerifyAcResult[];
    command?: { ok?: boolean; exitCode: number | null; output?: string };
    error?: string;
};

/** 失败消息只留最后一行，够定位是哪条断言，又不会把整段输出塞进 store。 */
export function lastMeaningfulLine(output: string | undefined): string | undefined {
    if (!output) return undefined;
    const lines = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (lines.length === 0) return undefined;
    return lines[lines.length - 1].slice(0, 200);
}

export function failuresFromVerify(payload: VerifyPayload): DeliveryRunRound["failures"] {
    const results = payload.results || [];
    const message = lastMeaningfulLine(payload.command?.output);
    return results
        .filter((item) => item.result === "fail")
        .map((item) => ({ acId: item.acId, ...(message ? { message } : {}) }));
}

export function roundStatusFromVerify(payload: VerifyPayload): DeliveryRunRound["status"] {
    if (payload.error) return "error";
    const results = payload.results || [];
    const exitCode = payload.command?.exitCode;
    if (typeof exitCode === "number" && exitCode !== 0) return "failed";
    if (results.some((item) => item.result === "fail")) return "failed";
    if (results.length === 0) return "skipped";
    if (results.every((item) => item.result === "skip")) return "skipped";
    return "passed";
}

export function roundFromVerify(index: number, payload: VerifyPayload, fallbackStartedAt?: string): DeliveryRunRound {
    const results = payload.results || [];
    const count = (value: VerifyAcResult["result"]) => results.filter((item) => item.result === value).length;
    const finishedAt = payload.finishedAt || new Date().toISOString();
    return {
        index,
        startedAt: payload.startedAt || fallbackStartedAt || finishedAt,
        finishedAt,
        status: roundStatusFromVerify(payload),
        passed: count("pass"),
        failed: count("fail"),
        skipped: count("skip"),
        failures: failuresFromVerify(payload),
    };
}

/** 回填 AC 用：只保留有 AC 锚点的条目，skip 交给 applyAcResults 自己忽略。 */
export function acResultsFromVerify(payload: VerifyPayload): { acId: string; result: "pass" | "fail" | "skip" }[] {
    return (payload.results || []).filter((item) => Boolean(item.acId));
}

/** 给用户看的一句话结论。数量全部来自报告，不估算。 */
export function verifySummary(payload: VerifyPayload): { passed: number; failed: number; skipped: number; cases: number } {
    const results = payload.results || [];
    return {
        passed: results.filter((item) => item.result === "pass").length,
        failed: results.filter((item) => item.result === "fail").length,
        skipped: results.filter((item) => item.result === "skip").length,
        cases: payload.report?.cases ?? 0,
    };
}
