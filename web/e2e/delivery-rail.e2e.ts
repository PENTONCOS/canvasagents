import { expect, test, type Page } from "@playwright/test";

/**
 * F2 E2E：左侧「待办 / 项目」树必须按真实 AC 状态计数。
 *
 * 只看「侧栏有字」不算通过 —— 要的是：新建一条 draft AC 之后，回到项目列表，
 * 待办计数从 0 变成 1，并且项目行里也能读到这个数。
 */

async function openFreshCanvas(page: Page) {
    await page.goto("/canvas?mode=new");
    await page.waitForURL(/\/canvas\//, { timeout: 30_000 });
    await expect(page.locator("main").first()).toBeVisible({ timeout: 30_000 });
    // 画布挂载完（右侧面板出现「画布元素」）再动手，否则双击会被首屏初始化吃掉。
    await expect(page.getByText("画布元素").first()).toBeVisible({ timeout: 30_000 });
}

test("左侧待办计数跟着 AC 走：新建一条 draft AC → 待办 1", async ({ page }) => {
    await openFreshCanvas(page);

    const canvas = page.locator("main").first();
    const box = await canvas.boundingBox();
    await canvas.dblclick({ position: { x: Math.round((box?.width ?? 900) * 0.55), y: Math.round((box?.height ?? 600) * 0.5) } });
    await expect(page.getByText("选择节点")).toBeVisible({ timeout: 10_000 });
    await page.getByText("验收标准").first().click();
    await expect(page.locator("[data-node-id]").first()).toBeVisible({ timeout: 10_000 });

    // persist 是异步 localForage 写入，给一拍再回列表。
    await page.waitForTimeout(900);
    await page.goto("/canvas");

    const rail = page.locator("aside");
    await expect(rail).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await rail.innerText()).replace(/\s+/g, " "), { timeout: 10_000 }).toMatch(/待办 1/);
    await expect.poll(async () => (await rail.innerText()).replace(/\s+/g, " "), { timeout: 10_000 }).toMatch(/1 待办 · 0 进行中 · 0 已完成/);
});
