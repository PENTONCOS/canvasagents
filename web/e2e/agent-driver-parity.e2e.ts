import { expect, test, type Page } from "@playwright/test";

/**
 * M5 验收①：同一个面板，同一件事，两个 driver 都能真的跑完一轮。
 *
 * 判定原则：不能只看「输入框清空了」这种界面痕迹。假 Agent 会记录每一轮收到的 turn，
 * 断言里同时核对「服务端收到的是哪个 driver 的 turn」和「助手回话真的渲染出来」，
 * 少一半都说明链路是断的（HTTP 通了但事件流没接上，面板会一直停在发送中）。
 */

const AGENT_URL = "http://127.0.0.1:17399";
const AGENT_TOKEN = "e2e-token";

const WINDOW_TABS = '[role="tablist"][aria-label="会话窗"]';
const COMPOSER = '[role="textbox"][aria-label*="询问"]';

type TurnRecord = { driver: string; threadId: string; turnId: string; text: string };

async function panelInViewport(page: Page) {
    const width = page.viewportSize()?.width ?? 0;
    const box = await page.locator("aside").first().boundingBox();
    if (!box) return false;
    return box.x + box.width <= width + 2 && box.x < width - 40;
}

async function seedAndOpen(page: Page) {
    await page.goto(`/canvas?agentUrl=${encodeURIComponent(AGENT_URL)}&agentToken=${AGENT_TOKEN}`);
    await expect(page.locator(WINDOW_TABS)).toBeAttached({ timeout: 30_000 });
    const toggle = page.getByRole("button", { name: "打开 Agent", exact: true });
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    await toggle.click();
    await expect.poll(() => panelInViewport(page), { timeout: 15_000 }).toBe(true);
    await expect(page.getByRole("button", { name: /新\s*对\s*话/ })).toBeEnabled({ timeout: 30_000 });
}

async function send(page: Page, text: string) {
    const composer = page.locator(COMPOSER).first();
    await expect(composer).toBeEditable({ timeout: 20_000 });
    await composer.click();
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
}

test.beforeEach(async ({ page }) => {
    await page.request.get(`${AGENT_URL}/__reset`);
    await page.addInitScript(() => localStorage.removeItem("canvasagents.agent.driver"));
});

test("同一件事在 codex 与 claude 下都能跑完一轮并收到回话", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (request) => {
        if (request.url().includes("/turn")) requests.push(request.url().replace(AGENT_URL, "").split("?")[0]);
    });

    await seedAndOpen(page);

    // ① codex 跑一轮。
    await send(page, "把首页标题改成蓝色");
    await expect(page.getByText(/mock codex reply/)).toBeVisible({ timeout: 20_000 });
    expect(requests).toContain("/agent/codex/turn");

    // ② 切到 claude，同一件事再跑一轮。
    const switcher = page.locator('[role="radiogroup"][aria-label="Agent 驱动"]');
    await expect(switcher).toBeVisible({ timeout: 10_000 });
    await switcher.getByText("Claude Code").click();
    await expect(page.locator('[role="tablist"][aria-label="Agent 内容"]').getByRole("tab", { name: "历史 (1)" })).toBeAttached({ timeout: 20_000 });

    await send(page, "把首页标题改成蓝色");
    await expect(page.getByText(/mock claude reply/)).toBeVisible({ timeout: 20_000 });
    expect(requests).toContain("/agent/claude/turn");

    // ③ 服务端记录：两个 driver 各收到一轮，且各自的 threadId 没串。
    const state = await (await page.request.get(`${AGENT_URL}/__state`)).json() as { turns: TurnRecord[] };
    expect(state.turns).toHaveLength(2);
    expect(state.turns[0]).toMatchObject({ driver: "codex", threadId: "thread-a" });
    expect(state.turns[1]).toMatchObject({ driver: "claude", threadId: "claude-thread-1" });
    // 同一句话两次都原样送到了桥端——不是浏览器本地伪造的。
    expect(state.turns.map((turn) => turn.text)).toEqual(["把首页标题改成蓝色", "把首页标题改成蓝色"]);
});
