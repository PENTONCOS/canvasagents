const { chromium } = require("playwright");

(async () => {
    const b = await chromium.launch({ channel: "chrome", headless: true });
    const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
    const errs = [];
    p.on("pageerror", (e) => errs.push(e.message));
    await p.goto("http://127.0.0.1:3100/canvas?mode=new", { waitUntil: "domcontentloaded", timeout: 40000 });
    await p.waitForURL(/\/canvas\//, { timeout: 30000 });
    await p.waitForTimeout(3500);

    const layout = await p.evaluate(() => {
        const main = document.querySelector("main");
        const r = main?.getBoundingClientRect();
        const asides = [...document.querySelectorAll("aside")].map((el) => {
            const b = el.getBoundingClientRect();
            return { x: Math.round(b.x), w: Math.round(b.width), label: el.getAttribute("aria-label") || "" };
        });
        return { main: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null, asides, vw: innerWidth };
    });
    console.log("layout", JSON.stringify(layout));

    await p.locator("main").first().dblclick({ position: { x: 400, y: 300 } });
    await p.waitForTimeout(1200);
    console.log("menu", await p.getByText("选择节点").count(), "errs", JSON.stringify(errs.slice(0, 2)));
    await p.screenshot({ path: "/tmp/m0-debug.png" });
    await b.close();
})();
