import { expect, test, type Page } from "@playwright/test";

/**
 * M4 E2E：验收循环（失败 → 修完再跑 → 变绿）与护栏（跑满 5 轮升级停止）。
 *
 * 判定原则：不是「点了按钮没报错」，而是「同一运行里轮次真的累加、AC 真的从红变绿、
 * 到上限真的停」。桥端跑命令与解析报告由单元测试覆盖，这里打的是 mock agent 的
 * /delivery/verify 桩，只验证前端编排行为。
 */

const AGENT_URL = "http://127.0.0.1:17399";
const AGENT_TOKEN = "e2e-token";

async function openCanvas(page: Page) {
    await page.addInitScript(([url, token]) => {
        localStorage.setItem("canvas-agent-url", url);
        localStorage.setItem("canvas-agent-token", token);
    }, [AGENT_URL, AGENT_TOKEN]);
    await page.goto("/canvas?mode=new");
    await page.waitForURL(/\/canvas\//, { timeout: 30_000 });
    await expect(page.locator("main").first()).toBeVisible({ timeout: 30_000 });
}

async function createAcceptanceNode(page: Page) {
    await page.locator("main").first().dblclick({ position: { x: 400, y: 300 } });
    await expect(page.getByText("选择节点")).toBeVisible({ timeout: 10_000 });
    await page.getByText("验收标准").first().click();
    await expect(page.getByText("AC-01").first()).toBeVisible({ timeout: 10_000 });
}

async function openRunsTab(page: Page) {
    await page.getByRole("button", { name: "运行", exact: true }).first().click();
    await expect(page.locator('[data-testid="verify-run"]')).toBeVisible({ timeout: 10_000 });
}

async function configureVerify(page: Page, body: Record<string, unknown>) {
    const response = await page.request.post(`${AGENT_URL}/__verify-config`, { data: body });
    expect(response.ok()).toBe(true);
}

async function runVerify(page: Page) {
    await page.locator('[data-testid="verify-cwd"]').fill("/tmp");
    await page.locator('[data-testid="verify-run"]').click();
}

/** E3: 摘要行的数字/状态直接读 DOM 上的数据属性，不靠文案措辞。 */
async function expectSummary(page: Page, expected: { round: number; status: "passed" | "failed" | "skipped" | "error"; passed: number; failed: number }) {
    const summary = page.locator('[data-testid="verify-summary"]');
    await expect(summary).toBeVisible({ timeout: 20_000 });
    await expect(summary).toHaveAttribute("data-verify-round", String(expected.round));
    await expect(summary).toHaveAttribute("data-verify-status", expected.status);
    await expect(summary.locator('[data-verify-count="passed"]')).toContainText(String(expected.passed));
    await expect(summary.locator('[data-verify-count="failed"]')).toContainText(String(expected.failed));
    return summary;
}

test("第一轮失败 → 第二轮通过：同一次运行累计两轮，AC-01 由红变绿", async ({ page }) => {
    await openCanvas(page);
    await createAcceptanceNode(page);
    await configureVerify(page, { failures: 1 });
    await openRunsTab(page);
    await runVerify(page);

    // 第一轮：失败，运行记录里出现第 1 轮。
    const run = page.locator("[data-run-id]").first();
    await expect(run).toBeVisible({ timeout: 20_000 });
    await expect(run.locator('[data-round-index="1"]')).toHaveAttribute("data-round-status", "failed");
    await expect(run).toHaveAttribute("data-run-status", "failed");

    // E3: 失败轮的摘要行给出红字与失败 AC，且失败 AC 可点回画布节点。
    const failedSummary = await expectSummary(page, { round: 1, status: "failed", passed: 0, failed: 1 });
    const chip = failedSummary.locator('[data-ac-chip="AC-01"]');
    await expect(chip).toBeVisible();
    // 有对应节点 → 渲染成可点的 button（没有节点时是 span + data-ac-clickable="false"）。
    await expect(chip).toHaveJSProperty("tagName", "BUTTON");
    await expect(chip).toBeEnabled();
    // 点一下真的定位到节点：选中态在节点上体现（z-50 即 isSelected）。
    await chip.click();
    await expect(page.locator('[data-node-id]').filter({ hasText: "AC-01" }).first()).toHaveClass(/z-50/, { timeout: 10_000 });

    // AC-01 应被回填成 failing（draft → ready → failing）。
    const acItem = page.locator('[data-testid="acceptance-list"] [data-ac-id="AC-01"]');
    await page.getByRole("button", { name: "验收", exact: true }).first().click();
    await expect(acItem).toHaveAttribute("data-ac-status", "failing", { timeout: 10_000 });

    // 第二轮：同一个运行里追加，状态变绿。
    await openRunsTab(page);
    await runVerify(page);
    await expect(run.locator('[data-round-index="2"]')).toHaveAttribute("data-round-status", "passed", { timeout: 20_000 });
    await expect(run).toHaveAttribute("data-run-status", "passed");
    await expect(run.locator('[data-round-index="1"]')).toHaveCount(1);

    // E3: 全绿时摘要行不给红——没有任何失败 chip，失败计数为 0。
    const passedSummary = await expectSummary(page, { round: 2, status: "passed", passed: 1, failed: 0 });
    await expect(passedSummary.locator("[data-ac-chip]")).toHaveCount(0);

    await page.getByRole("button", { name: "验收", exact: true }).first().click();
    await expect(acItem).toHaveAttribute("data-ac-status", "passing", { timeout: 10_000 });

    // 持久化：刷新后运行与两轮记录都还在。
    await page.waitForTimeout(800);
    await page.reload();
    await page.waitForURL(/\/canvas\//, { timeout: 30_000 });
    await openRunsTab(page);
    await expect(page.locator("[data-run-id]")).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator('[data-round-index="1"]')).toHaveCount(1);
    await expect(page.locator('[data-round-index="2"]')).toHaveCount(1);
});

test("连续失败跑满 5 轮 → 升级停止，不再追加轮次", async ({ page }) => {
    await openCanvas(page);
    await createAcceptanceNode(page);
    await configureVerify(page, { failures: 99 });
    await openRunsTab(page);

    await runVerify(page);
    const run = page.locator("[data-run-id]").first();
    await expect(run.locator('[data-round-index="1"]')).toBeVisible({ timeout: 20_000 });

    for (let round = 2; round <= 5; round += 1) {
        await runVerify(page);
        await expect(run.locator(`[data-round-index="${round}"]`)).toBeVisible({ timeout: 20_000 });
    }

    // 第 5 轮之后护栏触发：显示停止原因，且按钮再点也不会新增第六轮。
    await expect(page.locator('[data-testid="verify-stop"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="verify-stop"]')).toContainText("5");
    await runVerify(page);
    await page.waitForTimeout(1500);
    await expect(page.locator('[data-round-index="6"]')).toHaveCount(0);
});
