import { describe, expect, test } from "bun:test";

import {
    DEFAULT_QUOTA,
    canSpendQuota,
    normalizeQuota,
    quotaMessageKey,
    quotaSnapshot,
    totalTokens,
} from "@/lib/agent/quota";

describe("totalTokens", () => {
    test("三项相加，null 当 0", () => {
        expect(totalTokens(null)).toBe(0);
        expect(totalTokens({ input: 100, cached: 20, output: 5 })).toBe(125);
    });

    test("非法值不会把总量算成负数或 NaN", () => {
        expect(totalTokens({ input: -50, cached: Number.NaN, output: "30" as unknown as number })).toBe(30);
    });
});

describe("normalizeQuota", () => {
    test("缺省值补齐", () => {
        expect(normalizeQuota(null)).toEqual(DEFAULT_QUOTA);
        expect(normalizeQuota({ tokenLimit: 0, runLimit: -3 })).toEqual(DEFAULT_QUOTA);
    });

    test("只覆盖有效字段，warnRatio 超范围退回默认", () => {
        const quota = normalizeQuota({ tokenLimit: 1000, warnRatio: 7 });
        expect(quota.tokenLimit).toBe(1000);
        expect(quota.runLimit).toBe(DEFAULT_QUOTA.runLimit);
        expect(quota.warnRatio).toBe(DEFAULT_QUOTA.warnRatio);
    });
});

describe("quotaSnapshot", () => {
    const quota = { tokenLimit: 1000, runLimit: 10, warnRatio: 0.8 };

    test("低用量是 ok，且没有提示文案", () => {
        const snapshot = quotaSnapshot({ input: 100, cached: 0, output: 50 }, 1, quota);
        expect(snapshot.level).toBe("ok");
        expect(snapshot.reason).toBeNull();
        expect(quotaMessageKey(snapshot)).toBeNull();
        expect(snapshot.tokensRemaining).toBe(850);
    });

    test("过 80% 是 warning，并指出卡在哪个维度", () => {
        const tokens = quotaSnapshot({ input: 800, cached: 0, output: 0 }, 0, quota);
        expect(tokens.level).toBe("warning");
        expect(tokens.reason).toBe("tokens");
        expect(quotaMessageKey(tokens)).toBe("agent.quota.warnTokens");

        const runs = quotaSnapshot({ input: 0, cached: 0, output: 0 }, 8, quota);
        expect(runs.level).toBe("warning");
        expect(runs.reason).toBe("runs");
        expect(quotaMessageKey(runs)).toBe("agent.quota.warnRuns");
    });

    test("正好用满即 exhausted，剩余归零而不是负数", () => {
        const snapshot = quotaSnapshot({ input: 1000, cached: 0, output: 0 }, 0, quota);
        expect(snapshot.level).toBe("exhausted");
        expect(snapshot.tokensRemaining).toBe(0);
        expect(snapshot.tokenRatio).toBe(1);
        expect(quotaMessageKey(snapshot)).toBe("agent.quota.exhaustedTokens");
    });

    test("超额也按耗尽处理，比例封顶 1", () => {
        const snapshot = quotaSnapshot({ input: 5000, cached: 0, output: 0 }, 99, quota);
        expect(snapshot.level).toBe("exhausted");
        expect(snapshot.tokenRatio).toBe(1);
        expect(snapshot.runRatio).toBe(1);
    });

    test("token 与运行次数同时耗尽时优先报 token", () => {
        const snapshot = quotaSnapshot({ input: 9999, cached: 0, output: 0 }, 99, quota);
        expect(snapshot.reason).toBe("tokens");
    });
});

describe("canSpendQuota", () => {
    const quota = { tokenLimit: 100, runLimit: 2, warnRatio: 0.8 };

    test("未耗尽时都允许", () => {
        const snapshot = quotaSnapshot({ input: 0, cached: 0, output: 0 }, 0, quota);
        expect(canSpendQuota(snapshot, "run")).toBe(true);
        expect(canSpendQuota(snapshot, "message")).toBe(true);
    });

    test("运行次数耗尽只挡运行，不挡对话", () => {
        const snapshot = quotaSnapshot({ input: 0, cached: 0, output: 0 }, 2, quota);
        expect(snapshot.reason).toBe("runs");
        expect(canSpendQuota(snapshot, "run")).toBe(false);
        expect(canSpendQuota(snapshot, "message")).toBe(true);
    });

    test("token 耗尽连对话一起挡", () => {
        const snapshot = quotaSnapshot({ input: 100, cached: 0, output: 0 }, 0, quota);
        expect(canSpendQuota(snapshot, "run")).toBe(false);
        expect(canSpendQuota(snapshot, "message")).toBe(false);
    });
});
