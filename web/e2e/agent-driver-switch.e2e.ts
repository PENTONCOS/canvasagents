import { expect, test, type Page } from "@playwright/test";

/**
 * M5 验收 1/2：同一面板在 codex 与 claude 之间切换。
 *
 * 判定原则：
 * ① 切换真的换了会话源——历史计数从 codex 的 2 条变成 claude 的 1 条，且面板确实向
 *    /agent/claude/threads 发了请求（不能只看界面文字，假 Agent 会记请求）；
 * ② 切换不丢窗口与画布绑定——会话窗 tab 数量与名称不变，画布仍在。
 *
 * 不点历史列表里的具体条目：那需要滚动容器可见，易受布局影响；
 * 计数徽章读的是同一份 threads 状态，等价且稳定。
 */

const AGENT_URL = "http://127.0.0.1:17399";
const AGENT_TOKEN = "e2e-token";

const WINDOW_TABS = '[role="tablist"][aria-label="会话窗"]';
const CONTENT_TABS = '[role="tablist"][aria-label="Agent 内容"]';
const HISTORY_TAB = () => "历史 (2)";
const CLAUDE_HISTORY_TAB = "历史 (1)";

async function panelInViewport(page: Page) {
    const width = page.viewportSize()?.width ?? 0;
    const box = await page.locator("aside").first().boundingBox();
    if (!box) return false;
    return box.x + box.width <= width + 2 && box.x < width - 40;
}

async function seedAndOpen(page: Page) {
    // 与 agent-sidebar 用例同一条「一键连接」路径：URL 带 agentUrl/agentToken 即自动连接。
    await page.goto(`/canvas?agentUrl=${encodeURIComponent(AGENT_URL)}&agentToken=${AGENT_TOKEN}`);
    await expect(page.locator(WINDOW_TABS)).toBeAttached({ timeout: 30_000 });
    // 面板默认收起（aside 落在视口右侧外），先点顶栏「打开 Agent」。
    const toggle = page.getByRole("button", { name: "打开 Agent", exact: true });
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    await toggle.click();
    await expect.poll(() => panelInViewport(page), { timeout: 15_000 }).toBe(true);
    await expect(page.getByRole("button", { name: /新\s*对\s*话/ })).toBeEnabled({ timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
    await page.request.get(`${AGENT_URL}/__reset`);
    await page.addInitScript(() => localStorage.removeItem("canvasagents.agent.driver"));
});

test("切到 claude 后会话源换成 claude 的线程，切回 codex 恢复且窗口不丢", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (request) => {
        if (request.url().includes("/agent/")) requests.push(request.url().replace(AGENT_URL, "").split("?")[0]);
    });

    await seedAndOpen(page);

    const windowsBefore = await page.locator(WINDOW_TABS).getByRole("tab").count();
    const activeTabBefore = await page.locator(WINDOW_TABS).getByRole("tab").first().innerText();

    // 基线：codex 有 2 条历史。
    await expect(page.locator(CONTENT_TABS).getByRole("tab", { name: HISTORY_TAB() })).toBeAttached({ timeout: 20_000 });

    const switcher = page.locator('[role="radiogroup"][aria-label="Agent 驱动"]');
    await expect(switcher).toBeVisible({ timeout: 10_000 });
    await switcher.getByText("Claude Code").click();

    // ① 会话源真的换了：计数变 1，且打到了 claude 的线程接口。
    await expect(page.locator(CONTENT_TABS).getByRole("tab", { name: CLAUDE_HISTORY_TAB })).toBeAttached({ timeout: 20_000 });
    expect(requests.some((url) => url.startsWith("/agent/claude/threads"))).toBe(true);

    // ② 窗口与画布绑定都没动。
    await expect(page.locator(WINDOW_TABS).getByRole("tab")).toHaveCount(windowsBefore);
    await expect(page.locator(WINDOW_TABS).getByRole("tab").first()).toHaveText(activeTabBefore);
    await expect(page.locator("main").first()).toBeVisible();

    // 切回 codex：原有 2 条历史能回来，不是被清空。
    await switcher.getByText("Codex", { exact: true }).click();
    await expect(page.locator(CONTENT_TABS).getByRole("tab", { name: HISTORY_TAB() })).toBeAttached({ timeout: 20_000 });

    // 两个 driver 的线程都没被删——切换只是换来源。
    const state = await (await page.request.get(`${AGENT_URL}/__state`)).json() as { threads: string[]; claudeThreads: string[] };
    expect(state.threads).toContain("thread-a");
    expect(state.claudeThreads).toContain("claude-thread-1");
});
