import { expect, test, type Page } from "@playwright/test";

/**
 * 侧边栏 E2E。
 *
 * 判定原则：只看界面变没变是不够的——之前的删除按钮就是「UI 上什么都没有」，
 * 单测和 tsc 都不会报。所以凡是会发出请求的动作，都要同时核对假 Agent 服务的
 * /__state，确认请求真的到了服务端。
 */

const AGENT_URL = "http://127.0.0.1:17399";
const AGENT_TOKEN = "e2e-token";

const WINDOW_TABS = '[role="tablist"][aria-label="会话窗"]';
const CONTENT_TABS = '[role="tablist"][aria-label="Agent 内容"]';

async function agentState(page: Page) {
    const response = await page.request.get(`${AGENT_URL}/__state`);
    return response.json() as Promise<{ deleted: string[]; threads: string[] }>;
}

async function resetAgent(page: Page) {
    await page.request.get(`${AGENT_URL}/__reset`);
}

/**
 * 面板收起时，aside 仍在 DOM 里但整体被推到视口右侧之外（width 动画到 0）。
 * 这时候元素「可见」但点不到，Playwright 会一直报 outside of the viewport，
 * 所以每次都要确认面板真的展开在视口内。
 */
async function panelInViewport(page: Page) {
    const width = page.viewportSize()?.width ?? 0;
    const box = await page.locator("aside").first().boundingBox();
    if (!box) return false;
    return box.x + box.width <= width + 2 && box.x < width - 40;
}

async function seedAndOpen(page: Page) {
    // URL 上带 agentUrl / agentToken 时面板会自动连接（silent connect），
    // 这也是产品本身的「一键连接」路径，顺带被这条用例覆盖到。
    await page.goto(`/canvas?agentUrl=${encodeURIComponent(AGENT_URL)}&agentToken=${AGENT_TOKEN}`);
    await expect(page.locator(WINDOW_TABS)).toBeAttached({ timeout: 30_000 });

    if (!(await panelInViewport(page))) {
        await page.getByRole("button", { name: /打开 Agent|打开助手/ }).first().click();
    }
    await expect.poll(() => panelInViewport(page), { timeout: 15_000 }).toBe(true);

    // 连上之后内容 tab 里的「新对话」才可用；用它当连接成功的信号。
    await expect(page.getByRole("button", { name: /新\s*对\s*话/ })).toBeEnabled({ timeout: 30_000 });
}

function windowTabs(page: Page) {
    return page.locator(WINDOW_TABS).getByRole("tab");
}

function contentTabs(page: Page) {
    return page.locator(CONTENT_TABS).getByRole("tab");
}

async function openHistory(page: Page) {
    await contentTabs(page).filter({ hasText: "历史" }).click();
    await expect(page.getByRole("button", { name: /刷\s*新/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("蓝色调改图").first()).toBeVisible({ timeout: 20_000 });
}

test.beforeEach(async ({ page }) => {
    await resetAgent(page);
});

test("连接成功后会话窗切换条出现，默认只有一个窗", async ({ page }) => {
    await seedAndOpen(page);
    await expect(windowTabs(page)).toHaveCount(1);
    await expect(windowTabs(page).first()).toContainText("会话 1");
});

test("点「新建」会多一个会话窗，且标题不重复", async ({ page }) => {
    await seedAndOpen(page);
    await page.getByRole("button", { name: "新建会话窗" }).click();
    await expect(windowTabs(page)).toHaveCount(2);
    const labels = (await windowTabs(page).allInnerTexts()).map((text) => text.trim());
    expect(new Set(labels).size, `标题重复了：${JSON.stringify(labels)}`).toBe(labels.length);
});

test("连点两次新建后三个窗标题互不相同", async ({ page }) => {
    await seedAndOpen(page);
    await page.getByRole("button", { name: "新建会话窗" }).click();
    await page.getByRole("button", { name: "新建会话窗" }).click();
    const labels = (await windowTabs(page).allInnerTexts()).map((text) => text.trim());
    expect(labels.length).toBe(3);
    expect(new Set(labels).size, `标题重复了：${JSON.stringify(labels)}`).toBe(3);
});

test("会话窗可以重命名，改名后标签立刻变", async ({ page }) => {
    await seedAndOpen(page);
    // 这一条就是 renameWindow「0 个 UI 入口」的回归用例。
    const renameButton = page.getByRole("button", { name: /重命名/ });
    await expect(renameButton).toBeVisible({ timeout: 5_000 });
    await renameButton.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole("textbox");
    await input.fill("蓝色调改图");
    await dialog.getByRole("button", { name: /保\s*存|确\s*定|OK/i }).click();
    await expect(windowTabs(page).first()).toContainText("蓝色调改图");
});

test("历史页悬停某条点垃圾桶，服务端真的收到删除并移除该条", async ({ page }) => {
    await seedAndOpen(page);
    await openHistory(page);

    const row = page.locator("div[role='button']").filter({ hasText: "蓝色调改图" }).first();
    await row.hover();
    await row.getByRole("button", { name: /删除/ }).click();

    const confirm = page.getByRole("button", { name: /^删\s*除$|确\s*定/ }).last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();

    await expect.poll(async () => (await agentState(page)).deleted, { timeout: 10_000 }).toContain("thread-a");
    await expect(page.getByText("蓝色调改图")).toHaveCount(0, { timeout: 10_000 });
});

test("勾选两条后批量删除，服务端两条都收到", async ({ page }) => {
    await seedAndOpen(page);
    await openHistory(page);

    const boxes = page.locator("div[role='button']").filter({ hasText: "蓝色调改图" }).first().getByRole("checkbox").or(page.locator("div[role='button']").filter({ hasText: "第二次尝试" }).first().getByRole("checkbox"));
    await boxes.nth(0).click();
    await boxes.nth(1).click();

    await page.getByRole("button", { name: /删\s*除\s*\d+\s*条/ }).click();
    const confirm = page.getByRole("button", { name: /^删\s*除$|确\s*定/ }).last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();

    await expect.poll(async () => (await agentState(page)).deleted.length, { timeout: 10_000 }).toBe(2);
});

test("只剩一个会话窗时点关闭，先弹出说明而不是静默消失", async ({ page }) => {
    await seedAndOpen(page);
    await page.getByRole("button", { name: "关闭当前会话窗" }).click();
    await expect(page.getByText(/最后一个|空白/)).toBeVisible({ timeout: 5_000 });
});

test("每个内容 tab 都能点开且内容区不空白", async ({ page }) => {
    await seedAndOpen(page);
    const tabs = contentTabs(page);
    const count = await tabs.count();
    expect(count).toBeGreaterThanOrEqual(5);
    for (let index = 0; index < count; index += 1) {
        const tab = tabs.nth(index);
        const name = (await tab.innerText()).trim();
        await tab.click();
        await expect(tab).toHaveAttribute("aria-selected", "true");
        // 判定「内容区不是空的」：看面板本身有没有渲染出文字，而不是看整页长度
        // （画布库本身几乎是空的，用一个拍脑袋的长度阈值只会误报）。
        const panelText = (await page.locator("aside").first().innerText()).trim();
        expect(panelText.length, `tab「${name}」点开后面板是空的`).toBeGreaterThan(30);
        // 点开不能把面板本身弄没
        await expect(page.locator(WINDOW_TABS)).toBeVisible();
    }
});
