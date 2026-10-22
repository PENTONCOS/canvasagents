import { expect, test, type Page } from "@playwright/test";

/**
 * B3 多窗并行 E2E。
 *
 * 判定原则：并行不是「点得快」，而是服务端真的同时有两条 turn 在飞。
 * ① 第一个 turn 还没结束就发第二个，两个 turn 的时间区间必须真实重叠（`/__state` 的
 *    startedAt/finishedAt 交错，且 maxInflight ≥ 2）——串行实现过不了这条；
 * ② 两窗各收各的回复，A 窗看不到 B 窗的回话（跨窗污染回归点）；
 * ③ 跑动中两窗状态都可见（tab 上有文字 + data-status，不只靠颜色）；
 * ④ 停 A 窗不影响 B 窗把回复收完。
 */

const AGENT_URL = "http://127.0.0.1:17399";
const AGENT_TOKEN = "e2e-token";

const WINDOW_TABS = '[role="tablist"][aria-label="会话窗"]';
const COMPOSER = '[role="textbox"][aria-label*="询问"]';

type TurnRecord = {
    driver: string;
    threadId: string;
    turnId: string;
    text: string;
    startedAt: number;
    finishedAt: number | null;
    status: string;
};

type AgentState = { turns: TurnRecord[]; inflight: number; maxInflight: number };

async function agentState(page: Page): Promise<AgentState> {
    return (await (await page.request.get(`${AGENT_URL}/__state`)).json()) as AgentState;
}

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

async function composerValue(page: Page) {
    return await page.locator(COMPOSER).first().evaluate((el) => ((el as HTMLElement).textContent ?? "").trim());
}

/**
 * 切窗瞬间面板会重挂一次，点击可能落在正在被替换的节点上，焦点掉到 body，
 * 于是敲的字直接丢弃。先确认真实焦点已落在输入框，再打字。
 */
async function focusComposer(page: Page) {
    const composer = page.locator(COMPOSER).first();
    await expect(composer).toBeEditable({ timeout: 20_000 });
    for (let attempt = 0; attempt < 10; attempt += 1) {
        await composer.click();
        if (await composer.evaluate((el) => document.activeElement === el)) return;
        await page.waitForTimeout(150);
    }
    throw new Error("输入框拿不到焦点");
}

async function send(page: Page, text: string) {
    const composer = page.locator(COMPOSER).first();
    await focusComposer(page);
    await page.keyboard.type(text);
    if ((await composerValue(page)) !== text) {
        await focusComposer(page);
        await page.keyboard.press("Meta+A");
        await page.keyboard.press("Backspace");
        await page.keyboard.type(text);
    }
    // 硬断言：字确实在框里才回车，避免「空框回车」被当成发送成功。
    await expect.poll(() => composerValue(page), { timeout: 5_000 }).toBe(text);
    await page.keyboard.press("Enter");
    await expect.poll(() => composerValue(page), { timeout: 10_000 }).toBe("");
}

/** 只答应已经落库的 turn（按 threadId 找），避免把别的窗的轮次算进来。 */
async function turnsOf(page: Page, threadId: string) {
    return (await agentState(page)).turns.filter((turn) => turn.threadId === threadId);
}

test.use({ viewport: { width: 1600, height: 1100 } });

test("两窗并行：turn 时间区间重叠、各出各的回复、停 A 不影响 B", async ({ page }) => {
    test.setTimeout(150_000);
    await page.request.get(`${AGENT_URL}/__reset`);
    // 把一轮拉长，才能在第一个 turn 结束前发第二个（串行实现会因此露馅）。
    await page.request.post(`${AGENT_URL}/__turn-config`, { data: { delayMs: 4000 } });
    await page.addInitScript(() => localStorage.removeItem("canvasagents.agent.driver"));

    await seedAndOpen(page);

    const windowTabs = page.locator(WINDOW_TABS);
    // 开第二个窗：走 tab 条上的真实入口，它会自己 threads/reset 建独立线程。
    await page.getByRole("button", { name: "新建会话窗", exact: true }).click();
    await expect(windowTabs.getByRole("tab")).toHaveCount(2, { timeout: 20_000 });
    const tabA = windowTabs.getByRole("tab").nth(0);
    const tabB = windowTabs.getByRole("tab").nth(1);
    await expect(tabB).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
    await expect(page.locator(COMPOSER).first()).toBeEditable({ timeout: 20_000 });

    // 1) A 窗先发；不等结束直接切到 B 窗发第二条。
    await tabA.click();
    await expect(tabA).toHaveAttribute("aria-selected", "true", { timeout: 10_000 });
    await send(page, "A 窗任务：把主色调成蓝色");

    // 运行中状态要看得见：有文字（运行中）+ data-status，不是只有转圈颜色。
    await expect.poll(() => tabA.getAttribute("data-status"), { timeout: 20_000 }).toBe("running");
    await expect(tabA.locator("[data-window-status-label]")).toHaveText("运行中");

    await tabB.click();
    await expect(tabB).toHaveAttribute("aria-selected", "true", { timeout: 10_000 });
    await send(page, "B 窗任务：重排首页栅格");

    await expect.poll(() => tabB.getAttribute("data-status"), { timeout: 20_000 }).toBe("running");
    // 关键回归点：切到 B 之后 A 仍在跑（后台窗状态不能被激活窗覆盖）。
    await expect(tabA).toHaveAttribute("data-status", "running");
    await expect(tabA.locator("[data-window-status-label]")).toHaveText("运行中");

    // 2) 两轮都落库后核对：不同线程 + 时间区间真实重叠 + 同时在飞的最大值。
    await expect.poll(async () => (await agentState(page)).turns.filter((turn) => turn.finishedAt !== null).length, { timeout: 30_000 }).toBe(2);
    const afterBoth = await agentState(page);
    const [first, second] = afterBoth.turns;
    expect(first.threadId).not.toBe(second.threadId);
    expect(first.startedAt).toBeLessThan(second.finishedAt!);
    expect(second.startedAt).toBeLessThan(first.finishedAt!);
    // 交叉判定：第二个 turn 在第一个结束之前就开始了 —— 串行实现必然不成立。
    expect(second.startedAt).toBeLessThan(first.finishedAt!);
    expect(afterBoth.maxInflight).toBeGreaterThanOrEqual(2);
    console.log(`[multi-window] maxInflight=${afterBoth.maxInflight} turns=${afterBoth.turns.length}`);

    // 3) 各收各的回复：A 窗只有 turn-1 的回话，B 窗只有 turn-2 的。
    await tabA.click();
    await expect(page.getByText("mock codex reply turn-1")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("mock codex reply turn-2")).toHaveCount(0);
    await tabB.click();
    await expect(page.getByText("mock codex reply turn-2")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("mock codex reply turn-1")).toHaveCount(0);

    // 4) 停 A 窗：B 窗的回复仍要收完。
    await tabA.click();
    await send(page, "A 窗长任务：慢慢调整");
    await expect.poll(() => tabA.getAttribute("data-status"), { timeout: 20_000 }).toBe("running");
    await tabB.click();
    await send(page, "B 窗长任务：慢慢排版");
    await expect.poll(() => tabB.getAttribute("data-status"), { timeout: 20_000 }).toBe("running");

    await tabA.click();
    const stopButton = page.getByRole("button", { name: "停止", exact: true }).first();
    await expect(stopButton).toBeVisible({ timeout: 15_000 });
    await stopButton.click();

    // A 窗被中断（服务端 status=interrupted），且 A 回到空闲。
    await expect.poll(async () => {
        const turns = await turnsOf(page, first.threadId);
        return turns.some((turn) => turn.status === "interrupted");
    }, { timeout: 20_000 }).toBe(true);
    await expect.poll(() => tabA.getAttribute("data-status"), { timeout: 20_000 }).toBe("idle");
    await expect(page.getByText("mock codex reply turn-3")).toHaveCount(0);

    // B 窗不受影响：回复照常渲染出来。
    await tabB.click();
    await expect(page.getByText("mock codex reply turn-4")).toBeVisible({ timeout: 25_000 });
    await expect.poll(() => tabB.getAttribute("data-status"), { timeout: 20_000 }).toBe("idle");

    const final = await agentState(page);
    expect(final.turns).toHaveLength(4);
    expect(final.turns[2].status).toBe("interrupted");
    expect(final.turns[3].status).toBe("done");
    expect(final.inflight).toBe(0);
});
