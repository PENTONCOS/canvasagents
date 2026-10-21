import { expect, test, type Page } from "@playwright/test";

/**
 * 交付域 M3 E2E：截图圈注 → 问题单。
 *
 * 图片节点需要真实内容才能出圈注层，E2E 没法走上传流程，所以直接往
 * 本地持久化里种一个图片节点 + 一条圈注（走 IndexedDB，和产品同一套存储），
 * 再验证「按钮出现 → 点一下出 BUG-01 → 刷新后仍在」。
 */

const PIXEL_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function openFreshCanvas(page: Page) {
    await page.goto("/canvas?mode=new");
    await page.waitForURL(/\/canvas\//, { timeout: 30_000 });
    await expect(page.locator("main").first()).toBeVisible({ timeout: 30_000 });
}

type SeedNode = { id: string; type: string; title: string; position: { x: number; y: number }; width: number; height: number; metadata: Record<string, unknown> };

async function seedImageNodeWithAnnotation(page: Page, nodeId: string, annotationId: string) {
    // 项目创建后画布 store 有 400ms 防抖，等它落盘再改，否则会被覆盖。
    await page.waitForTimeout(1200);
    const projectId = new URL(page.url()).pathname.split("/").filter(Boolean).pop() || "";
    const node: SeedNode = {
        id: nodeId,
        type: "image",
        title: "预发布截图",
        position: { x: 320, y: 240 },
        width: 360,
        height: 240,
        metadata: { content: PIXEL_PNG, status: "success", naturalWidth: 1, naturalHeight: 1, mimeType: "image/png" },
    };
    await page.evaluate(
        async ({ projectId, node, annotationId }) => {
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
            const canvas = JSON.parse(rawCanvas) as { state: { projects: Array<{ id: string; nodes: unknown[] }> }; version?: number };
            const project = canvas.state.projects.find((item) => item.id === projectId);
            if (!project) throw new Error(`project ${projectId} not found`);
            project.nodes = [node];
            await write("canvasagents:canvas_store", JSON.stringify(canvas));

            const annotation = {
                id: annotationId,
                nodeId: node.id,
                shape: "rect",
                from: { x: 0.1, y: 0.2 },
                to: { x: 0.5, y: 0.6 },
                label: 1,
                acId: "AC-01",
                createdAt: Date.now(),
            };
            const rawDelivery = await read("delivery-store");
            const delivery = rawDelivery
                ? (JSON.parse(rawDelivery) as { state: Record<string, unknown>; version?: number })
                : { state: {}, version: 3 };
            delivery.state = {
                journeys: {},
                steps: {},
                designs: {},
                acceptance: {
                    "AC-01": { id: "AC-01", statement: "登录后进入首页", journeyIds: [], stepIds: [], testCaseIds: [], status: "ready" },
                },
                testCases: {},
                bugs: {},
                runs: {},
                environments: {},
                annotations: { [annotationId]: annotation },
                ...delivery.state,
                annotations: { [annotationId]: annotation },
            };
            await write("delivery-store", JSON.stringify(delivery));
        },
        { projectId, node, annotationId },
    );
    await page.reload();
    await page.waitForURL(/\/canvas\//, { timeout: 30_000 });
}

test("截图圈注 → 生成问题单，刷新后仍在", async ({ page }) => {
    await openFreshCanvas(page);
    await seedImageNodeWithAnnotation(page, "image-seed-1", "AN-01");

    const imageNode = page.locator('[data-node-id="image-seed-1"]');
    await expect(imageNode).toBeVisible({ timeout: 30_000 });

    // 圈注存在时才出这个按钮（否则说明圈注数据没 hydrate 上）。
    const createBug = page.locator("[data-create-bug-from-annotations]");
    await expect(createBug).toBeVisible({ timeout: 15_000 });
    await createBug.click({ force: true });

    // 图片节点 + 新建的问题单节点。
    await expect(page.locator("[data-node-id]")).toHaveCount(2, { timeout: 15_000 });
    await expect(page.getByText("BUG-01").first()).toBeVisible({ timeout: 15_000 });

    // 持久化：刷新后问题单还在，说明实体与节点都写进存储了。
    await page.waitForTimeout(1200);
    await page.reload();
    await page.waitForURL(/\/canvas\//, { timeout: 30_000 });
    await expect(page.locator("[data-node-id]")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByText("BUG-01").first()).toBeVisible({ timeout: 30_000 });
});
