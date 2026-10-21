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

async function createFromMenu(page: Page, title: string) {
    await openNodeCreateMenu(page);
    await page.getByText(title).first().click();
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

test("创建旅程 → 自动排出 3 个步骤并连线", async ({ page }) => {
    await openFreshCanvas(page);
    await createFromMenu(page, "旅程");
    // 1 个旅程 + 3 个步骤 = 4 个画布节点。
    await expect(page.locator("[data-node-id]")).toHaveCount(4, { timeout: 10_000 });
    // 连线：旅程 -> 每个步骤各一条。
    await expect(page.locator("[data-connection-id]")).toHaveCount(3, { timeout: 10_000 });
    // 步骤正文带序号，避免三个空白步骤分不清。
    await expect(page.getByText("步骤 1")).toBeVisible();
    await expect(page.getByText("步骤 3")).toBeVisible();
});

test("创建设计稿 → 三版并排，默认只选中 A 版", async ({ page }) => {
    await openFreshCanvas(page);
    await createFromMenu(page, "设计稿");
    await expect(page.locator("[data-node-id]")).toHaveCount(3, { timeout: 10_000 });
    // 三个版本标签 A / B / C 都要出现。
    for (const label of ["A", "B", "C"]) {
        await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
    // 「已选定」徽章只能有一个 —— 多选会让「选定版本才进上下文」失去意义。
    await expect(page.getByText("已选定")).toHaveCount(1);
});
