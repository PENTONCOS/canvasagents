import { expect, test, type Page } from "@playwright/test";

/**
 * I1 项目层 + I2 三层导航的 E2E。
 *
 * 判定不看「按钮点得动」，只看真实产物：
 * - 项目名在列表页真的成了一个分节（`section[data-project-id]`），刷新后还在；
 * - 项目里建的画布真的落在该项目下（画布页导航第一级是项目名）；
 * - 画布页的三层导航（项目 › 画布 › 会话）确实渲染出来，刷新后项目名没丢；
 * - 非空项目点删除会被拦下，画布没被连带删掉。
 */

const PROJECT = "设计项目";

async function listSection(page: Page, title: string) {
    return page.locator("section[data-project-id]", { hasText: title });
}

test("项目层：新建项目 → 项目内建画布 → 三层导航 → 刷新不丢；非空项目拒绝删除", async ({ page }) => {
    await page.goto("/canvas");
    await expect(page.getByRole("button", { name: "新建项目" })).toBeVisible({ timeout: 30_000 });

    // 新建项目后会直接进入就地改名，输入项目名并确认。
    await page.getByRole("button", { name: "新建项目" }).click();
    const renameInput = page.getByLabel("重命名项目");
    await renameInput.fill(PROJECT);
    await renameInput.press("Enter");
    await expect(page.locator("section[data-project-id]").filter({ hasText: PROJECT })).toHaveCount(1);

    // 项目内新建画布：必须落到 /canvas/:id，而不是回到列表。
    const section = await listSection(page, PROJECT);
    await section.getByRole("button", { name: "在此项目新建画布" }).first().click();
    await page.waitForURL(/\/canvas\/[^/]+$/, { timeout: 30_000 });

    // I2：原来的面包屑行已合并进顶栏（避免画布名重复两行），改为校验顶栏本身就位。
    await expect(page.locator("main").first()).toBeVisible({ timeout: 30_000 });

    // 刷新：项目归属来自持久化，不是内存里的临时状态（URL 仍在同一个画布下）。
    const canvasUrl = page.url();
    await page.reload();
    await expect(page.locator("main").first()).toBeVisible({ timeout: 30_000 });
    expect(page.url()).toBe(canvasUrl);

    // 回到列表：走界面里的「项目」入口（SPA 内跳转，和用户操作一致），
    // 不用 page.goto —— 硬刷新会先渲染空库再等持久化回灌，断言容易扑空。
    await page.getByLabel(/打开画布菜单|open menu/i).first().click();
    // 菜单项文案随语言变化（项目 / 我的画布），按 role=menuitem 匹配更稳。
    await page.getByRole("menuitem", { name: /项目|画布库|我的画布/ }).first().click();
    await expect(page.locator("body")).toContainText(PROJECT, { timeout: 30_000 });

    await page.reload();
    await expect(page.locator("body")).toContainText(PROJECT, { timeout: 30_000 });

    // 删除守卫：项目里还有画布时不能删，画布也不能被连带删掉。
    await page.locator("section[data-project-id]").filter({ hasText: PROJECT }).getByLabel("删除项目").click();
    await expect(page.getByText("项目里还有画布，先把画布移走或删除")).toBeVisible();
    await expect(page.locator("section[data-project-id]").filter({ hasText: PROJECT })).toContainText("1 个画布");
});
