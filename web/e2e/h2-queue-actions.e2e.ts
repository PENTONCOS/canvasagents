import { expect, test, type Page } from "@playwright/test";

/**
 * H2「队列即入口」的端到端验证。
 *
 * 判定原则写死在这里：**只看 UI 变色不算通过**。
 * - 批准：必须看到假 Agent 的 /__state.approvals 真的收到 requestId + accept，
 *   并且那一条也真的从 pendingApprovals 里消失了；
 * - 继续：必须看到 /__state.turns 真的多了一轮、且落在被点的那条线程上。
 * 界面只是触发器，服务端没收到就等于没做成。
 */

const AGENT_URL = "http://127.0.0.1:17399";
const AGENT_TOKEN = "e2e-token";

const WINDOW_TABS = '[role="tablist"][aria-label="会话窗"]';

type ApprovalRecord = { requestId: string; decision: string; threadId: string };
type PendingApproval = { requestId: string; threadId: string; method: string; reason: string };
type TurnRecord = { driver: string; threadId: string; turnId: string; text: string; status: string };
type MockState = { approvals: ApprovalRecord[]; pendingApprovals: PendingApproval[]; turns: TurnRecord[] };

async function resetAgent(page: Page) {
    await page.request.get(`${AGENT_URL}/__reset`);
}

async function mockState(page: Page): Promise<MockState> {
    const response = await page.request.get(`${AGENT_URL}/__state`);
    return response.json() as Promise<MockState>;
}

/** 种一条待审批项：队列的「权限确认」态与 requestId 都来自它。 */
async function seedApproval(page: Page, input: { requestId: string; threadId: string; method?: string; reason?: string }) {
    await page.request.post(`${AGENT_URL}/__approval-seed`, { data: input });
}

/** 把某条线程做成「失败」态：只有失败/等输入才有「继续」。 */
async function seedThreadStatus(page: Page, threadId: string, status: string) {
    await page.request.post(`${AGENT_URL}/__queue-status`, { data: { threadId, status } });
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
    if (!(await panelInViewport(page))) {
        await page.getByRole("button", { name: /打开 Agent|打开助手/ }).first().click();
    }
    await expect.poll(() => panelInViewport(page), { timeout: 15_000 }).toBe(true);
    await expect(page.getByRole("button", { name: /新\s*对\s*话/ })).toBeEnabled({ timeout: 30_000 });
}

/** 队列是布局级弹窗，入口在 ⌘K 命令面板里（产品本身的唯一入口，不另开测试专用开关）。 */
async function openQueue(page: Page) {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
    const entry = page.getByRole("button", { name: "任务队列", exact: true });
    await expect(entry).toBeVisible({ timeout: 15_000 });
    await entry.click();
    await expect(page.locator("[data-queue-thread]").first()).toBeVisible({ timeout: 20_000 });
}

test.beforeEach(async ({ page }) => {
    await page.request.get(`${AGENT_URL}/__reset`);
});

test("队列里一键批准：桥端真的收到 accept，且该条不再 pending", async ({ page }) => {
    await seedApproval(page, { requestId: "req-a1", threadId: "thread-a", method: "shell", reason: "要执行 rm -rf build" });
    await seedAndOpen(page);
    await openQueue(page);

    const row = page.locator('[data-queue-thread="thread-a"]');
    await expect(row).toBeVisible();
    // 批准前：这一条必须是「权限确认」态，并且给了可点的批准按钮。
    await expect(row).toHaveAttribute("data-queue-status", "approval");
    const approve = page.locator('[data-queue-approve="thread-a"]');
    await expect(approve).toBeVisible();

    await approve.click();

    // ① 桥端收到决定：requestId 与 decision 都要对得上（不是随便一个 200）。
    await expect.poll(async () => (await mockState(page)).approvals.map((item) => `${item.requestId}:${item.decision}`), { timeout: 10_000 })
        .toContain("req-a1:accept");
    // ② 这一条真的不再挂着待审批。
    await expect.poll(async () => (await mockState(page)).pendingApprovals.map((item) => item.requestId), { timeout: 10_000 })
        .not.toContain("req-a1");
    // ③ 队列里那条也不该再显示「批准」（否则人还能对一件已处置的事再点一次）。
    await expect(page.locator('[data-queue-approve="thread-a"]')).toHaveCount(0, { timeout: 10_000 });
    // ④ 失败提示不能冒出来（批准是一键成功的低风险动作）。
    await expect(page.locator('[data-queue-error="thread-a"]')).toHaveCount(0);
});

test("队列里点继续：失败项真的重新起了一轮 turn", async ({ page }) => {
    await seedThreadStatus(page, "thread-b", "failed");
    await seedAndOpen(page);
    await openQueue(page);

    const row = page.locator('[data-queue-thread="thread-b"]');
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-queue-status", "failed");
    const before = (await mockState(page)).turns.filter((item) => item.threadId === "thread-b").length;

    const resume = page.locator('[data-queue-continue="thread-b"]');
    await expect(resume).toBeVisible();
    await resume.click();

    // 服务端证据：该线程真的多了一轮，而且是一轮有内容的 turn（不是空提交）。
    await expect.poll(async () => (await mockState(page)).turns.filter((item) => item.threadId === "thread-b").length, { timeout: 15_000 })
        .toBe(before + 1);
    const turns = (await mockState(page)).turns.filter((item) => item.threadId === "thread-b");
    expect(turns[turns.length - 1].text.trim().length).toBeGreaterThan(0);
    // 这一条随即转入 running（继续 = 重新动起来），「继续」按钮随之下线。
    await expect(row).toHaveAttribute("data-queue-status", "running", { timeout: 5_000 });
    await expect(page.locator('[data-queue-continue="thread-b"]')).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator('[data-queue-error="thread-b"]')).toHaveCount(0);
});
