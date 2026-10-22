import { expect, test, type Page } from "@playwright/test";

/**
 * A4 需求便签 E2E。
 *
 * 判定原则：创建出来不算完，必须验到三件事——
 * 1) 新建第二条不会覆盖第一条，各自内容独立；
 * 2) 刷新后两条都还在（真的持久化到画布，不是只活在内存里）；
 * 3) 框选两条投喂时，提示词按创建顺序带上两句话（需求分组头 + 正文）。
 */

const AGENT_URL = "http://127.0.0.1:17399";
const AGENT_TOKEN = "e2e-token";
const WINDOW_TABS = '[role="tablist"][aria-label="会话窗"]';

test.use({ viewport: { width: 1600, height: 1100 } });

async function openFreshCanvas(page: Page) {
    await page.addInitScript(([url, token]) => {
        localStorage.setItem("canvas-agent-url", url);
        localStorage.setItem("canvas-agent-token", token);
        localStorage.setItem("canvasagents:onboarding_dismissed", "1");
        localStorage.setItem("canvas-panel-open:journal", "0");
        localStorage.setItem("canvas-panel-open:timeline", "0");
    }, [AGENT_URL, AGENT_TOKEN]);
    await page.goto(`/canvas?mode=new&agentUrl=${encodeURIComponent(AGENT_URL)}&agentToken=${encodeURIComponent(AGENT_TOKEN)}`);
    await page.waitForURL(/\/canvas\//, { timeout: 30_000 });
    await expect(page.locator("main").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("main > section")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(600);
}

/** 找一个不在节点/连线上的空白点：双击它才会弹出创建菜单。 */
async function freePoint(page: Page): Promise<{ x: number; y: number }> {
    const point = await page.evaluate(() => {
        const section = document.querySelector("main > section");
        if (!section) return null;
        const rect = section.getBoundingClientRect();
        for (let y = rect.y + 140; y < rect.y + rect.height - 80; y += 60) {
            for (let x = rect.x + 60; x < rect.x + rect.width - 80; x += 60) {
                const hit = document.elementFromPoint(x, y);
                if (!hit?.closest("[data-node-id],[data-connection-id]")) return { x: Math.round(x), y: Math.round(y) };
            }
        }
        return null;
    });
    if (!point) throw new Error("画布上找不到空白点");
    return point;
}

/** 双击空白点 → 在创建菜单里点节点名。菜单按容器的「选择节点」标题定位，避免点到已有节点的同名标签。 */
async function createFromMenu(page: Page, title: string) {
    const section = page.locator("main > section");
    const point = await freePoint(page);
    const box = await section.boundingBox();
    if (!box) throw new Error("画布区域没有尺寸");
    await section.dblclick({ position: { x: point.x - box.x, y: point.y - box.y } });
    await expect(page.getByText("选择节点")).toBeVisible({ timeout: 10_000 });
    const menu = page.locator("[data-canvas-no-zoom]").filter({ hasText: "选择节点" }).last();
    await menu.getByText(title, { exact: true }).first().click();
    await page.waitForTimeout(600);
}

function requirementNode(page: Page, ordinal: number) {
    return page.locator(`[data-node-id] [data-requirement-index="${ordinal}"]`).first();
}

async function reloadCanvas(page: Page) {
    // persist 走 localForage 防抖写入，刷新前给一拍。
    await page.waitForTimeout(1000);
    await page.reload();
    await page.waitForURL(/\/canvas\//, { timeout: 30_000 });
    await expect(page.locator("main > section")).toBeVisible({ timeout: 30_000 });
}

/**
 * 全选画布内容并让投喂工具条落进视口（与 full-chain 的做法一致）：
 * 焦点要在画布空白处，工具条顶到视口外时先缩小。
 */
async function selectAllAndRevealFeed(page: Page) {
    const section = page.locator("main > section");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Meta+a");

    const feedButton = page.getByRole("button", { name: "把选中的内容连同圈注截图一次交给 Agent" }).first();
    const journal = page.locator("[data-canvas-journal-panel]");
    if (await journal.count()) {
        await journal.locator('button[aria-label="操作记录"]').first().click();
        await expect(journal).toHaveCount(0);
    }
    const zoom = section.locator('input[type="range"][aria-label="放大/缩小画布"]').first();
    const inViewport = async () => {
        const rect = await feedButton.boundingBox();
        const viewport = page.viewportSize();
        if (!rect || !viewport) return false;
        return rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height;
    };
    if (await feedButton.count()) {
        for (const percent of [80, 60, 45, 30]) {
            if (await inViewport()) break;
            await zoom.evaluate((input: HTMLInputElement, value: string) => {
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
                setter?.call(input, value);
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.dispatchEvent(new Event("change", { bubbles: true }));
            }, String(percent));
            await page.waitForTimeout(400);
        }
    }
    await expect(feedButton).toBeVisible({ timeout: 10_000 });
    return feedButton;
}

test("A4 需求便签：并列两条 → 各写一句 → 刷新仍在 → 框选投喂按顺序带上两句", async ({ page }) => {
    test.setTimeout(120_000);
    await page.request.get(`${AGENT_URL}/__reset`);
    await openFreshCanvas(page);

    // 1) 第一条：新建即进入编辑态并聚焦，回车提交。
    await createFromMenu(page, "需求便签");
    const first = requirementNode(page, 1);
    await expect(first).toBeVisible({ timeout: 10_000 });
    const firstInput = first.locator("[data-requirement-input]");
    await expect(firstInput).toBeVisible();
    await expect(firstInput).toBeFocused();
    await firstInput.fill("支持提前 24 小时免费改约");
    await firstInput.press("Enter");
    await expect(first.locator("[data-requirement-text]")).toContainText("支持提前 24 小时免费改约");

    // 2) 第二条：再建一条，序号递增，内容独立。
    await createFromMenu(page, "需求便签");
    const second = requirementNode(page, 2);
    await expect(second).toBeVisible({ timeout: 10_000 });
    const secondInput = second.locator("[data-requirement-input]");
    await expect(secondInput).toBeVisible();
    await expect(secondInput).toBeFocused();
    await secondInput.fill("改约成功后短信通知双方");
    await secondInput.press("Enter");
    await expect(second.locator("[data-requirement-text]")).toContainText("改约成功后短信通知双方");
    // 写第二条没有把第一条覆盖掉。
    await expect(first.locator("[data-requirement-text]")).toContainText("支持提前 24 小时免费改约");

    // 3) 回头改第一条：只动这一条，兄弟节点原样。
    await first.locator("[data-requirement-text]").dblclick();
    const editFirst = first.locator("[data-requirement-input]");
    await expect(editFirst).toBeVisible();
    await editFirst.fill("支持提前 48 小时免费改约");
    await editFirst.press("Enter");
    await expect(first.locator("[data-requirement-text]")).toContainText("支持提前 48 小时免费改约");
    await expect(second.locator("[data-requirement-text]")).toContainText("改约成功后短信通知双方");
    await expect(second).toHaveAttribute("data-requirement-index", "2");

    // 4) 刷新后两条都在，内容与序号都对。
    await reloadCanvas(page);
    await expect(page.locator("[data-requirement-index]")).toHaveCount(2, { timeout: 30_000 });
    await expect(requirementNode(page, 1).locator("[data-requirement-text]")).toContainText("支持提前 48 小时免费改约");
    await expect(requirementNode(page, 2).locator("[data-requirement-text]")).toContainText("改约成功后短信通知双方");

    // 5) 框选两条 → 投喂。目标窗用面板自己列出的那一项。
    const feedButton = await selectAllAndRevealFeed(page);
    await expect(page.locator(WINDOW_TABS)).toBeAttached({ timeout: 15_000 });
    const targetTab = page.locator(WINDOW_TABS).getByRole("tab").first();
    const targetLabel = (await targetTab.innerText()).trim();
    expect(targetLabel).toMatch(/^会话\s*\d+$/);
    await feedButton.click();
    const targetItem = page.locator(".ant-dropdown").getByText(targetLabel, { exact: true }).first();
    await expect(targetItem).toBeVisible({ timeout: 10_000 });
    await targetItem.click();

    // 6) 草稿里按【需求】分组、带上两句话，且顺序与画布一致。
    const editor = page.locator('aside [role="textbox"]').first();
    await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
    await expect(editor).toContainText("【需求】", { timeout: 15_000 });
    const prompt = await editor.innerText();
    const firstAt = prompt.indexOf("支持提前 48 小时免费改约");
    const secondAt = prompt.indexOf("改约成功后短信通知双方");
    expect(firstAt).toBeGreaterThan(-1);
    expect(secondAt).toBeGreaterThan(-1);
    expect(firstAt).toBeLessThan(secondAt);
});
