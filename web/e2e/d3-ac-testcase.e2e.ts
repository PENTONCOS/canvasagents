import { expect, test, type Page } from "@playwright/test";

/**
 * D3 E2E：AC 挂旅程/步骤、用例挂 AC、从 AC 生成用例。
 *
 * 判定原则：关联不能只是「内存里点一下」——
 * 1) 从 AC 新建的用例必须自带 @AC-01 锚点（没有锚点，E2/E3 的回填就是空的）；
 * 2) 侧栏 AC 下真的出现这条用例，刷新后还在（落的是实体，不是节点文案）；
 * 3) 「让 Agent 生成用例」走既有预览层，提示词里含锚点与 AC 正文。
 */

const AGENT_URL = "http://127.0.0.1:17399";
const AGENT_TOKEN = "e2e-token";
const STATEMENT = "点击「去结算」后进入订单详情页，且金额与购物车一致。";

async function openCanvas(page: Page) {
    await page.addInitScript(([url, token]) => {
        localStorage.setItem("canvas-agent-url", url);
        localStorage.setItem("canvas-agent-token", token);
        localStorage.setItem("canvasagents:onboarding_dismissed", "1");
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

async function openAcceptanceTab(page: Page) {
    await page.getByRole("button", { name: "验收", exact: true }).first().click();
    await expect(page.locator('[data-testid="acceptance-list"] [data-ac-id="AC-01"]')).toBeVisible({ timeout: 10_000 });
}

test("从 AC 新建用例 → 自带 @AC-01 锚点 → 刷新后仍关联", async ({ page }) => {
    await openCanvas(page);
    await createAcceptanceNode(page);
    await openAcceptanceTab(page);

    const card = page.locator('[data-testid="acceptance-list"] [data-ac-id="AC-01"]').first();
    // AC 正文是生成用例的输入，必须能直接写进实体。
    await card.locator('[data-testid="ac-statement-input"]').fill(STATEMENT);
    await card.locator('[data-testid="ac-statement-input"]').press("Tab");
    await expect(card.locator('[data-testid="ac-statement-input"]')).toHaveValue(STATEMENT);

    // 建用例：只填标题，锚点由产品自动生成，不靠人手写。
    await card.locator('[data-testid="ac-new-test"]').click();
    await card.locator('[data-testid="ac-new-test-input"]').fill("结算跳转");
    await card.locator('[data-testid="ac-new-test-save"]').click();

    const testCase = card.locator('[data-testcase-id="TC-01"]');
    await expect(testCase).toBeVisible({ timeout: 10_000 });
    await expect(testCase).toContainText("结算跳转");
    await expect(testCase.locator("[data-testcase-anchor]")).toHaveAttribute("data-testcase-anchor", "@AC-01");
    await expect(testCase.locator("[data-testcase-anchor]")).toContainText("@AC-01");
    await expect(card.locator("[data-testcase-count]")).toHaveAttribute("data-testcase-count", "1");

    // 持久化：刷新后关联还在（用例是实体，不是节点上的临时文案）。
    await page.waitForTimeout(800);
    await page.reload();
    await page.waitForURL(/\/canvas\//, { timeout: 30_000 });
    await openAcceptanceTab(page);
    const reloadedCard = page.locator('[data-testid="acceptance-list"] [data-ac-id="AC-01"]').first();
    await expect(reloadedCard.locator('[data-testcase-id="TC-01"]')).toBeVisible({ timeout: 15_000 });
    await expect(reloadedCard.locator("[data-testcase-count]")).toHaveAttribute("data-testcase-count", "1");
    await expect(reloadedCard.locator('[data-testid="ac-statement-input"]')).toHaveValue(STATEMENT);
});

test("让 Agent 生成用例 → 出预览层，提示词含 @AC-01 与 AC 正文", async ({ page }) => {
    await openCanvas(page);
    await createAcceptanceNode(page);
    await openAcceptanceTab(page);

    const card = page.locator('[data-testid="acceptance-list"] [data-ac-id="AC-01"]').first();
    await card.locator('[data-testid="ac-statement-input"]').fill(STATEMENT);
    await card.locator('[data-testid="ac-statement-input"]').press("Tab");

    await card.locator('[data-testid="ac-generate-tests"]').click();

    // 走的是既有投喂预览层，不是另一套发送通道。
    const preview = page.locator("[data-feed-preview]");
    await expect(preview).toBeVisible({ timeout: 10_000 });
    const text = preview.locator("[data-feed-preview-text]");
    await expect(text).toContainText("@AC-01");
    await expect(text).toContainText(STATEMENT);
    // 预览必须能看出会发给哪个窗。
    await expect(preview.locator("[data-feed-preview-target]")).not.toBeEmpty();
});
