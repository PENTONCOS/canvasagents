import { expect, test, type Page } from "@playwright/test";

/**
 * 交付域 M0 E2E。
 *
 * 判定原则与 agent-sidebar 一致：只看界面出现不算完，
 * 节点必须「创建 → 持久化 → 重载仍在」才算通过。
 */

// 交付域 9 类节点在创建菜单里的中文标题（zh-CN 文案）。
const DELIVERY_MENU_TITLES = ["需求便签", "旅程", "旅程步骤", "设计稿", "验收标准", "测试用例", "问题单", "环境", "运行记录"];
// TestCase/Bug/Run 设了 showInCreateMenu: false，不应出现在菜单。
const HIDDEN_MENU_TITLES = ["测试用例", "问题单", "运行记录"];

async function openFreshCanvas(page: Page) {
    // mode=new：列表页会自动新建并进入项目（pages/canvas/index.tsx 自动进入逻辑）。
    await page.goto("/canvas?mode=new");
    await page.waitForURL(/\/canvas\//, { timeout: 30_000 });
    await expect(page.locator("main").first()).toBeVisible({ timeout: 30_000 });
}

async function openNodeCreateMenu(page: Page) {
    // 双击画布空白处 → NodeCreateMenu。
    const canvas = page.locator("main").first();
    await canvas.dblclick({ position: { x: 400, y: 300 } });
    await expect(page.getByText("选择节点")).toBeVisible({ timeout: 10_000 });
}

test("创建菜单含交付域节点（TestCase/Bug/Run 不外露）", async ({ page }) => {
    await openFreshCanvas(page);
    await openNodeCreateMenu(page);
    for (const title of ["需求便签", "旅程", "旅程步骤", "设计稿", "验收标准", "环境"]) {
        await expect(page.getByText(title).first()).toBeVisible();
    }
    for (const title of HIDDEN_MENU_TITLES) {
        await expect(page.getByText(title)).toHaveCount(0);
    }
});

test("创建需求节点 → 刷新后仍在（持久化）", async ({ page }) => {
    await openFreshCanvas(page);
    await openNodeCreateMenu(page);
    await page.getByText("需求便签").first().click();
    // 节点卡片正文不渲染标题，用「画布上有交付节点 + 资产面板出现名字」双证。
    await expect(page.locator("[data-node-id]").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-node-id]')).toHaveCount(1);
    // persist 是异步 localForage 写入，给一拍再刷新。
    await page.waitForTimeout(800);
    await page.reload();
    await page.waitForURL(/\/canvas\//, { timeout: 30_000 });
    await expect(page.locator('[data-node-id]')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByText("需求便签").first()).toBeVisible({ timeout: 15_000 });
});

export { DELIVERY_MENU_TITLES };
