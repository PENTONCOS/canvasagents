import assert from "node:assert/strict";
import test from "node:test";

import { reportFingerprint, summarizeVerifyRaw, summarizeVerifyReport } from "./verify-report.js";

/** E2: 解析 → 事件摘要。四类必须分开：有锚点 / 无锚点 / 重复到达 / 解析失败。 */

test("有锚点：通过和失败都按 AC 记，计数来自报告本身", () => {
    const summary = summarizeVerifyRaw({
        reportType: "playwright",
        reportPath: "/tmp/report.json",
        reportId: "abc",
        raw: {
            suites: [
                {
                    file: "e2e/acceptance.spec.ts",
                    specs: [
                        { title: "改约成功 @AC-04", ok: true, tests: [{ results: [{ status: "passed" }] }] },
                        { title: "支付失败 @AC-07", ok: false, tests: [{ results: [{ status: "failed", error: { message: "boom" } }] }] },
                    ],
                },
            ],
        },
    });
    assert.equal(summary.status, "parsed");
    assert.equal(summary.total, 2);
    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.skipped, 0);
    assert.deepEqual(summary.cases.map((item) => [item.acId, item.status, item.file]), [
        ["AC-04", "pass", "e2e/acceptance.spec.ts"],
        ["AC-07", "fail", "e2e/acceptance.spec.ts"],
    ]);
});

test("无锚点：即使用例本身通过，也记 skip，不算通过", () => {
    const summary = summarizeVerifyReport({
        reportType: "vitest",
        reportPath: "/tmp/vitest.json",
        reportId: "def",
        parsed: [
            { title: "改了标题但没写锚点", result: "pass" },
            // 锚点由 parseReport 提取后放在 acId 上；summarize 只决定「有锚点才计入判定」。
            { acId: "AC-02", title: "带锚点 @AC-02", result: "pass" },
        ],
    });
    assert.equal(summary.total, 2);
    assert.equal(summary.passed, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.unanchored, 1);
    const unanchored = summary.cases.find((item) => item.acId === null);
    assert.equal(unanchored?.status, "skip");
    // 原始状态留着，面板能解释「它不是没跑，是判不了」。
    assert.equal(unanchored?.raw, "pass");
});

test("重复到达：同一份报告内容得到同一个 reportId，前端据此去重", () => {
    const text = JSON.stringify({ suites: [{ specs: [{ title: "x @AC-01", ok: true }] }] });
    assert.equal(reportFingerprint("playwright", "/tmp/a.json", text), reportFingerprint("playwright", "/tmp/a.json", text));
    // 内容变了就是另一份报告：不能拿旧轮次抵消新结果。
    assert.notEqual(reportFingerprint("playwright", "/tmp/a.json", text), reportFingerprint("playwright", "/tmp/a.json", `${text} `));
    // 没有报告原文时不给指纹，也就不会误去重。
    const summary = summarizeVerifyReport({ reportType: "playwright", reportPath: "" });
    assert.equal(summary.reportId, "");
    assert.equal(summary.status, "skipped");
});

test("解析失败：给出 parse-error 和可读错误，不返回 0 失败", () => {
    const summary = summarizeVerifyReport({
        reportType: "vitest",
        reportPath: "/tmp/broken.json",
        reportId: "ghi",
        error: "Unexpected token } in JSON",
    });
    assert.equal(summary.status, "parse-error");
    assert.equal(summary.error, "Unexpected token } in JSON");
    assert.equal(summary.total, 0);
    assert.equal(summary.passed, 0);
    assert.equal(summary.failed, 0);
    assert.deepEqual(summary.cases, []);
});

test("解析抛异常也收敛成 parse-error，不把异常抛给路由", () => {
    const summary = summarizeVerifyRaw({
        reportType: "playwright",
        reportPath: "/tmp/report.json",
        reportId: "jkl",
        raw: {
            get suites() {
                throw new Error("报告结构坏了");
            },
        },
    });
    assert.equal(summary.status, "parse-error");
    assert.equal(summary.error, "报告结构坏了");
});

test("同一 AC 多条用例：失败优先由 summarizeAcResults 负责，摘要仍按用例计数", () => {
    const summary = summarizeVerifyReport({
        reportType: "playwright",
        reportPath: "/tmp/report.json",
        reportId: "mno",
        parsed: [
            { acId: "AC-01", title: "a", result: "pass" },
            { acId: "AC-01", title: "b", result: "fail" },
        ],
    });
    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.total, 2);
});

test("vitest 报告能从 testResults[].name 带回文件路径", () => {
    const summary = summarizeVerifyRaw({
        reportType: "vitest",
        reportPath: "/tmp/vitest.json",
        reportId: "pqr",
        raw: {
            testResults: [
                {
                    name: "tests/pay.test.ts",
                    assertionResults: [{ fullName: "支付 @AC-07", status: "passed" }],
                },
            ],
        },
    });
    assert.equal(summary.cases[0]?.file, "tests/pay.test.ts");
});
