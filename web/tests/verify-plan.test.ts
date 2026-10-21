import { describe, expect, test } from "bun:test";

import { acResultsFromVerify, failuresFromVerify, lastMeaningfulLine, roundFromVerify, roundStatusFromVerify, verifySummary } from "@/lib/delivery/verify-plan";

describe("verify-plan 判定一轮运行的状态", () => {
    test("全通过且退出码 0 → passed", () => {
        const round = roundFromVerify(1, { ok: true, results: [{ acId: "AC-01", result: "pass" }, { acId: "AC-02", result: "pass" }], command: { exitCode: 0 } });
        expect(round.status).toBe("passed");
        expect(round.passed).toBe(2);
        expect(round.failed).toBe(0);
    });

    test("有失败 → failed，且失败条目带上输出最后一行", () => {
        const round = roundFromVerify(1, {
            ok: false,
            results: [{ acId: "AC-01", result: "pass" }, { acId: "AC-02", result: "fail" }],
            command: { exitCode: 1, output: "noise line\nexpected 3 to be 4\n" },
        });
        expect(round.status).toBe("failed");
        expect(round.failures).toEqual([{ acId: "AC-02", message: "expected 3 to be 4" }]);
    });

    test("退出码非 0 但报告一条 AC 都没有 → 仍然 failed，不因为「没有失败条目」变绿", () => {
        expect(roundStatusFromVerify({ ok: false, results: [], command: { exitCode: 2 } })).toBe("failed");
    });

    test("退出码 0 但报告里没有 AC 锚点 → skipped，交给编排器升级而不是当通过", () => {
        expect(roundStatusFromVerify({ ok: true, results: [], command: { exitCode: 0 } })).toBe("skipped");
    });

    test("用例全被 skip → skipped", () => {
        expect(roundStatusFromVerify({ ok: true, results: [{ acId: "AC-01", result: "skip" }], command: { exitCode: 0 } })).toBe("skipped");
    });

    test("桥端报错 → error，优先于其它判定", () => {
        const round = roundFromVerify(2, { ok: false, error: "报告读取失败", results: [], command: { exitCode: 0 } });
        expect(round.status).toBe("error");
        expect(round.index).toBe(2);
    });

    test("时间戳缺失时用回退值，不会写成 undefined", () => {
        const round = roundFromVerify(3, { ok: true, results: [] }, "2026-10-21T00:00:00.000Z");
        expect(round.startedAt).toBe("2026-10-21T00:00:00.000Z");
        expect(typeof round.finishedAt).toBe("string");
    });

    test("回填 AC 时丢弃没有 acId 的条目", () => {
        expect(acResultsFromVerify({ ok: true, results: [{ acId: "AC-01", result: "fail" }] })).toEqual([{ acId: "AC-01", result: "fail" }]);
    });

    test("lastMeaningfulLine 跳过空行并截断超长输出", () => {
        expect(lastMeaningfulLine("a\n\n   \nb\n")).toBe("b");
        expect(lastMeaningfulLine(undefined)).toBeUndefined();
        expect(lastMeaningfulLine("x".repeat(400))?.length).toBe(200);
    });

    test("failuresFromVerify 不把 pass 混进失败列表", () => {
        expect(failuresFromVerify({ ok: false, results: [{ acId: "AC-01", result: "pass" }], command: { exitCode: 1, output: "boom" } })).toEqual([]);
    });

    test("verifySummary 的数量全部来自报告", () => {
        const summary = verifySummary({ ok: true, report: { type: "vitest", path: "/tmp/r.json", cases: 7, withoutAc: 2 }, results: [{ acId: "AC-01", result: "pass" }, { acId: "AC-02", result: "fail" }, { acId: "AC-03", result: "skip" }] });
        expect(summary).toEqual({ passed: 1, failed: 1, skipped: 1, cases: 7 });
    });
});
