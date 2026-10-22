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
// M5 验收①③：记录真的收到过哪些 turn（断言「两个 driver 都能干活」），
// 以及下一次 turn 要回吐多少 token（断言「额度耗尽的提示与拦截」）。
let turns = [];
// H2：队列里能直接处置的权限请求。approvals 是「服务端真的收到过哪些审批决定」，
// pendingApprovals 是还没处置的那几条（队列的「权限确认」态与 requestId 都来自它）。
let approvals = [];
let pendingApprovals = [];
// 用例想造「失败 / 等待输入」这种历史条目时用它（真桥端这些状态来自会话，桩直接给）。
let statusOverrides = {};
let usageNext = { input_tokens: 1200, cached_input_tokens: 0, output_tokens: 800 };
// B3 多窗并行：不同线程的 turn 必须能同时在飞。默认 50ms 走完（既有用例不用等），
// 需要证明「时间区间真的重叠」的用例用 /__turn-config 把它调长。
// 每个 turn 自己一个定时器 —— 不是一条全局队列，否则两个窗永远串行。
let turnDelayMs = 50;
let inflight = 0;
let maxInflight = 0;
// turnId -> { timer, threadId, record }：中断时按线程取消对应定时器。
const turnTimers = new Map();
// 会话身份与 revision 必须像真桥端一样「每次 reset 就是一次新会话」：
// canvas-agent 的 /threads/reset 走 session.beginConversation()（新的 conversationId）
// 再 prepareDraftThread()（新的 threadId），revision 单调递增。
// 早期桩图省事，reset 后照旧返回 thread-a / conv-e2e / revision 1，于是两个会话窗共用
// 一个身份：前端按 threadId 归属（use-agent-store.agentWindowIdForConversation）会把
// 新窗的状态写进第一个窗，再被 revision 保护挡掉——新窗永远停在 idle。
let activeThreadId = threads[0].id;
let conversationId = "conv-e2e";
let revision = 1;
let threadSeq = 0;
let claudeActiveThreadId = claudeThreads[0].id;
let claudeThreadSeq = 0;
const sseClients = new Set();

function broadcast(event, payload) {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
        try {
            client.write(chunk);
        } catch {
            sseClients.delete(client);
        }
    }
}

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

// 桩不模拟 MCP 生命周期，所以会话直接是 ready（与 hello 一致，不是为了让测试变绿）；
// 但身份与 revision 必须和真桥端一样真实递增。
const conversation = () => ({ revision, conversationId, threadId: currentThread(), status: "ready", mcpStatuses: {} });
const currentThread = () => activeThreadId;
const claudeConversation = () => ({ revision: 1, conversationId: `conv-${claudeActiveThreadId}`, threadId: claudeActiveThreadId, status: "ready", mcpStatuses: {} });

const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
        cors(res);
        res.writeHead(204);
        return res.end();
    }

    // 测试辅助：断言服务端到底收到了什么。
    // turns 带 startedAt / finishedAt：用例靠这两个时间戳断言两个 turn 真的交错跑过，
    // 而不是「先后各跑一遍、只是看起来快」。
    if (path === "/__state") return json(res, { deleted, threads: threads.map((item) => item.id), claudeThreads: claudeThreads.map((item) => item.id), turns, approvals, pendingApprovals, statusOverrides, inflight, maxInflight, turnDelayMs });
    // 造一条待审批项：队列的「批准 / 拒绝」必须真的打到桥端才算过，所以这里得能种进去。
    if (path === "/__approval-seed" && req.method === "POST") {
        const body = JSON.parse((await readBody(req).catch(() => "{}")) || "{}");
        const requestId = String(body.requestId || `req-${pendingApprovals.length + 1}`);
        pendingApprovals = pendingApprovals.filter((item) => item.requestId !== requestId);
        pendingApprovals.push({ requestId, threadId: String(body.threadId || ""), method: String(body.method || "shell"), reason: String(body.reason || "需要确认才能执行命令") });
        return json(res, { ok: true, pendingApprovals });
    }
    // 造一条「失败 / 等待输入」条目（继续按钮只在这两种状态下出现）。
    if (path === "/__queue-status" && req.method === "POST") {
        const body = JSON.parse((await readBody(req).catch(() => "{}")) || "{}");
        const threadId = String(body.threadId || "");
        const status = String(body.status || "");
        if (threadId) {
            if (status) statusOverrides[threadId] = status;
            else delete statusOverrides[threadId];
        }
        return json(res, { ok: true, statusOverrides });
    }
    // 用例要把「一轮跑多久」调长时打这里（用于证明并行：第二个 turn 在第一个结束前就开始了）。
    if (path === "/__turn-config" && req.method === "POST") {
        const body = JSON.parse((await readBody(req).catch(() => "{}")) || "{}");
        if (typeof body.delayMs === "number" && body.delayMs >= 0) turnDelayMs = body.delayMs;
        return json(res, { ok: true, turnDelayMs });
    }
    // 用例要把「额度打爆」时改这里：指定下一轮 turn 回吐的 token 数。
    if (path === "/__usage-config" && req.method === "POST") {
        const body = JSON.parse((await readBody(req).catch(() => "{}")) || "{}");
        if (typeof body.input_tokens === "number") usageNext.input_tokens = body.input_tokens;
        if (typeof body.cached_input_tokens === "number") usageNext.cached_input_tokens = body.cached_input_tokens;
        if (typeof body.output_tokens === "number") usageNext.output_tokens = body.output_tokens;
        return json(res, { ok: true, usageNext });
    }
    if (path === "/__reset") {
        // 上一轮用例遗留的定时器必须先清掉，否则它会往新一轮的事件流里补发旧 turn。
        for (const entry of turnTimers.values()) clearTimeout(entry.timer);
        turnTimers.clear();
        inflight = 0;
        maxInflight = 0;
        turnDelayMs = 50;
        deleted = [];
        turns = [];
        approvals = [];
        pendingApprovals = [];
        statusOverrides = {};
        usageNext = { input_tokens: 1200, cached_input_tokens: 0, output_tokens: 800 };
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
        activeThreadId = threads[0].id;
        conversationId = "conv-e2e";
        revision = 1;
        threadSeq = 0;
        claudeActiveThreadId = claudeThreads[0].id;
        claudeThreadSeq = 0;
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
        sseClients.add(res);
        const keepAlive = setInterval(() => res.write(": ping\n\n"), 15000);
        req.on("close", () => {
            clearInterval(keepAlive);
            sseClients.delete(res);
        });
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
        // 与真桥端同语义：reset = 开一个新对话（新 conversationId + 新 threadId，revision+1）。
        const now = Math.floor(Date.now() / 1000);
        threadSeq += 1;
        const thread = { id: `thread-${Date.now().toString(36)}${threadSeq}`, preview: "", name: `新对话 ${threadSeq}`, createdAt: now, updatedAt: now };
        threads = [thread, ...threads];
        activeThreadId = thread.id;
        conversationId = `conv-${thread.id}`;
        revision += 1;
        const snapshot = conversation();
        // 真桥端每次会话状态变化都广播 conversation_changed（session.updateConversation）。
        broadcast("conversation_changed", snapshot);
        return json(res, { conversation: snapshot });
    }

    const threadMatch = path.match(/^\/agent\/codex\/threads\/([^/]+)$/);
    if (threadMatch && req.method === "GET") {
        return json(res, { thread: { id: decodeURIComponent(threadMatch[1]), turns: [] }, conversation: conversation() });
    }

    if (path === "/agent/codex/models") return json(res, { models: [] });
    if (path === "/agent/codex/skills") return json(res, { skills: [] });
    // 与真桥端同形状：data[] 每条带状态，pendingApprovalRequests 带 requestId + 归属线程，
    // 队列靠它决定这一条能不能一键批准（缺了 requestId 就只能干瞪眼）。
    if (path === "/agent/queue") {
        const runningIds = [...new Set([...turnTimers.values()].map((entry) => entry.threadId))];
        const data = threads.map((thread) => {
            const pending = pendingApprovals.filter((item) => !item.threadId || item.threadId === thread.id);
            const active = thread.id === activeThreadId;
            const running = runningIds.includes(thread.id);
            let status = statusOverrides[thread.id] || "idle";
            let waitingFor = "";
            if (pending.length && (running || active)) {
                status = "approval";
                waitingFor = pending[0].method || "approval";
            } else if (running) {
                status = "running";
            }
            return { id: thread.id, title: thread.name || thread.preview || thread.id, source: "codex", status, active, running, waitingFor, updatedAt: thread.updatedAt || 0, createdAt: thread.createdAt || 0 };
        });
        return json(res, {
            ok: true,
            workspace: { activeThreadId: currentThread(), cwd: "/tmp/e2e-workspace" },
            conversation: conversation(),
            codex: { busy: runningIds.length > 0, threadId: currentThread(), turnId: "" },
            busyThreadIds: runningIds,
            pendingApprovals: pendingApprovals.length,
            pendingApprovalRequests: pendingApprovals.map((item) => ({ requestId: item.requestId, threadId: item.threadId, method: item.method, reason: item.reason })),
            data,
            updatedAt: Date.now(),
        });
    }
    // H2：队列里批准 / 拒绝 → 必须落到服务端。决策记进 approvals，并从待办里摘掉。
    if (path === "/agent/codex/approval" && req.method === "POST") {
        const body = JSON.parse((await readBody(req).catch(() => "{}")) || "{}");
        const requestId = String(body.requestId || "");
        const decision = String(body.decision || "");
        const pending = pendingApprovals.find((item) => item.requestId === requestId);
        if (!pending || !["accept", "acceptForSession", "decline", "cancel"].includes(decision)) {
            return json(res, { ok: false, error: "审批请求已失效" }, 409);
        }
        approvals.push({ requestId, decision, threadId: pending.threadId || "", at: Date.now() });
        pendingApprovals = pendingApprovals.filter((item) => item.requestId !== requestId);
        broadcast("codex_approval_resolved", { requestId, threadId: pending.threadId || "", decision });
        return json(res, { ok: true });
    }
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
        const body = JSON.parse((await readBody(req).catch(() => "{}")) || "{}");
        verifyCalls += 1;
        // 轮次归属由前端给出，桩只回显：这正是 E2 要求「轮次编号与编排器一致」的接线点。
        const runId = typeof body.runId === "string" ? body.runId : "";
        const roundIndex = Number(body.roundIndex) || verifyCalls;
        // 没有显式配置时：第一轮报 AC-01 失败，之后通过——模拟「修完再跑就绿了」。
        const results = verifyResults
            ? verifyResults
            : [{ acId: "AC-01", result: verifyCalls <= verifyFailures ? "fail" : "pass" }];
        const failed = results.some((item) => item.result === "fail");
        const startedAt = new Date().toISOString();
        const finishedAt = new Date().toISOString();
        // 和真桥端一样把命令输出最后一行带上：失败签名靠它区分「这一轮到底改了没」，
        // 否则每轮标题都相同，会被「连续 3 轮原地打转」的护栏提前止损。
        const output = failed ? `expected AC-01 to pass (round ${verifyCalls})` : "all good";
        // E2: 结构化摘要（与桥端 summarizeVerifyReport 同形状）。reportId 带轮次，
        // 同一轮的 HTTP 响应与事件流共用一个 id，前端靠它去重。
        const summary = {
            reportId: `mock-${verifyCalls}-${roundIndex}`,
            reportType: "vitest",
            reportPath: "/tmp/mock-report.json",
            status: "parsed",
            total: results.length,
            passed: results.filter((item) => item.result === "pass").length,
            failed: results.filter((item) => item.result === "fail").length,
            skipped: results.filter((item) => item.result === "skip").length,
            unanchored: 0,
            cases: results.map((item) => ({
                acId: item.acId || null,
                title: item.acId ? `${item.acId} should pass` : "case without anchor",
                status: item.result,
                raw: item.result,
                file: "e2e/mock.e2e.ts",
            })),
        };
        // 第二条到达路径：与 HTTP 响应并行走 SSE，前端按 reportId 去重后只记一轮。
        broadcast("delivery_verify", { type: "delivery_verify", ...summary, runId, roundIndex, startedAt, finishedAt, exitCode: failed ? 1 : 0, outputTail: output });
        return json(res, {
            ok: !failed,
            startedAt,
            finishedAt,
            command: { ok: !failed, exitCode: failed ? 1 : 0, output },
            report: { type: "vitest", path: "/tmp/mock-report.json", cases: results.length, withoutAc: 0 },
            summary,
            runId,
            roundIndex,
            // 老字段保留：证明前端对新旧两种响应都能处理。
            results,
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
        // claude 的 reset 在真桥端同样是 claudeThreadStore.create()：必须给新线程，不能复用旧 id。
        const now = Math.floor(Date.now() / 1000);
        claudeThreadSeq += 1;
        const thread = { id: `claude-thread-${Date.now().toString(36)}${claudeThreadSeq}`, preview: "", name: `Claude 新对话 ${claudeThreadSeq}`, createdAt: now, updatedAt: now };
        claudeThreads = [thread, ...claudeThreads];
        claudeActiveThreadId = thread.id;
        const snapshot = claudeConversation();
        broadcast("conversation_changed", snapshot);
        return json(res, { conversation: snapshot, thread: { id: thread.id, title: thread.name, turns: [] }, messages: [] });
    }
    const claudeThreadMatch = path.match(/^\/agent\/claude\/threads\/([^/]+)$/);
    if (claudeThreadMatch && req.method === "GET") {
        return json(res, { thread: { id: decodeURIComponent(claudeThreadMatch[1]), turns: [] }, conversation: claudeConversation() });
    }
    // H2：队列的「继续」先把线程接进会话窗（resume），再走 /turn 起新一轮。
    const resumeMatch = path.match(/^\/agent\/codex\/threads\/([^/]+)\/resume$/);
    if (resumeMatch && req.method === "POST") {
        await readBody(req).catch(() => "");
        const threadId = decodeURIComponent(resumeMatch[1]);
        const thread = threads.find((item) => item.id === threadId);
        activeThreadId = threadId;
        conversationId = `conv-${threadId}`;
        revision += 1;
        const snapshot = conversation();
        broadcast("conversation_changed", snapshot);
        return json(res, { ok: true, workspace: { activeThreadId: threadId, cwd: "/tmp/e2e-workspace" }, conversation: snapshot, thread: { id: threadId, title: thread?.name || threadId, turns: [] }, messages: [{ role: "user", text: "继续上一步未完成的部分" }] });
    }
    if (path === "/agent/claude/models") return json(res, { data: [{ id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", isDefault: true }] });
    if (path === "/agent/claude/skills") return json(res, { ok: true, data: [], note: "claude driver 暂不支持技能市场" });
    if (path === "/agent/claude/history/ack") return json(res, { ok: true });

    // M5 验收①：两个 driver 的 turn 都要真的跑一遍。
    // 响应后异步补事件流，模拟「接单 → 回话 → 报用量」；前端靠事件收尾，
    // 只回 HTTP 200 的话面板会一直停在「发送中」，正好也能验证事件接线。
    if (path === "/agent/codex/turn" && req.method === "POST") {
        const body = JSON.parse((await readBody(req).catch(() => "{}")) || "{}");
        const threadId = body.threadId || currentThread();
        const turnId = `turn-${turns.length + 1}`;
        const record = { driver: "codex", threadId, turnId, text: body.messageText || "", startedAt: Date.now(), finishedAt: null, status: "running" };
        turns.push(record);
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        json(res, { ok: true, threadId, turnId });
        // 接单即报 busy：前端据此进入 running（按 threadId 落到各自那窗）。
        broadcast("codex_state", { busy: true, threadId, turnId });
        const timer = setTimeout(() => {
            turnTimers.delete(turnId);
            inflight -= 1;
            record.finishedAt = Date.now();
            record.status = "done";
            // item.id 是稳定消息标识：真桥端一直带，后台窗靠它去重写入；缺了会让后台窗丢回复。
            broadcast("agent_event", { type: "item.completed", threadId, turn_id: turnId, item: { id: `msg-${turnId}`, type: "agent_message", text: `mock codex reply ${turnId}` } });
            broadcast("agent_event", { type: "usage.updated", threadId, usage: { ...usageNext } });
            broadcast("codex_state", { busy: false, threadId, turnId });
        }, turnDelayMs);
        turnTimers.set(turnId, { timer, threadId, record });
        return;
    }

    if (path === "/agent/claude/turn" && req.method === "POST") {
        const body = JSON.parse((await readBody(req).catch(() => "{}")) || "{}");
        const threadId = body.threadId || claudeThreads[0]?.id || "";
        const turnId = `cturn-${turns.length + 1}`;
        const record = { driver: "claude", threadId, turnId, text: body.messageText || "", startedAt: Date.now(), finishedAt: null, status: "running" };
        turns.push(record);
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        json(res, { ok: true, threadId, turnId });
        const timer = setTimeout(() => {
            turnTimers.delete(turnId);
            inflight -= 1;
            record.finishedAt = Date.now();
            record.status = "done";
            broadcast("agent_event", { type: "assistant_message", threadId, text: `mock claude reply ${turnId}` });
            broadcast("agent_event", { type: "usage.updated", threadId, usage: { ...usageNext } });
            broadcast("agent_done", { threadId, code: 0, agent: "claude" });
        }, turnDelayMs);
        turnTimers.set(turnId, { timer, threadId, record });
        return;
    }

    // 中断：只取消指定线程上还在飞的 turn（另一个窗的 turn 继续跑完）。
    const interruptMatch = path.match(/^\/agent\/(codex|claude)\/interrupt$/);
    if (interruptMatch && req.method === "POST") {
        const body = JSON.parse((await readBody(req).catch(() => "{}")) || "{}");
        const threadId = typeof body.threadId === "string" ? body.threadId : "";
        let stopped = 0;
        for (const [turnId, entry] of turnTimers) {
            if (threadId && entry.threadId !== threadId) continue;
            clearTimeout(entry.timer);
            turnTimers.delete(turnId);
            inflight -= 1;
            entry.record.finishedAt = Date.now();
            entry.record.status = "interrupted";
            stopped += 1;
            // 收尾事件照真桥端发：否则被停的窗会永远停在「停止中」。
            if (entry.record.driver === "claude") broadcast("agent_done", { threadId: entry.threadId, code: 0, agent: "claude" });
            else broadcast("codex_state", { busy: false, threadId: entry.threadId, turnId });
        }
        return json(res, { ok: true, stopped });
    }

    await readBody(req).catch(() => "");
    return json(res, { ok: true });
});

server.listen(PORT, "127.0.0.1", () => {
    console.log(`[mock-agent] listening on http://127.0.0.1:${PORT} token=${TOKEN}`);
});
