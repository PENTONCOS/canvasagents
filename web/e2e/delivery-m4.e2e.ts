import { expect, test, type Page } from "@playwright/test";

/**
 * M4 E2E：环境节点的部署留痕与回滚。
 *
 * 判定原则：不是「按钮点了没报错」，而是「部署历史真的多了一条、版本真的回退了」。
 * 部署命令与健康检查由 mock agent 恒成功返回；真命令执行和真探测在桥端单测里覆盖，
 * 浏览器测试不跑 shell，否则会变成「测试环境能不能跑 pnpm」的测试。
 */

const AGENT_URL = "http://127.0.0.1:17399";
const AGENT_TOKEN = "e2e-token";

async function openFreshCanvas(page: Page) {
    // localStorage 里的地址/token 是 Agent 面板与部署请求共用的来源。
    // 只种存储不打开面板，避免侧栏遮住画布节点。
    await page.addInitScript(([url, token]) => {
        localStorage.setItem("canvas-agent-url", url);
        localStorage.setItem("canvas-agent-token", token);
    }, [AGENT_URL, AGENT_TOKEN]);
    await page.goto("/canvas?mode=new");
    await page.waitForURL(/\/canvas\//, { timeout: 30_000 });
    await expect(page.locator("main").first()).toBeVisible({ timeout: 30_000 });
}

async function createEnvironmentNode(page: Page) {
    const canvas = page.locator("main").first();
    await canvas.dblclick({ position: { x: 400, y: 300 } });
    await expect(page.getByText("选择节点")).toBeVisible({ timeout: 10_000 });
    await page.getByText("环境").first().click();
    await expect(page.locator("[data-node-panel]")).toBeVisible({ timeout: 10_000 });
}

test("部署两次 → 历史留痕 → 回滚后版本回退", async ({ page }) => {
    await openFreshCanvas(page);
    await createEnvironmentNode(page);

    await page.locator("[data-env-url]").fill("https://staging.example.com");
    await page.locator("[data-env-version]").fill("v1.0.0");
    await page.locator("[data-env-command]").fill("true");
    await page.locator("[data-env-cwd]").fill("/tmp");

    await page.locator("[data-env-deploy]").click();
    await expect(page.locator("[data-env-history] li")).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator("[data-env-history] li").first()).toContainText("v1.0.0");

    // 第二次部署：版本前进，历史变成两条（新的在前）。
    await page.locator("[data-env-version]").fill("v2.0.0");
    await page.locator("[data-env-deploy]").click();
    await expect(page.locator("[data-env-history] li")).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator("[data-env-history] li").first()).toContainText("v2.0.0");

    // 回滚：版本号回退到 v1.0.0，且历史仍是两条（回滚不是删除记录）。
    await page.locator("[data-env-rollback]").click();
    await expect(page.locator("[data-env-version]")).toHaveValue("v1.0.0", { timeout: 10_000 });
    await expect(page.locator("[data-env-history] li")).toHaveCount(2);
    await expect(page.locator("[data-env-history] li").first()).toContainText("v1.0.0");

    // 持久化：刷新后环境和历史都还在。
    await page.waitForTimeout(800);
    await page.reload();
    await page.waitForURL(/\/canvas\//, { timeout: 30_000 });
    await expect(page.locator("[data-node-id]")).toHaveCount(1, { timeout: 30_000 });
});
