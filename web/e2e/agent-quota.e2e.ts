import { expect, test, type Page } from "@playwright/test";

/**
 * M5 验收③：额度用尽必须给明确提示，并且真的拦住动作，不能静默失败。
 *
 * 判定原则：只断言提示条出现是不够的——提示可能出现了、但消息还是发出去了。
 * 所以这里必须同时断言：① 提示出现在面板上；② 再点发送时桥端**没有**收到新的 turn；
 * ③ 用户拿到的是可读的错误文案，不是一句空白。
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
    // 一轮跑完后 loadThreads 会重渲染输入框，把刚敲进去的字刷回空值；
    // 所以敲完必须确认字还在，不在就重敲，不能直接按回车（那样会静默什么都不发）。
    for (let attempt = 0; attempt < 4; attempt += 1) {
        await composer.click();
        await page.keyboard.type(text);
        try {
            await expect(composer).toContainText(text, { timeout: 1_500 });
            break;
        } catch (error) {
            if (attempt === 3) throw error;
        }
    }
    await page.keyboard.press("Enter");
}

/**
 * 一轮跑完后面板要等 codex_state 非 busy 才解除禁用，
 * 这中间输入框是 contentEditable=false——此时 keyboard.type 会被静默丢弃。
 */
async function waitComposerIdle(page: Page) {
    // 面板在 sending/waiting 时把输入框设为 contentEditable=false，此时 keyboard.type 会被静默丢弃。
    await expect(page.locator(COMPOSER).first()).toBeEditable({ timeout: 20_000 });
    await page.waitForTimeout(300);
}

test.beforeEach(async ({ page }) => {
    await page.request.get(`${AGENT_URL}/__reset`);
    await page.addInitScript(() => localStorage.removeItem("canvasagents.agent.driver"));
});

test("额度耗尽后给出明确提示，并且不再把消息发给 Agent", async ({ page }) => {
    // 默认额度 400k token：这一轮直接回吐 400k，正好打光。
    await page.request.post(`${AGENT_URL}/__usage-config`, {
        data: { input_tokens: 400_000, cached_input_tokens: 0, output_tokens: 0 },
    });

    const turnRequests: string[] = [];
    page.on("request", (request) => {
        if (request.url().includes("/turn")) turnRequests.push(request.url());
    });

    await seedAndOpen(page);

    // 第一轮正常发出，回来的用量把额度打光。
    await send(page, "把首页标题改成蓝色");
    await expect(page.getByText(/mock codex reply/)).toBeVisible({ timeout: 20_000 });
    await waitComposerIdle(page);

    // ① 面板上出现明确提示，且说清是 token 额度而不是含糊的「出错了」。
    const banner = page.getByRole("status").filter({ hasText: /额度已用尽/ });
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText("Token");

    // ② 再发一条：被拦住，桥端收不到新的 turn。
    const before = ((await (await page.request.get(`${AGENT_URL}/__state`)).json()) as { turns: TurnRecord[] }).turns.length;
    await send(page, "再改一次标题");
    // 提示要落在 toast 上，不能只是页面上某处有这几个字。
    await expect(page.locator(".ant-message").getByText(/额度已用尽/)).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () => {
        const state = (await (await page.request.get(`${AGENT_URL}/__state`)).json()) as { turns: TurnRecord[] };
        return state.turns.length;
    }, { timeout: 5_000 }).toBe(before);
    expect(turnRequests).toHaveLength(1);

    // ③ 草稿没有被清掉——拦住的时候不能顺手把用户写的内容丢了。
    await expect(page.locator(COMPOSER).first()).toHaveText(/再改一次标题/);
});
