import { expect, test, type Page } from "@playwright/test";

/**
 * C4 多张截图合成一张高清图再投喂。
 *
 * 判定原则（不接受「按钮点得动」）：
 * 1) 预览里「【图片】」只剩一行摘要，且写明张数 / 列×行 / 实际像素；
 * 2) 合成图是真的按版式画出来的——把预览里那张图读回来，naturalWidth/Height
 *    必须等于「纯函数版式 × 导出倍数」算出的值（不是前端自己报的数）；
 * 3) 发出去的提示词里是这行摘要，不再是 N 条并列的图片条目。
 *
 * 两张图的原始尺寸刻意不等（40×20 / 20×40）：等比缩放 + 行高取最高才有意义，
 * 全用正方形的话版式写错了也看不出来。
 */

const PIXEL_40x20 =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAIAAABwJOjsAAAAJElEQVR42mO4o6ExIIhh1OJRi0ctHrV41OJRi0ctHrV45FgMAGbCqa5Wls8rAAAAAElFTkSuQmCC";
const PIXEL_20x40 =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAoCAIAAABxU02MAAAAJElEQVR42mPQiLpDNmIY1TyqeVTzqOZRzaOaRzWPah7VTC4CAG9dRf02rCuIAAAAAElFTkSuQmCC";

const AGENT_URL = "http://127.0.0.1:17399";
const AGENT_TOKEN = "e2e-token";
const WINDOW_TABS = '[role="tablist"][aria-label="会话窗"]';

/** 与 compose-layout 的常量保持一致：留白 16、间距 16、列宽取最大原始宽度。 */
const PADDING = 16;
const GAP = 16;

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
    await page.waitForTimeout(1200);
}

/** 图片节点没法走上传，直接按产品的存储格式种两个（与 delivery-m3 同一套做法）。 */
async function seedImages(page: Page) {
    const projectId = new URL(page.url()).pathname.split("/").filter(Boolean).pop() || "";
    await page.evaluate(
        async ({ projectId, wide, tall }) => {
            const openDb = () =>
                new Promise<IDBDatabase>((resolve, reject) => {
                    const request = indexedDB.open("canvasagents");
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
            const db = await openDb();
            const read = (key: string) =>
                new Promise<string | null>((resolve, reject) => {
                    const store = db.transaction("app_state", "readonly").objectStore("app_state");
                    const request = store.get(key);
                    request.onsuccess = () => resolve((request.result as string) ?? null);
                    request.onerror = () => reject(request.error);
                });
            const write = (key: string, value: string) =>
                new Promise<void>((resolve, reject) => {
                    const tx = db.transaction("app_state", "readwrite");
                    tx.objectStore("app_state").put(value, key);
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => reject(tx.error);
                });

            const rawCanvas = await read("canvasagents:canvas_store");
            if (!rawCanvas) throw new Error("canvas store not persisted yet");
            const canvas = JSON.parse(rawCanvas) as { state: { projects: Array<{ id: string; nodes: unknown[]; connections?: unknown[] }> } };
            const project = canvas.state.projects.find((item) => item.id === projectId);
            if (!project) throw new Error(`project ${projectId} not found`);
            project.nodes = [
                {
                    id: "image-c4-wide",
                    type: "image",
                    title: "改约前",
                    position: { x: 200, y: 200 },
                    width: 360,
                    height: 240,
                    metadata: { content: wide, status: "success", naturalWidth: 40, naturalHeight: 20, mimeType: "image/png" },
                },
                {
                    id: "image-c4-tall",
                    type: "image",
                    title: "改约后",
                    position: { x: 620, y: 200 },
                    width: 240,
                    height: 360,
                    metadata: { content: tall, status: "success", naturalWidth: 20, naturalHeight: 40, mimeType: "image/png" },
                },
            ];
            project.connections = [];
            await write("canvasagents:canvas_store", JSON.stringify(canvas));
        },
        { projectId, wide: PIXEL_40x20, tall: PIXEL_20x40 },
    );
    await page.reload();
    await expect(page.locator("main > section")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-node-id="image-c4-wide"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-node-id="image-c4-tall"]')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(600);
}

/** 版式算术的独立实现：列宽取最大原始宽度，行高取该行最高，四周留白、行间间距。 */
function expectedSize(sizes: { width: number; height: number }[]) {
    const cols = Math.ceil(Math.sqrt(sizes.length));
    const rows = Math.ceil(sizes.length / cols);
    const columnWidth = Math.max(...sizes.map((size) => size.width));
    const scaled = sizes.map((size) => ({ width: columnWidth, height: Math.max(1, Math.round((size.height * columnWidth) / size.width)) }));
    const rowHeights = Array.from({ length: rows }, (_, row) => Math.max(...scaled.slice(row * cols, row * cols + cols).map((item) => item.height)));
    return {
        cols,
        rows,
        width: PADDING * 2 + cols * columnWidth + Math.max(0, cols - 1) * GAP,
        height: PADDING * 2 + rowHeights.reduce((sum, height) => sum + height, 0) + Math.max(0, rows - 1) * GAP,
    };
}

async function agentState(page: Page) {
    const response = await page.request.get(`${AGENT_URL}/__state`);
    return response.json() as Promise<{ turns: { text: string }[] }>;
}

test("C4 截图合成：多张合一张、像素对得上版式、投喂只进一条图片", async ({ page }) => {
    test.setTimeout(240_000);
    await page.request.get(`${AGENT_URL}/__reset`);
    await openFreshCanvas(page);
    await seedImages(page);

    const expected = expectedSize([
        { width: 40, height: 20 },
        { width: 20, height: 40 },
    ]);
    // dpr=1 → 导出倍数 2（至少 2x）。
    const scale = 2;

    // 1) 选中两张图 → 投喂工具条 → 预览层。
    const section = page.locator("main > section");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Meta+a");
    const feedButton = page.getByRole("button", { name: "把选中的内容连同圈注截图一次交给 Agent" }).first();
    await expect(feedButton).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(WINDOW_TABS)).toBeAttached({ timeout: 15_000 });
    const targetLabel = (await page.locator(WINDOW_TABS).getByRole("tab").first().innerText()).trim();
    await feedButton.click();
    const targetItem = page.locator(".ant-dropdown").getByText(targetLabel, { exact: true }).first();
    await expect(targetItem).toBeVisible({ timeout: 10_000 });
    await targetItem.click();

    const dialog = page.locator("[data-feed-preview]");
    const textarea = page.locator("[data-feed-preview-text]");
    await expect(textarea).toBeVisible({ timeout: 20_000 });

    // 2) 提示词里只剩一行图片摘要：张数 / 列×行 / 实际像素都要对。
    const draft = await textarea.inputValue();
    expect(draft).toContain("【图片】");
    const imageLines = draft.split("\n").filter((line) => line.startsWith("- ") && line.includes("张截图合成"));
    expect(imageLines).toHaveLength(1);
    expect(imageLines[0]).toContain("2 张截图合成 1 张");
    expect(imageLines[0]).toContain(`${expected.cols} 列 × ${expected.rows} 行`);
    expect(imageLines[0]).toContain(`${expected.width * scale}×${expected.height * scale}`);
    // 逐条列出的旧形态必须消失，否则说明只是「多了一行摘要」而不是真的合并。
    expect(draft).not.toContain("改约前（");
    expect(draft).not.toContain("改约后（");

    // 3) 预览里的合成图是真实 PNG：像素必须等于版式 × 倍数，不是前端报的数。
    const composed = page.locator("[data-feed-composed]");
    await expect(composed).toBeVisible({ timeout: 20_000 });
    const real = await composed.evaluate(async (img: HTMLImageElement) => {
        await img.decode();
        return { width: img.naturalWidth, height: img.naturalHeight, src: img.src.slice(0, 22) };
    });
    expect(real.src).toBe("data:image/png;base64,");
    expect(real.width).toBe(expected.width * scale);
    expect(real.height).toBe(expected.height * scale);

    // 4) 发送：服务端收到的就是这行摘要，且没有逐张图片条目。
    await page.locator("[data-feed-preview-send]").click();
    await expect.poll(async () => (await agentState(page)).turns.length, { timeout: 30_000 }).toBe(1);
    const sent = (await agentState(page)).turns[0].text;
    expect(sent).toContain("2 张截图合成 1 张");
    expect(sent).toContain(`${expected.width * scale}×${expected.height * scale}`);
    expect(sent).not.toContain("改约前（");
});
