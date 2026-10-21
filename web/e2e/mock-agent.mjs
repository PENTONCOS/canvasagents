// E2E 用的假 Agent 端：只实现面板会打到的那几个接口。
// 目的不是复刻真 Agent，而是让前端能进入「已连接 + 有两条历史」的状态，
// 从而验证点击是否真的发出请求（删除这类动作必须看到服务端收到才算过）。
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_AGENT_PORT || 17399);
const TOKEN = process.env.MOCK_AGENT_TOKEN || "e2e-token";

let deleted = [];
// M4 验收循环：前 N 次返回失败，之后返回通过，用来验证「失败→修复→再跑」真的会累加轮次。
let verifyCalls = 0;
let verifyFailures = 1;
let verifyResults = null;
// M5：第二个 driver 的历史与 codex 完全分开，用来验证「切 driver 真的换了会话源」。
let claudeThreads = [
    { id: "claude-thread-1", preview: "用 Claude 写验收测试", name: "Claude 验收", createdAt: 1789200000, updatedAt: 1789300000 },
];
let threads = [
    { id: "thread-a", preview: "@图片1 把这张图变为蓝色调的，同明度…", name: "蓝色调改图", createdAt: 1789000000, updatedAt: 1789100000 },
    { id: "thread-b", preview: "@图片1 把这张图变为蓝色调的，同明度…", name: "第二次尝试", createdAt: 1788000000, updatedAt: 1788100000 },
];

function cors(res) {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, authorization, x-canvas-agent-token");
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
const claudeConversation = () => ({ revision: 1, conversationId: "conv-claude-e2e", threadId: claudeThreads[0]?.id || "", status: "ready", mcpStatuses: {} });

const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
        cors(res);
        res.writeHead(204);
        return res.end();
    }

    // 测试辅助：断言服务端到底收到了什么
    if (path === "/__state") return json(res, { deleted, threads: threads.map((item) => item.id), claudeThreads: claudeThreads.map((item) => item.id) });
    if (path === "/__reset") {
        deleted = [];
        verifyCalls = 0;
        verifyFailures = 1;
        verifyResults = null;
        threads = [
            { id: "thread-a", preview: "@图片1 把这张图变为蓝色调的，同明度…", name: "蓝色调改图", createdAt: 1789000000, updatedAt: 1789100000 },
            { id: "thread-b", preview: "@图片1 把这张图变为蓝色调的，同明度…", name: "第二次尝试", createdAt: 1788000000, updatedAt: 1788100000 },
        ];
        claudeThreads = [
            { id: "claude-thread-1", preview: "用 Claude 写验收测试", name: "Claude 验收", createdAt: 1789200000, updatedAt: 1789300000 },
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

    // M4 部署链路：命令恒成功，健康检查恒通过。E2E 验证的是前端「部署→留痕→回滚」，
    // 真命令执行与真探测由桥端单测覆盖，不在浏览器测试里跑 shell。
    if (path === "/delivery/deploy" && req.method === "POST") {
        await readBody(req).catch(() => "");
        return json(res, { ok: true, command: { ok: true, exitCode: 0, output: "mock deploy" }, health: { ok: true, status: 200, latencyMs: 1, checkedAt: new Date().toISOString() }, status: "healthy" });
    }
    // 覆盖脚本：用例想指定「连续失败几轮」或「直接给一组结果」时先打这个口子。
    if (path === "/__verify-config" && req.method === "POST") {
        const body = JSON.parse((await readBody(req).catch(() => "{}")) || "{}");
        if (typeof body.failures === "number") verifyFailures = body.failures;
        if (Array.isArray(body.results)) verifyResults = body.results;
        verifyCalls = 0;
        return json(res, { ok: true, verifyFailures, verifyResults });
    }
    if (path === "/delivery/verify" && req.method === "POST") {
        await readBody(req).catch(() => "");
        verifyCalls += 1;
        // 没有显式配置时：第一轮报 AC-01 失败，之后通过——模拟「修完再跑就绿了」。
        const failing = verifyResults
            ? verifyResults
            : [{ acId: "AC-01", result: verifyCalls <= verifyFailures ? "fail" : "pass" }];
        const failed = failing.some((item) => item.result === "fail");
        return json(res, {
            ok: !failed,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            command: { ok: !failed, exitCode: failed ? 1 : 0, output: failed ? `expected AC-01 to pass (round ${verifyCalls})` : "all good" },
            report: { type: "vitest", path: "/tmp/mock-report.json", cases: failing.length, withoutAc: 0 },
            results: failing,
        });
    }
    if (path === "/delivery/health" && req.method === "POST") {
        await readBody(req).catch(() => "");
        return json(res, { ok: true, health: { ok: true, status: 200, latencyMs: 1, checkedAt: new Date().toISOString() }, status: "healthy" });
    }

    if (path === "/agent/drivers") {
        return json(res, { ok: true, data: [
            { id: "codex", label: "Codex", available: true, version: "codex-cli 0.0.0-mock" },
            { id: "claude", label: "Claude Code", available: true, version: "1.0.0-mock" },
        ] });
    }
    if (path === "/agent/claude/threads" && req.method === "GET") {
        return json(res, { data: claudeThreads, conversation: claudeConversation(), workspace: { activeThreadId: claudeThreads[0]?.id || "", cwd: "/tmp/e2e-workspace" } });
    }
    if (path === "/agent/claude/threads/reset") {
        await readBody(req);
        return json(res, { conversation: claudeConversation() });
    }
    const claudeThreadMatch = path.match(/^\/agent\/claude\/threads\/([^/]+)$/);
    if (claudeThreadMatch && req.method === "GET") {
        return json(res, { thread: { id: decodeURIComponent(claudeThreadMatch[1]), turns: [] }, conversation: claudeConversation() });
    }
    if (path === "/agent/claude/models") return json(res, { data: [{ id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", isDefault: true }] });
    if (path === "/agent/claude/skills") return json(res, { ok: true, data: [], note: "claude driver 暂不支持技能市场" });
    if (path === "/agent/claude/history/ack") return json(res, { ok: true });

    await readBody(req).catch(() => "");
    return json(res, { ok: true });
});

server.listen(PORT, "127.0.0.1", () => {
    console.log(`[mock-agent] listening on http://127.0.0.1:${PORT} token=${TOKEN}`);
});
