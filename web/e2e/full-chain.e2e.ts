import { expect, test, type Page } from "@playwright/test";

/**
 * 端到端演示（需求文档 §9 第 6 步）：需求 → 旅程 → 设计三版与选定切换 → 验收 →
 * 三类内容节点 → 框选整块画布投喂到指定会话窗 → 服务端确认内容真的到了。
 *
 * 判定原则：UI 变化只是第一层。投喂必须同时核对 mock agent 的 /__state，
 * 确认请求体里带着三类内容的真实摘要；否则「点完看起来成功」也可能是空的。
 */

const AGENT_URL = "http://127.0.0.1:17399";
const AGENT_TOKEN = "e2e-token";
const WINDOW_TABS = '[role="tablist"][aria-label="会话窗"]';

test.use({ viewport: { width: 1600, height: 1100 } });

async function openCanvas(page: Page) {
    await page.addInitScript(([url, token]) => {
        localStorage.setItem("canvas-agent-url", url);
        localStorage.setItem("canvas-agent-token", token);
        // 未登录时右下角会浮出「登录可同步」横幅（fixed z-40），正好压住
        // 「打开助手」按钮，Playwright 会一直报 pointer events intercepted。
        // 这是产品自己的「关闭」持久化键，置上等于用户点过一次关闭。
        localStorage.setItem("canvasagents:onboarding_dismissed", "1");
        // 操作记录面板默认关闭，但它压在画布左上，开着就挡住投喂工具条。
        localStorage.setItem("canvas-panel-open:journal", "0");
        localStorage.setItem("canvas-panel-open:timeline", "0");
    }, [AGENT_URL, AGENT_TOKEN]);
    // 面板的静默连接只在 URL 带 agentUrl + agentToken 时发生（localStorage 只存地址，
    // 不会自动发起连接）；不带参数时输入框一直是「MCP 初始化中」，投喂内容根本发不出去。
    await page.goto(`/canvas?mode=new&agentUrl=${encodeURIComponent(AGENT_URL)}&agentToken=${encodeURIComponent(AGENT_TOKEN)}`);
    await page.waitForURL(/\/canvas\//, { timeout: 30_000 });
    await expect(page.locator("main").first()).toBeVisible({ timeout: 30_000 });
    // 画布区是 main 里的 section：main 先出现，section 紧跟其后才挂载。
    await expect(page.locator("main > section")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(600);
}

/**
 * 找一个既不在节点上、也不在顶栏/侧栏上的空白点，双击才会弹出创建菜单。
 * 写死坐标会随画布转场和节点增多而落到顶栏上（之前就栽在这里）。
 */
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
    await page.getByText(title, { exact: true }).first().click();
    await page.waitForTimeout(600);
}

async function openAgentPanel(page: Page) {
    // URL 带 agentUrl + agentToken 时面板会自己建立连接（SSE 挂上、会话就绪），
    // 但抽屉默认仍在视口右侧之外（x = 视口宽度）。收起时 aside 依然挂在 DOM 里，
    // 所以「元素可见」和「点得到」是两件事，先按位置判断再决定要不要点「打开助手」。
    await expect(page.locator(WINDOW_TABS)).toBeAttached({ timeout: 30_000 });
    const agentAside = page.locator("aside").filter({ has: page.locator(WINDOW_TABS) }).first();
    const width = page.viewportSize()?.width ?? 0;
    const box = await agentAside.boundingBox();
    if (!box || box.x + box.width > width + 2 || box.x >= width - 40) {
        await page.getByRole("button", { name: /打开 Agent|打开助手/ }).first().click();
        await expect.poll(async () => {
            const next = await agentAside.boundingBox();
            return Boolean(next && next.x + next.width <= width + 2 && next.x < width - 40);
        }, { timeout: 15_000 }).toBe(true);
    }
    // 输入框在连上之前是 contenteditable="false"（占位「MCP 初始化中」）。
    await expect(page.locator('aside [role="textbox"]').first()).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
}

async function agentState(page: Page) {
    const response = await page.request.get(`${AGENT_URL}/__state`);
    return response.json() as Promise<{ turns: { driver: string; threadId: string; text: string }[] }>;
}

/**
 * 全选画布内容并让投喂工具条真的落进视口。
 *
 * 两个坑（都实测过）：
 * 1. 焦点必须在画布空白处，点到侧栏按钮上时 ⌘A 会被快捷键处理器忽略；
 * 2. 工具条定位在「选中范围上沿再往上 8px」，节点铺满画布时它会顶到视口外，
 *    Playwright 报 element is outside of the viewport。缩放到能装下全部节点即可。
 */
async function selectAllAndRevealFeed(page: Page) {
    const section = page.locator("main > section");
    // 不点画布来抢焦点：空白点也可能落在悬浮工具条/面板的按钮上，一点就把
    // 操作记录面板打开、反过来盖住投喂工具条。直接 blur 掉当前焦点即可让
    // keydown 打到 body，快捷键处理器才认。
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Meta+a");

    const feedButton = page.getByRole("button", { name: "把选中的内容连同圈注截图一次交给 Agent" }).first();
    // 万一操作记录面板已经开着（左上 z-70），先用它自己的关闭按钮收起来。
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

test("全链路：需求 → 旅程 → 设计选定 → 验收失败定位 → 三类内容投喂进目标窗", async ({ page }) => {
    test.setTimeout(180_000);
    await page.request.get(`${AGENT_URL}/__reset`);
    await openCanvas(page);

    // 1) 需求便签（一句话需求）。
    await createFromMenu(page, "需求便签", { x: 140, y: 120 });
    await expect(page.locator("[data-node-id]")).toHaveCount(1, { timeout: 10_000 });

    // 2) 用户旅程：自动排出 3 个步骤并连线。
    await createFromMenu(page, "用户旅程", { x: 620, y: 120 });
    await expect(page.locator("[data-node-id]")).toHaveCount(5, { timeout: 10_000 });
    await expect(page.locator("[data-connection-id]")).toHaveCount(3, { timeout: 10_000 });
    await expect(page.getByText("步骤 1")).toBeVisible();
    await expect(page.getByText("步骤 3")).toBeVisible();

    // 3) 设计稿三版：默认只选定 A。
    await createFromMenu(page, "设计稿", { x: 520, y: 460 });
    await expect(page.locator("[data-node-id]")).toHaveCount(8, { timeout: 10_000 });

    const nodeWithBadge = (label: string) => page.locator("[data-node-id]").filter({ has: page.locator(`span:text-is("${label}")`) }).first();
    const nodeA = nodeWithBadge("A");
    const nodeB = nodeWithBadge("B");
    const nodeC = nodeWithBadge("C");
    await expect(nodeA).toBeVisible();
    await expect(nodeB).toBeVisible();
    await expect(nodeC).toBeVisible();

    const selectedBadges = page.getByText("已选定", { exact: true });
    await expect(selectedBadges).toHaveCount(1, { timeout: 10_000 });
    await expect(nodeA.getByText("已选定", { exact: true })).toHaveCount(1);

    // 3b) 点 B 的「设为选定」：A 的徽标消失、B 出现、全画布恰一个。
    await expect(nodeB.locator("[data-design-select]")).toBeVisible();
    await nodeB.locator("[data-design-select]").click();
    await expect(nodeB.getByText("已选定", { exact: true })).toHaveCount(1, { timeout: 10_000 });
    await expect(nodeA.getByText("已选定", { exact: true })).toHaveCount(0);
    await expect(selectedBadges).toHaveCount(1);

    // 刷新后仍然只有 B 一版选中（metadata 回写真的持久化了）。
    await page.waitForTimeout(800);
    await page.reload();
    await page.waitForURL(/\/canvas\//, { timeout: 30_000 });
    await expect(page.getByText("已选定", { exact: true })).toHaveCount(1, { timeout: 30_000 });
    await expect(nodeWithBadge("B").getByText("已选定", { exact: true })).toHaveCount(1);

    // 4) 验收标准 + E3 失败摘要与 chip 定位。
    await createFromMenu(page, "验收标准", { x: 1180, y: 120 });
    await expect(page.getByText("AC-01").first()).toBeVisible({ timeout: 10_000 });
    await page.request.post(`${AGENT_URL}/__verify-config`, { data: { failures: 1 } });
    await page.getByRole("button", { name: "运行", exact: true }).first().click();
    await page.locator('[data-testid="verify-cwd"]').fill("/tmp");
    await page.locator('[data-testid="verify-run"]').click();

    const summary = page.locator('[data-testid="verify-summary"]');
    await expect(summary).toHaveAttribute("data-verify-status", "failed", { timeout: 20_000 });
    const chip = summary.locator('[data-ac-chip="AC-01"]');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveJSProperty("tagName", "BUTTON");
    await chip.click();
    await expect(page.locator("[data-node-id]").filter({ hasText: "AC-01" }).first()).toHaveClass(/z-50/, { timeout: 10_000 });

    // 5) 三类内容节点：真实内容，供后续投喂。
    await createFromMenu(page, "Markdown", { x: 140, y: 780 });
    const markdownNode = page.locator("[data-node-id]").last();
    await markdownNode.locator("[data-markdown-empty]").click();
    const textarea = markdownNode.locator("[data-markdown-textarea]");
    await textarea.fill("# 改约规则\n\n- 提前 24 小时\n- 支持改期一次\n");
    await textarea.press("Meta+Enter");
    await expect(markdownNode.locator("[data-markdown-preview] h1")).toHaveText("改约规则");

    await createFromMenu(page, "网页预览", { x: 620, y: 780 });
    const previewNode = page.locator("[data-node-id]").last();
    await previewNode.locator("[data-preview-url-input]").fill("http://127.0.0.1:9/");
    await previewNode.locator("[data-preview-url-input]").press("Enter");
    await expect(previewNode.locator("[data-preview-error]")).toBeVisible({ timeout: 20_000 });

    await createFromMenu(page, "线框草图", { x: 1040, y: 780 });
    const sketchNode = page.locator("[data-node-id]").last();
    const layer = sketchNode.locator("[data-sketch-layer]");
    const layerBox = await layer.boundingBox();
    if (!layerBox) throw new Error("草图图层没有尺寸");
    const drag = async (x1: number, y1: number, x2: number, y2: number) => {
        await page.mouse.move(x1, y1);
        await page.mouse.down();
        await page.mouse.move(x2, y2, { steps: 10 });
        await page.mouse.up();
    };
    await drag(layerBox.x + layerBox.width * 0.2, layerBox.y + layerBox.height * 0.2, layerBox.x + layerBox.width * 0.55, layerBox.y + layerBox.height * 0.5);
    await sketchNode.locator('[data-sketch-tool="arrow"]').click();
    await drag(layerBox.x + layerBox.width * 0.2, layerBox.y + layerBox.height * 0.75, layerBox.x + layerBox.width * 0.7, layerBox.y + layerBox.height * 0.75);
    await expect(layer.locator("svg rect")).toHaveCount(1);
    await expect(layer.locator("svg line")).toHaveCount(1);

    // 6) 框选整块画布（⌘A = 全选画布内容）→ 投喂到会话窗。
    // 目标窗用面板自己列出来的那一项（不是写死「会话 N」），先把它读出来再点。
    const feedButton = await selectAllAndRevealFeed(page);
    await expect(page.locator(WINDOW_TABS)).toBeAttached({ timeout: 15_000 });
    const windowTabs = page.locator(WINDOW_TABS).getByRole("tab");
    const targetTab = windowTabs.first();
    const targetLabel = (await targetTab.innerText()).trim();
    expect(targetLabel).toMatch(/^会话\s*\d+$/);
    await feedButton.click();
    // 目标窗列表走 antd Dropdown portal。
    const targetItem = page.locator(".ant-dropdown").getByText(targetLabel, { exact: true }).first();
    await expect(targetItem).toBeVisible({ timeout: 10_000 });
    await targetItem.click();

    // 7) 投喂会自动展开面板并切到目标窗，草稿栏里真的有三类内容的分组。
    await expect(targetTab).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
    await expect(page.locator("aside").filter({ has: page.locator(WINDOW_TABS) })).toBeInViewport({ timeout: 15_000 });
    const editor = page.locator('aside [role="textbox"]').first();
    await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
    await expect(editor).toContainText("【Markdown 文档】", { timeout: 15_000 });
    await expect(editor).toContainText("【网页预览】");
    await expect(editor).toContainText("【线框草图】");

    // 8) 发送这一轮：服务端 /__state 里必须有真实内容摘要。
    await editor.click();
    await editor.press("Enter");
    await expect
        .poll(async () => (await agentState(page)).turns.length, { timeout: 20_000 })
        .toBeGreaterThan(0);
    const state = await agentState(page);
    const text = state.turns[0].text;
    expect(state.turns[0].threadId).toBeTruthy();
    expect(text).toContain("【Markdown 文档】");
    expect(text).toContain("【网页预览】");
    expect(text).toContain("【线框草图】");
    expect(text).toContain("改约规则");
    expect(text).toContain("http://127.0.0.1:9/");
    expect(text).toContain("2 个图形");
    // 需求/旅程/验收/设计也一起投喂了，不是只喂了三种内容。
    expect(text).toContain("【需求】");
    expect(text).toContain("【用户旅程】");
    expect(text).toContain("【验收标准】");
    expect(text).toContain("【设计稿】");

    // 9) 发出去之后草稿清空（同一份内容不会滞留在输入框里被重复发送）。
    await expect(editor).not.toContainText("【Markdown 文档】", { timeout: 15_000 });

    // 10) 新开第二个会话窗：它必须自己建线程（threads/reset）并进入 ready。
    // 回归点：桩端早期的 reset 会复用第一个窗的 threadId/conversationId，新窗的状态
    // 被归属判定写回第一个窗、再被 revision 保护挡掉，新窗永远停在「MCP 初始化中」。
    // 这里走右下角「打开助手」这条真实入口（面板收起时才露出来），它和 tab 上的
    // 「新建会话窗」共用同一个 addWindow + 补建线程的链路。
    await page.getByRole("button", { name: "收起 Agent 面板" }).first().click();
    const entry = page.getByRole("button", { name: /打开助手|打开 Agent/ }).first();
    await expect(entry).toBeVisible({ timeout: 15_000 });
    const readyStartedAt = Date.now();
    await entry.click();
    await expect(windowTabs).toHaveCount(2, { timeout: 15_000 });
    const secondTab = windowTabs.last();
    const secondLabel = (await secondTab.innerText()).trim();
    expect(secondLabel).toMatch(/^会话\s*\d+$/);
    expect(secondLabel).not.toBe(targetLabel);
    await expect(secondTab).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
    const agentAside = page.locator("aside").filter({ has: page.locator(WINDOW_TABS) }).first();
    const secondEditor = agentAside.locator('[role="textbox"]').first();
    await expect(secondEditor).toHaveAttribute("contenteditable", "true", { timeout: 20_000 });
    const readyMs = Date.now() - readyStartedAt;
    console.log(`第二个会话窗就绪耗时 ${readyMs}ms`);
    expect(readyMs).toBeLessThan(20_000);

    // 11) 投喂到新窗：内容落在新窗自己的草稿栏里。
    const feedButtonToSecond = await selectAllAndRevealFeed(page);
    await feedButtonToSecond.click();
    const secondItem = page.locator(".ant-dropdown").getByText(secondLabel, { exact: true }).first();
    await expect(secondItem).toBeVisible({ timeout: 10_000 });
    await secondItem.click();
    await expect(secondTab).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
    await expect(secondEditor).toContainText("【Markdown 文档】", { timeout: 15_000 });
    await expect(secondEditor).toContainText("【线框草图】");

    // 12) 新窗发送：服务端收到的是第二个线程，且第一个窗的草稿栏没被污染。
    await secondEditor.click();
    await secondEditor.press("Enter");
    await expect.poll(async () => (await agentState(page)).turns.length, { timeout: 20_000 }).toBe(2);
    const stateAfterSecondWindow = await agentState(page);
    expect(stateAfterSecondWindow.turns[1].threadId).toBeTruthy();
    expect(stateAfterSecondWindow.turns[1].threadId).not.toBe(stateAfterSecondWindow.turns[0].threadId);
    expect(stateAfterSecondWindow.turns[1].text).toContain("【Markdown 文档】");

    const firstEditor = agentAside.locator('[role="textbox"]').first();
    await expect(firstEditor).toHaveAttribute("contenteditable", "true", { timeout: 20_000 });
    await expect(firstEditor).not.toContainText("【Markdown 文档】");
    expect((await firstEditor.innerText()).trim()).toBe("");
});
