import { expect, test, type Page } from "@playwright/test";

/**
 * G3 E2E：环境节点的持续健康状态。
 *
 * 判定原则：不是「复检按钮点得动」，而是「DOM 上的状态与 HTTP 码来自真实探测结果」：
 * 部署后自动探测显示 healthy/HTTP 200；把假目标改成 503 再点复检，节点与面板都变红、
 * 原因可见；改回 200 再复检又变绿——说明每次都是重新探测，不是复用上一次的文案。
 */

const AGENT_URL = "http://127.0.0.1:17399";
const AGENT_TOKEN = "e2e-token";
const PROBE_URL = "http://127.0.0.1:17399";

async function openFreshCanvas(page: Page) {
    await page.request.get(`${AGENT_URL}/__reset`);
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

async function setProbeStatus(page: Page, status: number) {
    const response = await page.request.post(`${AGENT_URL}/__health-config`, { data: { status } });
    expect(response.ok()).toBe(true);
}

async function expectHealth(page: Page, expected: { status: "healthy" | "unhealthy"; code?: string }) {
    const panelStatus = page.locator("[data-node-panel] [data-env-health-status]");
    await expect(panelStatus).toHaveAttribute("data-env-health-status", expected.status, { timeout: 20_000 });
    if (expected.code) {
        await expect(page.locator("[data-node-panel] [data-env-health-code]")).toHaveText(expected.code);
    }
    // 节点自身的徽标读的是同一份 metadata：面板探测结果必须落到节点上，不能只在面板里好看。
    await expect(page.locator(`[data-env-health-badge="${expected.status}"]`)).toBeVisible({ timeout: 10_000 });
}

test("部署后自动探测 → 复检拿到 503 → 再复检恢复 200，原因可见且状态持久", async ({ page }) => {
    await openFreshCanvas(page);
    await createEnvironmentNode(page);

    await page.locator("[data-env-url]").fill(PROBE_URL);
    await page.locator("[data-env-version]").fill("v1.0.0");
    await page.locator("[data-env-command]").fill("true");
    await page.locator("[data-env-cwd]").fill("/tmp");
    await page.locator("[data-env-health-path]").fill("/probe-target");
    // 失焦提交健康路径，确保部署前 metadata 已有探测目标。
    await page.locator("[data-env-health-path]").blur();

    // 假目标先返回 200：部署成功后应自动探测并显示 healthy + HTTP 200。
    await setProbeStatus(page, 200);
    await page.locator("[data-env-deploy]").click();
    await expect(page.locator("[data-env-history] li")).toHaveCount(1, { timeout: 15_000 });
    await expectHealth(page, { status: "healthy", code: "HTTP 200" });
    // 最近探测时间是真实结果落点，不是渲染占位。
    await expect(page.locator("[data-node-panel] [data-env-health-at]")).toContainText(":");

    // 目标变成 503：点复检必须重新探测并变红，HTTP 码与失败原因都要可见。
    await setProbeStatus(page, 503);
    await page.locator("[data-env-recheck]").click();
    await expectHealth(page, { status: "unhealthy", code: "HTTP 503" });
    const reason = page.locator("[data-env-health-error]");
    await expect(reason).toBeVisible({ timeout: 10_000 });
    await expect(reason).toContainText("503");
    // 悬停能看到原因：title 上必须带同一句。
    await expect(reason).toHaveAttribute("title", /503/);
    await expect(page.locator('[data-env-health-badge="unhealthy"]')).toHaveAttribute("title", /503/);

    // 恢复 200 再复检：证明每次都是新结果，不是把上一次状态粘住。
    await setProbeStatus(page, 200);
    await page.locator("[data-env-recheck]").click();
    await expectHealth(page, { status: "healthy", code: "HTTP 200" });

    // 持久化：刷新后节点徽标仍带着最近一次探测结果（面板关闭也不该丢）。
    await page.waitForTimeout(800);
    await page.reload();
    await page.waitForURL(/\/canvas\//, { timeout: 30_000 });
    await expect(page.locator("[data-node-id]")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('[data-env-health-badge="healthy"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-env-health-badge-code]")).toHaveText("200");
});
