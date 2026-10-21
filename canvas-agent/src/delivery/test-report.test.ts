import assert from "node:assert/strict";
import test from "node:test";

import { extractAcIds, isReportType, parsePlaywrightReport, parseReport, parseVitestReport, summarizeAcResults } from "./test-report.js";

/** 构造 Playwright JSON 里最小可用的 spec（只带解析需要的字段）。 */
function pwSpec(title: string, ok: boolean, extra: Record<string, unknown> = {}) {
    return { title, ok, tests: [{ results: [{ status: ok ? "passed" : "failed" }] }], ...extra };
}

test("extractAcIds 去重且保持出现顺序", () => {
    assert.deepEqual(extractAcIds("改约 @AC-04 与 @AC-02，再来一次 @AC-04"), ["AC-04", "AC-02"]);
    assert.deepEqual(extractAcIds(undefined, "没有锚点"), []);
});

test("parsePlaywrightReport 按标题锚点映射 AC，并保留未锚定用例", () => {
    const report = {
        suites: [
            {
                specs: [pwSpec("改约后立即显示新时间 @AC-04", true), pwSpec("支付失败提示 @AC-02", false)],
                suites: [{ specs: [pwSpec("无关用例", true)] }],
            },
        ],
    };
    const results = parsePlaywrightReport(report);
    const ac04 = results.find((item) => item.acId === "AC-04");
    const ac02 = results.find((item) => item.acId === "AC-02");
    assert.equal(ac04?.result, "pass");
    assert.equal(ac02?.result, "fail");
    // 没写锚点的用例仍然入列（acId 为空），不能被静默丢弃。
    assert.equal(results.filter((item) => !item.acId).length, 1);
});

test("parsePlaywrightReport 支持 tags 里的锚点，一测多 AC 各记一份", () => {
    const report = { suites: [{ specs: [pwSpec("跨旅程回归", true, { tags: ["@AC-01", "@AC-03"] })] }] };
    const results = parsePlaywrightReport(report).filter((item) => item.acId);
    assert.deepEqual(results.map((item) => item.acId).sort(), ["AC-01", "AC-03"]);
});

test("parsePlaywrightReport 失败时带回错误信息", () => {
    const report = {
        suites: [
            {
                specs: [
                    {
                        title: "会失败 @AC-05",
                        ok: false,
                        tests: [{ results: [{ status: "failed", error: { message: "expect(received).toBe(3)" } }] }],
                    },
                ],
            },
        ],
    };
    const ac05 = parsePlaywrightReport(report).find((item) => item.acId === "AC-05");
    assert.equal(ac05?.message, "expect(received).toBe(3)");
});

test("parseVitestReport 读 assertionResults 并映射 AC", () => {
    const report = {
        testResults: [
            {
                assertionResults: [
                    { fullName: "改约流程 > 立即显示 @AC-04", status: "passed", ancestorTitles: ["改约流程"] },
                    { fullName: "改约流程 > 失败场景", status: "failed", failureMessages: ["boom"] },
                ],
            },
        ],
    };
    const results = parseVitestReport(report);
    assert.equal(results.find((item) => item.acId === "AC-04")?.result, "pass");
    const failed = results.find((item) => !item.acId);
    assert.equal(failed?.result, "fail");
    assert.equal(failed?.message, "boom");
});

test("summarizeAcResults 任一失败即失败，全跳过才是跳过", () => {
    const summary = summarizeAcResults([
        { acId: "AC-01", title: "a", result: "pass" },
        { acId: "AC-01", title: "b", result: "fail" },
        { acId: "AC-02", title: "c", result: "pass" },
        { acId: "AC-03", title: "d", result: "skip" },
        { title: "无锚点", result: "fail" },
    ]);
    const byId = Object.fromEntries(summary.map((item) => [item.acId, item.result]));
    assert.equal(byId["AC-01"], "fail");
    assert.equal(byId["AC-02"], "pass");
    assert.equal(byId["AC-03"], "skip");
    assert.equal(Object.keys(byId).length, 3);
});

test("parseReport 按类型分发，未知类型不被当成任一格式", () => {
    const vitest = { testResults: [{ name: "x.test.ts", assertionResults: [{ title: "@AC-09 深度", status: "passed" }] }] };
    const viaVitest = parseReport("vitest", vitest);
    const viaPlaywright = parseReport("playwright", vitest);
    assert.equal(viaVitest.length, 1);
    assert.equal(viaVitest[0].acId, "AC-09");
    // 同一份报告按 Playwright 解析应拿不到条目，证明分发真的生效了，而不是碰巧都能读。
    assert.equal(viaPlaywright.length, 0);
    assert.equal(isReportType("vitest"), true);
    assert.equal(isReportType("jest"), false);
});
