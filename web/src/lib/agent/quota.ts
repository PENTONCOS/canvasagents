/**
 * 用量与配额（M5）。纯函数：只根据「已用」和「额度」算状态，不读 store、不发请求。
 *
 * 为什么单独一个文件：配额判断要在三处复用——侧栏提示、发送前拦截、运行按钮禁用。
 * 如果每处各写一遍 `input + cached + output`，迟早会出现「提示说还有额度、按钮却不动」。
 */

export type AgentQuota = {
    /** token 上限（input + cached + output 合计）。 */
    tokenLimit: number;
    /** 验收运行次数上限。 */
    runLimit: number;
    /** 触发提醒的比例，0..1。 */
    warnRatio: number;
};

export type AgentUsage = {
    input: number;
    cached: number;
    output: number;
};

export type QuotaReason = "tokens" | "runs";
export type QuotaLevel = "ok" | "warning" | "exhausted";

export type QuotaSnapshot = {
    level: QuotaLevel;
    reason: QuotaReason | null;
    tokensUsed: number;
    tokensRemaining: number;
    runsUsed: number;
    runsRemaining: number;
    tokenRatio: number;
    runRatio: number;
};

export const DEFAULT_QUOTA: AgentQuota = {
    tokenLimit: 400_000,
    runLimit: 50,
    warnRatio: 0.8,
};

function nonNegative(value: unknown): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return Math.floor(parsed);
}

export function totalTokens(usage: AgentUsage | null | undefined): number {
    if (!usage) return 0;
    return nonNegative(usage.input) + nonNegative(usage.cached) + nonNegative(usage.output);
}

/**
 * 额度可能来自用户配置，负数/NaN 一律退化成默认值，避免「额度 -1 导致永远耗尽」这种坑。
 */
export function normalizeQuota(input?: Partial<AgentQuota> | null): AgentQuota {
    const tokenLimit = nonNegative(input?.tokenLimit);
    const runLimit = nonNegative(input?.runLimit);
    const warnRatio = typeof input?.warnRatio === "number" && input.warnRatio > 0 && input.warnRatio <= 1
        ? input.warnRatio
        : DEFAULT_QUOTA.warnRatio;
    return {
        tokenLimit: tokenLimit > 0 ? tokenLimit : DEFAULT_QUOTA.tokenLimit,
        runLimit: runLimit > 0 ? runLimit : DEFAULT_QUOTA.runLimit,
        warnRatio,
    };
}

/**
 * 两个维度任一耗尽即 exhausted；任一过警戒线即 warning。
 * 耗尽时给出 reason，UI 才能说清「是 token 还是运行次数」。
 */
export function quotaSnapshot(
    usage: AgentUsage | null | undefined,
    runCount: number,
    quota: Partial<AgentQuota> | null | undefined = DEFAULT_QUOTA,
): QuotaSnapshot {
    const budget = normalizeQuota(quota);
    const tokensUsed = totalTokens(usage);
    const runsUsed = nonNegative(runCount);
    const tokensRemaining = Math.max(0, budget.tokenLimit - tokensUsed);
    const runsRemaining = Math.max(0, budget.runLimit - runsUsed);
    const tokenRatio = Math.min(1, tokensUsed / budget.tokenLimit);
    const runRatio = Math.min(1, runsUsed / budget.runLimit);

    let level: QuotaLevel = "ok";
    let reason: QuotaReason | null = null;
    if (tokensRemaining <= 0) {
        level = "exhausted";
        reason = "tokens";
    } else if (runsRemaining <= 0) {
        level = "exhausted";
        reason = "runs";
    } else if (tokenRatio >= budget.warnRatio || runRatio >= budget.warnRatio) {
        level = "warning";
        reason = tokenRatio >= runRatio ? "tokens" : "runs";
    }

    return { level, reason, tokensUsed, tokensRemaining, runsUsed, runsRemaining, tokenRatio, runRatio };
}

/** 是否允许再发起一轮动作。耗尽即拒绝，不静默继续。 */
export function canSpendQuota(snapshot: QuotaSnapshot, kind: "run" | "message" = "run"): boolean {
    if (snapshot.level !== "exhausted") return true;
    // 运行次数用尽只挡运行；发消息仍然允许（对话不产生验收运行）。
    if (snapshot.reason === "runs") return kind === "message";
    return false;
}

/** 给 UI 用的 i18n key，避免各处自己拼字符串。 */
export function quotaMessageKey(snapshot: QuotaSnapshot): string | null {
    if (snapshot.level === "ok") return null;
    if (snapshot.level === "exhausted") {
        return snapshot.reason === "runs" ? "agent.quota.exhaustedRuns" : "agent.quota.exhaustedTokens";
    }
    return snapshot.reason === "runs" ? "agent.quota.warnRuns" : "agent.quota.warnTokens";
}
