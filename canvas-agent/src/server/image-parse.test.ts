import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// 隔离 HOME 后再动态导入：config.js 在模块加载期就会用 os.homedir() 计算配置路径，
// 否则测试会覆盖真实用户的 ~/.canvasagents/canvas-agent.json。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-image-parse-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.CANVAS_IMAGE_PARSE_TIMEOUT_MS = "500";

const { startHttpServer } = await import("./http.js");

const TOKEN = "test-token-image-parse";
type Bridge = { port: number; url: string; close: () => Promise<void> };

/** 取一个当前空闲的本地端口（listen 0 后立刻释放）。 */
function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const address = probe.address();
            const port = typeof address === "object" && address ? address.port : 0;
            probe.close(() => port ? resolve(port) : reject(new Error("no free port")));
        });
    });
}

/** 写隔离 HOME 下的配置并启动桥，返回端口与关闭函数。 */
async function startBridge(imageParseUrl: string): Promise<Bridge> {
    const port = await freePort();
    process.env.PORT = String(port);
    const configDir = path.join(tmpHome, ".canvasagents");
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(configDir, "canvas-agent.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, token: TOKEN, imageParseUrl }), { mode: 0o600 });
    const server = startHttpServer({ skipVersionCheck: true });
    const url = `http://127.0.0.1:${port}`;
    await waitForHealth(url);
    return { port, url, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** 轮询 /health 直到桥开始监听。 */
async function waitForHealth(url: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            const response = await fetch(`${url}/health`);
            if (response.ok) return;
        } catch {
            // 尚未监听，继续等待。
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`bridge did not start: ${url}`);
}

/** 假上游：按请求体里的 mode 切换行为，并记录收到的原始字节。 */
function startFakeUpstream() {
    const received: Array<{ url: string; method: string; contentType: string; body: Buffer }> = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = Buffer.concat(chunks);
            received.push({ url: req.url || "", method: req.method || "", contentType: String(req.headers["content-type"] || ""), body });
            if ((req.url || "") === "/health") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end('{"ok":true,"engine":"vision","version":"0.1.0"}');
                return;
            }
            let mode = "ok";
            try {
                mode = String((JSON.parse(body.toString("utf8")) as { mode?: unknown }).mode || "ok");
            } catch {
                mode = "ok";
            }
            if (mode === "slow") {
                setTimeout(() => {
                    if (res.writableEnded || res.destroyed) return;
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end('{"ok":true}');
                }, 1_500);
                return;
            }
            if (mode === "error") {
                res.writeHead(500, { "content-type": "text/plain" });
                res.end("upstream boom");
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, echo: body.toString("utf8"), bytes: body.length }));
        });
    });
    return new Promise<{ url: string; received: typeof received; close: () => Promise<void> }>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            resolve({ url: `http://127.0.0.1:${port}`, received, close: () => new Promise((done) => server.close(() => done())) });
        });
    });
}

test("POST /image/parse 原样透传请求体并原样返回上游 JSON", async () => {
    const upstream = await startFakeUpstream();
    const bridge = await startBridge(upstream.url);
    try {
        const bodyText = JSON.stringify({ path: "/tmp/sample.png", options: { lang: "zh-Hans", maxRegions: 8 } });
        const response = await fetch(`${bridge.url}/image/parse`, { method: "POST", headers: { "content-type": "application/json", "x-canvas-agent-token": TOKEN }, body: bodyText });
        assert.equal(response.status, 200);
        assert.match(String(response.headers.get("content-type")), /application\/json/);
        const payload = (await response.json()) as { ok: boolean; echo: string; bytes: number };
        assert.equal(payload.ok, true);
        // 上游收到的字节必须与网页发出的完全一致（未被桥改写）。
        assert.equal(payload.echo, bodyText);
        assert.equal(payload.bytes, Buffer.byteLength(bodyText));
        const last = upstream.received.at(-1);
        assert.equal(last?.method, "POST");
        assert.equal(last?.url, "/parse");
        assert.equal(last?.body.toString("utf8"), bodyText);
        assert.match(last?.contentType || "", /application\/json/);
    } finally {
        await bridge.close();
        await upstream.close();
    }
});

test("GET /image/health 透传上游 /health", async () => {
    const upstream = await startFakeUpstream();
    const bridge = await startBridge(upstream.url);
    try {
        const response = await fetch(`${bridge.url}/image/health`, { headers: { "x-canvas-agent-token": TOKEN } });
        assert.equal(response.status, 200);
        const payload = (await response.json()) as { ok: boolean; engine: string; version: string };
        assert.deepEqual(payload, { ok: true, engine: "vision", version: "0.1.0" });
        assert.equal(upstream.received.at(-1)?.url, "/health");
    } finally {
        await bridge.close();
        await upstream.close();
    }
});

test("GET /health 额外回吐 imageParseUrl", async () => {
    const upstream = await startFakeUpstream();
    const bridge = await startBridge(upstream.url);
    try {
        const response = await fetch(`${bridge.url}/health`);
        assert.equal(response.status, 200);
        const payload = (await response.json()) as { ok: boolean; imageParseUrl: string };
        assert.equal(payload.ok, true);
        assert.equal(payload.imageParseUrl, upstream.url);
        // /health 不回吐上游状态时也不应触发上游调用。
        assert.equal(upstream.received.length, 0);
    } finally {
        await bridge.close();
        await upstream.close();
    }
});

test("上游非 2xx → 502 且带截断后的上游响应文本", async () => {
    const upstream = await startFakeUpstream();
    const bridge = await startBridge(upstream.url);
    try {
        const response = await fetch(`${bridge.url}/image/parse`, { method: "POST", headers: { "content-type": "application/json", "x-canvas-agent-token": TOKEN }, body: JSON.stringify({ mode: "error" }) });
        assert.equal(response.status, 502);
        const payload = (await response.json()) as { ok: boolean; error: string };
        assert.equal(payload.ok, false);
        assert.match(payload.error, /upstream boom/);
    } finally {
        await bridge.close();
        await upstream.close();
    }
});

test("上游超时 → 502", async () => {
    const upstream = await startFakeUpstream();
    const bridge = await startBridge(upstream.url);
    try {
        const response = await fetch(`${bridge.url}/image/parse`, { method: "POST", headers: { "content-type": "application/json", "x-canvas-agent-token": TOKEN }, body: JSON.stringify({ mode: "slow" }) });
        assert.equal(response.status, 502);
        const payload = (await response.json()) as { ok: boolean; error: string };
        assert.equal(payload.ok, false);
        assert.match(payload.error, /超时/);
    } finally {
        await bridge.close();
        await upstream.close();
    }
});

test("上游连接拒绝 → 502", async () => {
    const deadPort = await freePort();
    const bridge = await startBridge(`http://127.0.0.1:${deadPort}`);
    try {
        const parseResponse = await fetch(`${bridge.url}/image/parse`, { method: "POST", headers: { "content-type": "application/json", "x-canvas-agent-token": TOKEN }, body: "{}" });
        assert.equal(parseResponse.status, 502);
        const parsePayload = (await parseResponse.json()) as { ok: boolean; error: string };
        assert.equal(parsePayload.ok, false);
        assert.match(parsePayload.error, /不可达/);
        const healthResponse = await fetch(`${bridge.url}/image/health`, { headers: { "x-canvas-agent-token": TOKEN } });
        assert.equal(healthResponse.status, 502);
    } finally {
        await bridge.close();
    }
});

test("token 错误 → 401", async () => {
    const upstream = await startFakeUpstream();
    const bridge = await startBridge(upstream.url);
    try {
        const parseResponse = await fetch(`${bridge.url}/image/parse`, { method: "POST", headers: { "content-type": "application/json", "x-canvas-agent-token": "wrong-token" }, body: "{}" });
        assert.equal(parseResponse.status, 401);
        const healthResponse = await fetch(`${bridge.url}/image/health`, { headers: { "x-canvas-agent-token": "wrong-token" } });
        assert.equal(healthResponse.status, 401);
        // 鉴权失败的请求不能触达上游。
        assert.equal(upstream.received.length, 0);
    } finally {
        await bridge.close();
        await upstream.close();
    }
});
