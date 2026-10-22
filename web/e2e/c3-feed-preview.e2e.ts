import { expect, test, type Page } from "@playwright/test";

/**
 * C3 投喂前预览 E2E。
 *
 * 判定原则：预览层不能只是「多弹一个框」——
 * 1) 框选两类节点后，预览里是拼好的全文（分组标题 + 正文），不是摘要；
 * 2) 手动改过的内容真的发出去（服务端 /__state 收到那句特征串）；
 * 3) 取消就什么都不发，输入框也不被写入。
 */

const AGENT_URL = "http://127.0.0.1:17399";
const AGENT_TOKEN = "e2e-token";
const WINDOW_TABS = '[role="tablist"][aria-label="会话窗"]';
const MARKER = "C3-PREVIEW-MARKER-改约入口放在订单详情页";

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

/** 全选画布内容并让投喂工具条落进视口（与 a4 / full-chain 同一套做法）。 */
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

async function agentState(page: Page) {
    const response = await page.request.get(`${AGENT_URL}/__state`);
    return response.json() as Promise<{ turns: { threadId: string; text: string }[] }>;
}

/** 框选 → 选目标窗 → 预览层出现，返回预览层的三个把手。 */
async function openFeedPreview(page: Page) {
    const feedButton = await selectAllAndRevealFeed(page);
    await expect(page.locator(WINDOW_TABS)).toBeAttached({ timeout: 15_000 });
    const targetLabel = (await page.locator(WINDOW_TABS).getByRole("tab").first().innerText()).trim();
    expect(targetLabel).toMatch(/^会话\s*\d+$/);
    await feedButton.click();
    const targetItem = page.locator(".ant-dropdown").getByText(targetLabel, { exact: true }).first();
    await expect(targetItem).toBeVisible({ timeout: 10_000 });
    await targetItem.click();

    const dialog = page.locator("[data-feed-preview]");
    const textarea = page.locator("[data-feed-preview-text]");
    await expect(textarea).toBeVisible({ timeout: 20_000 });
    return { dialog, textarea, send: page.locator("[data-feed-preview-send]"), cancel: page.locator("[data-feed-preview-cancel]"), targetLabel };
}

test("C3 投喂前预览：全文可改、发送用改过的文本、取消不发", async ({ page }) => {
    test.setTimeout(180_000);
    await page.request.get(`${AGENT_URL}/__reset`);
    await openFreshCanvas(page);

    // 1) 造两类内容：需求便签 + Markdown 文档。
    await createFromMenu(page, "需求便签");
    const requirement = page.locator('[data-node-id] [data-requirement-input]').first();
    await expect(requirement).toBeVisible({ timeout: 10_000 });
    await requirement.fill("支持提前 24 小时免费改约");
    await requirement.press("Enter");
    await expect(page.locator("[data-requirement-text]").first()).toContainText("支持提前 24 小时免费改约");

    await createFromMenu(page, "Markdown");
    const markdown = page.locator("[data-node-id]").last();
    await markdown.locator("[data-markdown-empty]").click();
    const markdownText = markdown.locator("[data-markdown-textarea]");
    await markdownText.fill("# 改约规则\n\n- 提前 24 小时可改约一次\n");
    await markdownText.press("Meta+Enter");
    await expect(markdown.locator("[data-markdown-preview] h1")).toHaveText("改约规则");

    // 2) 框选两类内容 → 预览层：全文（不是摘要）+ 目标窗 + 分组标题。
    const first = await openFeedPreview(page);
    await expect(page.locator("[data-feed-preview-target]")).toContainText(first.targetLabel);
    const draft = await first.textarea.inputValue();
    expect(draft).toContain("【需求】");
    expect(draft).toContain("【Markdown 文档】");
    expect(draft).toContain("支持提前 24 小时免费改约");
    expect(draft).toContain("提前 24 小时可改约一次");
    // 换行没有被吃掉：分组标题各占一行。
    expect(draft.split("\n")).toContain("【需求】");
    expect(draft.split("\n")).toContain("【Markdown 文档】");

    // 3) 手动追加一句特征串再发送：服务端收到的必须是改过的文本。
    await first.textarea.fill(`${draft}\n${MARKER}`);
    await first.send.click();
    await expect.poll(async () => (await agentState(page)).turns.length, { timeout: 20_000 }).toBe(1);
    const sent = (await agentState(page)).turns[0].text;
    expect(sent).toContain(MARKER);
    expect(sent).toContain("【需求】");
    expect(sent).toContain("【Markdown 文档】");
    // 发出去之后草稿清空，同一份内容不会滞留在输入框里被重复发送。
    const editor = page.locator('aside [role="textbox"]').first();
    await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
    await expect(editor).not.toContainText("【需求】", { timeout: 15_000 });

    // 4) 再预览一次 → 取消：服务端没有新消息，输入框也没被写。
    const second = await openFeedPreview(page);
    const reopened = await second.textarea.inputValue();
    expect(reopened).toContain("【需求】");
    // 重开回到当前选择的拼装结果，不残留上一次手改的特征串。
    expect(reopened).not.toContain(MARKER);
    await second.cancel.click();
    await expect(page.locator("[data-feed-preview]")).toHaveCount(0, { timeout: 10_000 });
    await page.waitForTimeout(1500);
    expect((await agentState(page)).turns.length).toBe(1);
    await expect(editor).not.toContainText("【需求】");
    expect((await editor.innerText()).trim()).toBe("");
});
