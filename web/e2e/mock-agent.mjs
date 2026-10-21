// E2E 用的假 Agent 端：只实现面板会打到的那几个接口。
// 目的不是复刻真 Agent，而是让前端能进入「已连接 + 有两条历史」的状态，
// 从而验证点击是否真的发出请求（删除这类动作必须看到服务端收到才算过）。
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_AGENT_PORT || 17399);
const TOKEN = process.env.MOCK_AGENT_TOKEN || "e2e-token";

let deleted = [];
let threads = [
    { id: "thread-a", preview: "@图片1 把这张图变为蓝色调的，同明度…", name: "蓝色调改图", createdAt: 1789000000, updatedAt: 1789100000 },
    { id: "thread-b", preview: "@图片1 把这张图变为蓝色调的，同明度…", name: "第二次尝试", createdAt: 1788000000, updatedAt: 1788100000 },
];

function cors(res) {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
}

function json(res, body, status = 200) {
    const text = JSON.stringify(body);
    cors(res);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
}

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
}

const conversation = () => ({ revision: 1, conversationId: "conv-e2e", threadId: currentThread(), status: "ready", mcpStatuses: {} });
const currentThread = () => threads[0]?.id || "";

const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
        cors(res);
        res.writeHead(204);
        return res.end();
    }

    // 测试辅助：断言服务端到底收到了什么
    if (path === "/__state") return json(res, { deleted, threads: threads.map((item) => item.id) });
    if (path === "/__reset") {
        deleted = [];
        threads = [
            { id: "thread-a", preview: "@图片1 把这张图变为蓝色调的，同明度…", name: "蓝色调改图", createdAt: 1789000000, updatedAt: 1789100000 },
            { id: "thread-b", preview: "@图片1 把这张图变为蓝色调的，同明度…", name: "第二次尝试", createdAt: 1788000000, updatedAt: 1788100000 },
        ];
        return json(res, { ok: true });
    }

    // SSE：握手后发 hello。协议版本必须与前端常量一致（当前 6）。
    if (path === "/events") {
        cors(res);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const hello = {
            protocolVersion: 6,
            conversation: conversation(),
            workspace: { activeThreadId: currentThread(), cwd: "/tmp/e2e-workspace", branches: [] },
            codex: { busy: false, threadId: currentThread(), turnId: "" },
            pendingApprovals: [],
        };
        res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
        const keepAlive = setInterval(() => res.write(": ping\n\n"), 15000);
        req.on("close", () => clearInterval(keepAlive));
        return;
    }

    if (path === "/agent/codex/threads" && req.method === "GET") {
        return json(res, {
            data: threads,
            conversation: conversation(),
            workspace: { activeThreadId: currentThread(), cwd: "/tmp/e2e-workspace" },
        });
    }

    const deleteMatch = path.match(/^\/agent\/codex\/threads\/([^/]+)\/delete$/);
    if (deleteMatch && req.method === "POST") {
        const threadId = decodeURIComponent(deleteMatch[1]);
        await readBody(req);
        deleted.push(threadId);
        threads = threads.filter((item) => item.id !== threadId);
        return json(res, { ok: true });
    }

    if (path === "/agent/codex/threads/reset") {
        await readBody(req);
        return json(res, { conversation: conversation() });
    }

    const threadMatch = path.match(/^\/agent\/codex\/threads\/([^/]+)$/);
    if (threadMatch && req.method === "GET") {
        return json(res, { thread: { id: decodeURIComponent(threadMatch[1]), turns: [] }, conversation: conversation() });
    }

    if (path === "/agent/codex/models") return json(res, { models: [] });
    if (path === "/agent/codex/skills") return json(res, { skills: [] });
    if (path === "/agent/queue") return json(res, { items: [] });
    if (path === "/agent/wall") return json(res, { items: [] });
    if (path === "/agent/codex/history/ack") return json(res, { ok: true });
    if (path === "/health") return json(res, { ok: true, protocolVersion: 6 });

    await readBody(req).catch(() => "");
    return json(res, { ok: true });
});

server.listen(PORT, "127.0.0.1", () => {
    console.log(`[mock-agent] listening on http://127.0.0.1:${PORT} token=${TOKEN}`);
});
