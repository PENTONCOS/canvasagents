const { chromium } = require("playwright");

const BASE = process.argv[2] || "https://canvasagents.surge.sh";

(async () => {
    const b = await chromium.launch({ channel: "chrome", headless: true });
    const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
    p.on("pageerror", (e) => console.log("PAGEERROR", e.message));

    // 先造一个项目（示例），再回列表点星标
    await p.goto(`${BASE}/canvas`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await p.waitForSelector('nav[aria-label="待办"]', { timeout: 40000 });
    await p.waitForTimeout(1500);
    await p.getByText("载入示例项目").first().click({ timeout: 20000 });
    await p.waitForURL(/\/canvas\/[^?]+$/, { timeout: 40000 }).catch(() => {});
    await p.waitForTimeout(2500);

    await p.goto(`${BASE}/canvas`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await p.waitForSelector('nav[aria-label="待办"]', { timeout: 40000 });
    await p.waitForTimeout(1500);

    const rail = p.locator('nav[aria-label="待办"]');
    const before = (await rail.innerText()).replace(/\s+/g, " ");
    const star = rail.getByRole("button", { name: "收藏项目" }).first();
    const starCount = await star.count();
    if (starCount) await star.click({ force: true, timeout: 15000 });
    await p.waitForTimeout(1200);
    const after = (await rail.innerText()).replace(/\s+/g, " ");

    console.log(JSON.stringify({ starCount, before: before.slice(0, 160), after: after.slice(0, 200) }, null, 1));
    await p.screenshot({ path: "/Users/cospeyton/sisyphus-output/evidence/rail-favorites-20261102.png" });
    await b.close();
})();
