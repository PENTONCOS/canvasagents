import { chromium } from "playwright";

const url = process.argv[2] || "https://canvasagents.surge.sh/";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}\n${(e.stack || "").split("\n").slice(0, 6).join("\n")}`));
page.on("requestfailed", (r) => logs.push(`[requestfailed] ${r.url()} :: ${r.failure()?.errorText}`));
page.on("response", (r) => {
    if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`);
});

const t0 = Date.now();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => logs.push(`[goto] ${e.message}`));
const domContent = Date.now() - t0;

let rootHtml = "";
let rootChildren = -1;
try {
    await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0, { timeout: 30000 });
} catch { logs.push("[wait] root 仍为空 (30s)"); }
rootChildren = await page.evaluate(() => document.getElementById("root")?.childElementCount ?? -1);
rootHtml = (await page.evaluate(() => document.getElementById("root")?.innerHTML ?? "")).slice(0, 600);
const loaded = Date.now() - t0;

const perf = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    return nav ? { domContentLoaded: Math.round(nav.domContentLoadedEventEnd), loadEvent: Math.round(nav.loadEventEnd), transferSize: Math.round(nav.transferSize) } : null;
});

console.log(JSON.stringify({ url, domContent, renderedAfter: loaded, rootChildren, perf, rootHtmlHead: rootHtml.slice(0, 300) }, null, 2));
console.log("---- logs ----");
console.log(logs.slice(0, 40).join("\n") || "(none)");
await page.screenshot({ path: "/tmp/live-shot.png", fullPage: false }).catch(() => {});
await browser.close();
