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

    // I2：三级导航都要真的在页面上。
    const nav = page.locator('[data-testid="canvas-project-nav"]');
    await expect(nav).toBeVisible({ timeout: 30_000 });
    await expect(nav).toContainText(PROJECT);
    await expect(nav).toContainText("会话");

    // 刷新：项目归属来自持久化，不是内存里的临时状态。
    await page.reload();
    await expect(page.locator('[data-testid="canvas-project-nav"]')).toContainText(PROJECT, { timeout: 30_000 });

    // 回到列表：项目还在，并且真的统计到 1 个画布。
    await page.goto("/canvas");
    const persisted = page.locator("section[data-project-id]").filter({ hasText: PROJECT });
    await expect(persisted).toHaveCount(1, { timeout: 30_000 });
    await expect(persisted).toContainText("1 个画布");

    await page.reload();
    await expect(page.locator("section[data-project-id]").filter({ hasText: PROJECT })).toContainText("1 个画布", { timeout: 30_000 });

    // 删除守卫：项目里还有画布时不能删，画布也不能被连带删掉。
    await page.locator("section[data-project-id]").filter({ hasText: PROJECT }).getByLabel("删除项目").click();
    await expect(page.getByText("项目里还有画布，先把画布移走或删除")).toBeVisible();
    await expect(page.locator("section[data-project-id]").filter({ hasText: PROJECT })).toContainText("1 个画布");
});
