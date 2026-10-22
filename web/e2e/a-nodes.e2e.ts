import { expect, test, type Page } from "@playwright/test";

/**
 * A 组三类内容节点的 E2E（A1 Markdown / A2 网页预览 / A3 线框草图）。
 *
 * 判定原则与 delivery-m0 一致：创建出来不算完，必须「改内容 → 刷新 → 还在」。
 * 断言落在 data-* 钩子和真实 DOM 元素（h1/li/pre/rect/line）上，不依赖文案。
 *
 * 坐标系注意：创建节点会把画布视口带走（节点可能落在侧栏底下或视口外），
 * 所以每一步都先用侧栏的「定位到节点」把目标节点移到视口中央，再量几何。
 */

const AGENT_URL = "http://127.0.0.1:17399";
const AGENT_TOKEN = "e2e-token";

async function openFreshCanvas(page: Page) {
    await page.addInitScript(([url, token]) => {
        localStorage.setItem("canvas-agent-url", url);
        localStorage.setItem("canvas-agent-token", token);
    }, [AGENT_URL, AGENT_TOKEN]);
    await page.goto("/canvas?mode=new");
    await page.waitForURL(/\/canvas\//, { timeout: 30_000 });
    await expect(page.locator("main").first()).toBeVisible({ timeout: 30_000 });
    // 画布区是 main 里的 section：main 先出现，section 紧跟其后才挂载。
    await expect(page.locator("main > section")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(600);
}

/** 找一个既不在节点上、也不在侧栏上的空白点（双击它才会弹出创建菜单）。 */
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
    await expect(page.locator("[data-node-id]").last()).toBeVisible({ timeout: 10_000 });
    // 面板撑开后 canvas 会重排，等形态稳定再量。
    await page.waitForTimeout(600);
}

/** 点侧栏该节点行的「定位到节点」，把节点移到视口中央。 */
async function focusNode(page: Page, title: string) {
    const row = page.locator('button[title="定位到节点"]').filter({ hasText: title }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();
    // focusNode 是 450ms 缓动动画。
    await page.waitForTimeout(800);
}

async function reloadCanvas(page: Page) {
    // persist 是异步 localForage 写入，给一拍再刷新。
    await page.waitForTimeout(1000);
    await page.reload();
    await page.waitForURL(/\/canvas\//, { timeout: 30_000 });
}

test("A1 Markdown：输入标题/列表/代码块 → 提交 → 刷新后仍在", async ({ page }) => {
    await openFreshCanvas(page);
    await createFromMenu(page, "Markdown");
    await focusNode(page, "Markdown");

    const node = page.locator("[data-node-id]").first();
    await node.locator("[data-markdown-empty]").click();

    const textarea = node.locator("[data-markdown-textarea]");
    await expect(textarea).toBeVisible();
    await textarea.fill("# 改约规则\n\n- 提前 24 小时\n- 支持改期一次\n\n```ts\nconst rule = \"reschedule\";\n```\n");
    // Meta+Enter 走的是节点自己的 commit 路径（与失焦提交同一个函数）。
    await textarea.press("Meta+Enter");

    const preview = node.locator("[data-markdown-preview]");
    await expect(preview).toBeVisible();
    await expect(preview.locator("h1")).toHaveText("改约规则");
    await expect(preview.locator("li")).toHaveCount(2);
    await expect(preview.locator("pre").first()).toContainText("reschedule");

    await reloadCanvas(page);
    await focusNode(page, "Markdown");

    const reloaded = page.locator("[data-node-id]").first();
    const reloadedPreview = reloaded.locator("[data-markdown-preview]");
    await expect(reloadedPreview).toBeVisible({ timeout: 30_000 });
    await expect(reloadedPreview.locator("h1")).toHaveText("改约规则");
    await expect(reloadedPreview.locator("li")).toHaveCount(2);
    await expect(reloadedPreview.locator("pre").first()).toContainText("reschedule");
});

test("A3 线框草图：拖矩形 + 箭头 → 刷新后仍是 2 个图形，改尺寸不跑位", async ({ page }) => {
    await openFreshCanvas(page);
    await createFromMenu(page, "线框草图");
    await focusNode(page, "线框草图");

    const node = page.locator("[data-node-id]").first();
    const layer = node.locator("[data-sketch-layer]");
    await expect(layer).toBeVisible();
    const box = await layer.boundingBox();
    if (!box) throw new Error("草图图层没有尺寸");

    const drag = async (x1: number, y1: number, x2: number, y2: number) => {
        await page.mouse.move(x1, y1);
        await page.mouse.down();
        await page.mouse.move(x2, y2, { steps: 12 });
        await page.mouse.up();
    };

    // 默认工具是矩形。
    await drag(box.x + box.width * 0.2, box.y + box.height * 0.2, box.x + box.width * 0.6, box.y + box.height * 0.5);
    await node.locator('[data-sketch-tool="arrow"]').click();
    await drag(box.x + box.width * 0.2, box.y + box.height * 0.75, box.x + box.width * 0.75, box.y + box.height * 0.75);

    await expect(node.locator("[data-sketch-layer] svg rect")).toHaveCount(1);
    await expect(node.locator("[data-sketch-layer] svg line")).toHaveCount(1);

    await reloadCanvas(page);
    await focusNode(page, "线框草图");

    const reloaded = page.locator("[data-node-id]").first();
    const reloadedLayer = reloaded.locator("[data-sketch-layer]");
    await expect(reloadedLayer.locator("svg rect")).toHaveCount(1, { timeout: 30_000 });
    await expect(reloadedLayer.locator("svg line")).toHaveCount(1);
    await expect(reloaded.locator("[data-sketch-empty]")).toHaveCount(0);

    // 改尺寸前后比较「图形相对图层」的位置/尺寸比例：归一化坐标不该跑位。
    const geometry = async () => {
        const layerBox = await reloadedLayer.boundingBox();
        const rectBox = await reloadedLayer.locator("svg rect").boundingBox();
        if (!layerBox || !rectBox) throw new Error("量不到草图几何");
        return {
            layer: layerBox,
            relX: (rectBox.x - layerBox.x) / layerBox.width,
            relY: (rectBox.y - layerBox.y) / layerBox.height,
            relW: rectBox.width / layerBox.width,
            relH: rectBox.height / layerBox.height,
        };
    };

    const before = await geometry();
    const nodeBox = await reloaded.boundingBox();
    if (!nodeBox) throw new Error("量不到节点尺寸");
    // 右下角 resize 把手中心正好在节点右下角（-14px 偏移 + size-7）。
    await page.mouse.move(nodeBox.x + nodeBox.width, nodeBox.y + nodeBox.height);
    await page.mouse.down();
    await page.mouse.move(nodeBox.x + nodeBox.width + 120, nodeBox.y + nodeBox.height + 80, { steps: 12 });
    await page.mouse.up();

    const after = await geometry();
    // 图层真的变大了，否则这条用例等于没测。
    expect(after.layer.width).toBeGreaterThan(before.layer.width + 60);
    expect(after.layer.height).toBeGreaterThan(before.layer.height + 40);

    const expected = { x: after.layer.x + before.relX * after.layer.width, y: after.layer.y + before.relY * after.layer.height };
    const actualRect = await reloadedLayer.locator("svg rect").boundingBox();
    if (!actualRect) throw new Error("改尺寸后量不到草图矩形");
    expect(Math.abs(actualRect.x - expected.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(actualRect.y - expected.y)).toBeLessThanOrEqual(2);
    expect(Math.abs(actualRect.width / after.layer.width - before.relW)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(actualRect.height / after.layer.height - before.relH)).toBeLessThanOrEqual(0.02);
});

test("A2 网页预览：填不可达地址 → 错误卡与重试按钮可见", async ({ page }) => {
    await openFreshCanvas(page);
    await createFromMenu(page, "网页预览");
    await focusNode(page, "网页预览");

    const node = page.locator("[data-node-id]").first();
    const input = node.locator("[data-preview-url-input]");
    await expect(input).toBeVisible();
    await input.fill("http://127.0.0.1:9/");
    await input.press("Enter");

    await expect(node.locator("[data-preview-error]")).toBeVisible({ timeout: 20_000 });
    await expect(node.locator("[data-preview-retry]")).toBeVisible();
    await expect(node.locator("[data-preview-empty]")).toHaveCount(0);
});
