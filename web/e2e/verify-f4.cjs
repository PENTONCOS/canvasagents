const { chromium } = require("playwright");

const BASE = process.argv[2] || "https://canvasagents.surge.sh";

(async () => {
    const b = await chromium.launch({ channel: "chrome", headless: true });
    const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
    const errs = [];
    p.on("pageerror", (e) => errs.push(e.message));
    const step = (name) => console.log("STEP", name);

    step("open list");
    await p.goto(`${BASE}/canvas`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await p.waitForSelector("nav", { timeout: 40000 });
    await p.waitForTimeout(2000);

    step("load demo");
    const demo = p.getByText("载入示例项目").first();
    if (await demo.count()) {
        await demo.click({ timeout: 20000 });
        await p.waitForURL(/\/canvas\/[^?]+$/, { timeout: 40000 }).catch(() => {});
        await p.waitForTimeout(2500);
    }
    const nodesTotal = await p.evaluate(() => /画布元素\s*(\d+)/.exec(document.body.innerText)?.[1] ?? "?");
    console.log("demo nodes", nodesTotal);

    step("back to list + favorite");
    await p.goto(`${BASE}/canvas`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await p.waitForSelector("nav", { timeout: 40000 });
    await p.waitForTimeout(1500);
    const railBefore = (await p.locator("nav").first().innerText()).replace(/\s+/g, " ");
    const star = p.getByRole("button", { name: "收藏项目" }).first();
    const starCount = await star.count();
    if (starCount) {
        await star.click({ force: true, timeout: 10000 }).catch((e) => console.log("star err", e.message.slice(0, 60)));
        await p.waitForTimeout(1000);
    }
    const railAfter = (await p.locator("nav").first().innerText()).replace(/\s+/g, " ");
    console.log("starCount", starCount);
    console.log("railBefore", railBefore.slice(0, 100));
    console.log("railAfter", railAfter.slice(0, 140));

    step("open project + create doc node");
    await p.locator("nav").getByRole("button").filter({ hasText: "待办" }).first().click({ timeout: 20000 }).catch(async () => {
        await p.locator("nav button").nth(4).click({ timeout: 20000 });
    });
    await p.waitForURL(/\/canvas\//, { timeout: 40000 });
    await p.waitForTimeout(3000);
    const box = await p.locator("main").first().boundingBox();
    await p.locator("main").first().dblclick({ position: { x: Math.round((box?.width ?? 900) * 0.55), y: Math.round((box?.height ?? 600) * 0.45) } });
    await p.waitForTimeout(1200);
    const hasDoc = await p.getByText("分节文档").count();
    console.log("menu has doc", hasDoc);
    if (hasDoc) {
        await p.getByText("分节文档").first().click();
        await p.waitForTimeout(1800);
        const start = p.getByRole("button", { name: "开始写" }).first();
        if (await start.count()) {
            await start.click();
            await p.waitForTimeout(500);
            await p.locator("textarea").first().fill("## 背景\n门店预约需要改期\n\n## 方案\n复用改期接口");
            await p.getByRole("button", { name: "完成" }).first().click();
            await p.waitForTimeout(1000);
        }
    }
    const outline = await p.getByText("目录").count();
    const bg = await p.getByText("背景").count();
    const plan = await p.getByText("方案").count();
    console.log(JSON.stringify({ outline, bg, plan, nodes: await p.locator("[data-node-id]").count(), errs: errs.slice(0, 2) }));
    await p.screenshot({ path: "/Users/cospeyton/sisyphus-output/evidence/doc-node-20261102.png" });
    await b.close();
})();
