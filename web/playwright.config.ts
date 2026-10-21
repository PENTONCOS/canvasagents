import { defineConfig } from "@playwright/test";

/**
 * E2E 跑在真实的 Chrome 上（用系统安装的 Chrome，不额外下载浏览器），
 * 旁边挂一个假 Agent 服务，用来验证「点击 → 发出请求 → 界面变化」这条链路。
 */
export default defineConfig({
    testDir: "./e2e",
    testMatch: /.*\.e2e\.ts/,
    timeout: 45_000,
    expect: { timeout: 10_000 },
    fullyParallel: false,
    workers: 1,
    reporter: [["list"]],
    use: {
        baseURL: "http://127.0.0.1:3100",
        channel: "chrome",
        headless: true,
        actionTimeout: 15_000,
        trace: "retain-on-failure",
    },
    webServer: [
        {
            command: "node e2e/mock-agent.mjs",
            url: "http://127.0.0.1:17399/health",
            reuseExistingServer: true,
            timeout: 30_000,
        },
        {
            command: "npx vite --host 127.0.0.1 --port 3100 --strictPort",
            url: "http://127.0.0.1:3100",
            reuseExistingServer: true,
            timeout: 180_000,
        },
    ],
});
