import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";

import { CLAUDE_MODELS, claudeRunningThreadIds, interruptClaudeTurn, runClaudeTurn } from "../agent/claude.js";
import { claudeThreadStore } from "../agent/claude-threads.js";
import { driverInventory } from "../agent/driver-inventory.js";
import { archiveCodexThread, CodexSkillLookupError, configureCodexSkill, generateCodexSkillDraft, interruptCodexTurn, isRecoverableThreadError, listCodexModels, listCodexSkills, listCodexThreads, readCodexThread, resolveCodexApproval, resolveCodexSkill, resumeCodexThread, runCodexTurn, startCodexThread, summarizeCodexThread } from "../agent/codex.js";
import type { CodexReasoningEffort, CodexSkillSelector } from "../agent/codex-protocol.js";
import { messageMetadataStore } from "../agent/message-metadata.js";
import { buildTurnContextPrompt, turnContextAttachments } from "../agent/turn-context.js";
import type { AgentAttachment, AgentPermissionMode } from "../agent/types.js";
import { AGENT_PROTOCOL_VERSION, CanvasSession } from "../canvas/session.js";
import { DEFAULT_PORT, ensureSiteWorkspace, findRepo, loadConfig, readRepoGitInfo, removeRepo, saveConfig, updateSiteWorkspace, upsertRepo, type CanvasAgentConfig } from "../config.js";
import { buildRepoTree, readRepoDiff, readRepoFile, readRepoStatus, RepoPathError } from "../repo/fs-ops.js";
import { logger } from "../utils/logger.js";
import { checkVersions } from "../version-check.js";
import { SkillStore, SkillStoreError } from "../skills/store.js";
import { IMAGE_PARSE_BODY_LIMIT, requestUpstream, resolveImageParseUrl, truncateUpstreamText } from "./image-parse.js";
import { terminalManager } from "./terminal.js";
import { captureWall, listWall, listWindows, pickCaptureWindow, readWallFile } from "./capture.js";
import { rewriteAgentDriverPath } from "./agent-driver-route.js";
import { deploymentStatus, probeHealth, runCommand } from "../delivery/deployer.js";
import { isReportType, parseReport, summarizeAcResults } from "../delivery/test-report.js";
import { outputTail, reportFingerprint, summarizeVerifyRaw, summarizeVerifyReport, VERIFY_EVENT_TYPE, type VerifyReportSummary, type VerifyRunEvent } from "../delivery/verify-report.js";

export type StartHttpServerOptions = { skipVersionCheck?: boolean };

/** 启动仅监听本机的 Canvas Agent HTTP 服务，返回底层 HTTP server 以便测试收尾。 */
export function startHttpServer(options: StartHttpServerOptions = {}) {
    const config = loadConfig(true);
    const port = Number(process.env.PORT) || Number(new URL(config.url).port) || DEFAULT_PORT;
    config.url = `http://127.0.0.1:${port}`;
    saveConfig(config);

    const initialWorkspace = ensureSiteWorkspace(config);
    const session = new CanvasSession(initialWorkspace.activeThreadId || "");
    const skillStore = new SkillStore(initialWorkspace.workspacePath);
    /** 将 Agent 事件广播到所属线程或全部网页。 */
    const emit = (type: string, payload: unknown) => {
        const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : { value: payload };
        if (type === "skills_changed") {
            session.emitAll(type, value);
            return;
        }
        if (type === "agent_bootstrap" && value.phase === "preheat") {
            if (value.type === "mcp.startup") session.updateConversationMcp(String(value.name || ""), startupStatus(value.status), String(value.error || "") || null, String(value.failureReason || "") || null);
            if (value.type === "mcp.complete") session.completeConversationMcpInventory(mcpInventory(value.services));
        }
        const scope = session.codexBusy ? session.codexEventScope : { threadId: "", turnId: "", sourceClientId: "" };
        const threadId = String(value.threadId || value.thread_id || scope.threadId || ensureSiteWorkspace(config).activeThreadId || "");
        const turnId = String(value.turnId || value.turn_id || scope.turnId || "");
        const sourceClientId = String(value.sourceClientId || scope.sourceClientId || "");
        const data = {
            ...value,
            ...(threadId ? { threadId, thread_id: threadId } : {}),
            ...(turnId ? { turnId, turn_id: turnId } : {}),
            ...(sourceClientId ? { sourceClientId } : {}),
        };
        session.trackCodexEvent(type, data);
        threadId ? session.emitThread(type, threadId, data) : session.emitAll(type, data);
    };
    /** 保存并广播当前站点工作空间的活跃线程。 */
    const setActiveThread = (activeThreadId: string, payload: Record<string, unknown> = {}, preserveConversation = false) => {
        const workspace = updateSiteWorkspace(config, { activeThreadId: activeThreadId || undefined });
        if (!preserveConversation) session.activateConversation(activeThreadId, String(payload.sourceClientId || "") || undefined);
        if (!session.codexBusy && session.codexThreadId !== activeThreadId) session.setCodexState({ threadId: activeThreadId, turnId: "" });
        session.emitThread("workspace_changed", activeThreadId, { ...payload, activeThreadId, conversation: session.conversationStateSnapshot });
        return workspace;
    };
    let draftThreadStart: ReturnType<typeof startCodexThread> | null = null;
    let skillDraftRunning = false;
    const prepareDraftThread = (clientId: string, permission: AgentPermissionMode, repoId = "") => {
        if (draftThreadStart) return draftThreadStart;
        const cwd = resolveCodexCwd({ repoId });
        let prepared!: ReturnType<typeof startCodexThread>;
        prepared = (async () => {
            emit("agent_bootstrap", { type: "codex.preparing", sourceClientId: clientId });
            try {
                const thread = await startCodexThread(emit, cwd, permission, true);
                if (draftThreadStart !== prepared) return thread;
                const threadId = String((thread as Record<string, unknown>).id || "");
                if (threadId && !ensureSiteWorkspace(config).activeThreadId) {
                    session.completeConversationPreparation(threadId);
                    session.markThreadReady(threadId);
                    setActiveThread(threadId, { emptyThread: true, draftThread: true, sourceClientId: clientId }, true);
                }
                return thread;
            } catch (error) {
                if (draftThreadStart === prepared) {
                    const text = error instanceof Error ? error.message : String(error);
                    session.failConversationPreparation(text);
                    emit("agent_bootstrap", { type: "codex.prepare_failed", sourceClientId: clientId, error: text });
                }
                throw error;
            } finally {
                if (draftThreadStart === prepared) draftThreadStart = null;
            }
        })();
        draftThreadStart = prepared;
        return prepared;
    };
    /** 恢复已有线程并等待完整 MCP 清单，供启动恢复和手动切换共用。 */
    const prepareExistingThread = async (threadId: string, clientId = "", permission: AgentPermissionMode = "request", repoId = "") => {
        session.beginConversation({ conversationId: threadId, threadId, sourceClientId: clientId || undefined });
        emit("agent_bootstrap", { type: "codex.preparing", threadId, sourceClientId: clientId || undefined });
        const result = await resumeCodexThread(emit, threadId, resolveCodexCwd({ repoId }), permission, true);
        session.completeConversationPreparation(threadId);
        session.markThreadReady(threadId);
        return result;
    };
    const failPreparedConversation = (error: unknown, threadId: string, clientId = "") => {
        const text = error instanceof Error ? error.message : String(error);
        session.failConversationPreparation(text);
        emit("agent_bootstrap", { type: "codex.prepare_failed", threadId, sourceClientId: clientId || undefined, error: text });
    };
    /** 按请求里的 repoId/cwd 解析 Codex 线程工作目录，未注册时回退站点工作空间。 */
    const resolveCodexCwd = (input: { repoId?: unknown; cwd?: unknown } = {}) => {
        const repoId = String(input.repoId || "");
        const byId = findRepo(config, repoId);
        if (byId) return byId.path;
        const cwd = String(input.cwd || "");
        if (cwd) {
            const resolved = path.resolve(cwd);
            const byPath = (config.repos || []).find((repo) => repo.path === resolved);
            if (byPath) return byPath.path;
        }
        return ensureSiteWorkspace(config).workspacePath;
    };
    const app = express();
    app.disable("x-powered-by");
    // /image/parse 需要把请求体逐字节透传给解析服务，先按 Buffer 原样收下，
    // 这样 express.json 不会再解析它（body-parser 见到已解析的 body 会跳过）。
    app.use("/image/parse", express.raw({ type: () => true, limit: IMAGE_PARSE_BODY_LIMIT }));
    app.use(express.json({ limit: "30mb" }));
    // M0: /agent/:driver/* 双轨——codex 之外的已知 driver 改写到对应 handler，未知 driver 明确 404。
    app.use((req, res, next) => {
        const rewritten = rewriteAgentDriverPath(req.path);
        if (!rewritten) return next();
        if (rewritten.canonicalPath !== req.path) {
            req.url = rewritten.canonicalPath + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");
        }
        next();
    });
    app.use((req, res, next) => {
        if (!logger.enabled) return next();
        const startedAt = Date.now();
        const url = requestUrl(req, config);
        res.on("finish", () => {
            if (req.method === "OPTIONS" || (res.statusCode < 400 && ["/health", "/canvas/state", "/canvas/activate"].includes(url.pathname))) return;
            logger.debug(`HTTP ${req.method} ${url.pathname}`, { status: res.statusCode, durationMs: Date.now() - startedAt });
        });
        next();
    });
    app.use((req, res, next) => {
        const url = requestUrl(req, config);
        if (!setCors(req, res, url, config)) return void res.status(403).json({ ok: false, error: "origin not allowed" });
        if (req.method === "OPTIONS") return void res.json({});
        next();
    });
    app.get("/health", (_req, res) => res.json({ ...session.health(), imageParseUrl: resolveImageParseUrl(config) }));
    app.get("/config", (_req, res) => res.json({ ok: true, protocolVersion: AGENT_PROTOCOL_VERSION, url: config.url, hasToken: true }));
    app.use((req, res, next) => {
        if (validToken(req, requestUrl(req, config), config.token)) return next();
        res.status(401).json({ ok: false, error: "invalid token" });
    });
    // 桥侧代理：网页无 CORS 通道，只能经此转发到本地解析服务（该服务不返回 CORS 头）。
    app.post("/image/parse", route(async (req, res) => {
        const baseUrl = resolveImageParseUrl(config);
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "application/json";
        const result = await requestUpstream(baseUrl, { method: "POST", path: "/parse", body, contentType });
        if (!result.ok) return void res.status(502).json({ ok: false, error: result.error });
        if (result.status < 200 || result.status >= 300) return void res.status(502).json({ ok: false, error: truncateUpstreamText(result.text) });
        res.status(result.status).type(result.contentType || "application/json").send(result.text);
    }));
    app.get("/image/health", route(async (_req, res) => {
        const result = await requestUpstream(resolveImageParseUrl(config), { method: "GET", path: "/health" });
        if (!result.ok) return void res.status(502).json({ ok: false, error: result.error });
        res.status(result.status).type(result.contentType || "application/json").send(result.text);
    }));
    app.get("/events", (req, res) => {
        session.openEvents(requestUrl(req, config), res, ensureSiteWorkspace(config).activeThreadId || "");
    });
    app.post("/canvas/state", (req, res) => {
        session.updateState(req.body, String(req.query.clientId || "") || undefined);
        res.json({ ok: true });
    });
    app.post("/canvas/activate", (req, res) => {
        session.activateClient(String(req.query.clientId || ""));
        res.json({ ok: true });
    });
    app.post("/canvas/result", (req, res) => {
        const ok = session.resolveResult(String(req.query.clientId || ""), req.body);
        res.status(ok ? 200 : 409).json({ ok });
    });
    app.get("/terminal/sessions", route(async (req, res) => {
        res.json({ ok: true, sessions: await terminalManager.list(String(req.query.canvasId || "")) });
    }));
    app.post("/terminal/sessions", route(async (req, res) => {
        const created = await terminalManager.create(String(req.body?.canvasId || ""));
        res.json({ ok: true, ...created });
    }));
    app.post("/terminal/sessions/:id/close", route(async (req, res) => {
        await terminalManager.remove(routeParam(req.params.id));
        res.json({ ok: true });
    }));
    // M4: 部署器只暴露两个动作——探测健康状态、跑部署命令后再探测。
    // 回滚由前端按部署历史决定目标版本，桥端不替用户「猜」该回哪一版。
    app.post("/delivery/health", route(async (req, res) => {
        const target = String(req.body?.url || "");
        if (!target) return void res.status(400).json({ ok: false, error: "url required" });
        const health = await probeHealth(target, Number(req.body?.timeoutMs) || 8000);
        res.json({ ok: true, health, status: deploymentStatus(health) });
    }));
    app.post("/delivery/deploy", route(async (req, res) => {
        const command = String(req.body?.command || "");
        const cwd = String(req.body?.cwd || "");
        const target = String(req.body?.url || "");
        if (!command) return void res.status(400).json({ ok: false, error: "command required" });
        if (!path.isAbsolute(cwd)) return void res.status(400).json({ ok: false, error: "cwd must be absolute" });
        const result = await runCommand(command, cwd, Number(req.body?.timeoutMs) || 120_000);
        const health = target ? await probeHealth(target, Number(req.body?.healthTimeoutMs) || 8000) : undefined;
        res.json({ ok: result.ok && (health ? health.ok : true), command: result, health, status: health ? deploymentStatus(health) : "unknown" });
    }));
    /**
     * 跑验收命令 → 读报告 → 汇总到 AC 粒度。
     *
     * 这里刻意不「猜」测试命令，也不自动改代码：桥端只回答「跑出来是什么」，
     * 修与不修、什么时候停，由前端编排器按护栏决定。
     */
    app.post("/delivery/verify", route(async (req, res) => {
        const command = String(req.body?.command || "");
        const cwd = String(req.body?.cwd || "");
        const reportPath = String(req.body?.reportPath || "");
        const reportType = String(req.body?.reportType || "playwright");
        // 轮次归属由调用方的编排器给出（runId + roundIndex），桥端只负责回放，不另起编号。
        const runId = String(req.body?.runId || "");
        const roundIndex = Number(req.body?.roundIndex) || 0;
        if (!command) return void res.status(400).json({ ok: false, error: "command required" });
        if (!path.isAbsolute(cwd)) return void res.status(400).json({ ok: false, error: "cwd must be absolute" });
        if (!isReportType(reportType)) return void res.status(400).json({ ok: false, error: `unsupported report type: ${reportType}` });

        const startedAt = new Date().toISOString();
        const commandResult = await runCommand(command, cwd, Number(req.body?.timeoutMs) || 180_000);
        const finishedAt = new Date().toISOString();
        const resolvedReport = reportPath ? path.resolve(cwd, reportPath) : "";

        // E2: 每轮结束都把结构化结果推进事件流。网页断线重连/轮次去重都靠 reportId，
        // 不靠「调了几次接口」——同一份报告重复到达只应记一轮。
        const publish = (summary: VerifyReportSummary) => {
            const event: VerifyRunEvent = {
                type: VERIFY_EVENT_TYPE,
                ...summary,
                runId,
                roundIndex,
                startedAt,
                finishedAt,
                exitCode: commandResult.exitCode,
                // 失败签名要看得到「这一轮输出变了没」，所以把最后一行带进事件。
                outputTail: outputTail(commandResult.output),
            };
            session.emitAll(VERIFY_EVENT_TYPE, event);
            return event;
        };

        if (!resolvedReport) {
            // 没有报告就只有退出码，不编造 AC 结果。
            const summary = summarizeVerifyReport({ reportType: reportType as "playwright" | "vitest", reportPath: "" });
            publish(summary);
            return void res.json({ ok: commandResult.ok, startedAt, finishedAt, command: commandResult, report: null, results: [], summary, runId, roundIndex });
        }
        let reportText: string;
        try {
            reportText = await readFile(resolvedReport, "utf8");
        } catch (error) {
            const message = `报告读取失败：${error instanceof Error ? error.message : String(error)}`;
            const summary = summarizeVerifyReport({ reportType: reportType as "playwright" | "vitest", reportPath: resolvedReport, error: message });
            publish(summary);
            return void res.status(422).json({ ok: false, error: message, command: commandResult, resolvedReport, summary, runId, roundIndex });
        }
        const reportId = reportFingerprint(reportType, resolvedReport, reportText, startedAt);
        let report: unknown;
        try {
            report = JSON.parse(reportText);
        } catch (error) {
            const message = `报告解析失败：${error instanceof Error ? error.message : String(error)}`;
            const summary = summarizeVerifyReport({ reportType: reportType as "playwright" | "vitest", reportPath: resolvedReport, reportId, error: message });
            publish(summary);
            return void res.status(422).json({ ok: false, error: message, command: commandResult, resolvedReport, summary, runId, roundIndex });
        }
        const parsed = parseReport(reportType as "playwright" | "vitest", report);
        const summary = summarizeVerifyRaw({ reportType: reportType as "playwright" | "vitest", reportPath: resolvedReport, reportId, raw: report });
        const results = summarizeAcResults(parsed);
        publish(summary);
        res.json({
            ok: commandResult.ok,
            startedAt,
            finishedAt,
            command: commandResult,
            report: { type: reportType, path: resolvedReport, cases: parsed.length, withoutAc: parsed.filter((item) => !item.acId).length },
            results,
            summary,
            runId,
            roundIndex,
        });
    }));
    app.get("/repos", route(async (_req, res) => {
        const repos = (config.repos || []).map((repo) => ({ ...repo, ...readRepoGitInfo(repo.path) }));
        res.json({ ok: true, repos, activeRepoId: config.activeRepoId || "" });
    }));
    app.post("/repos", route(async (req, res) => {
        const repoPath = String(req.body?.path || "");
        if (!path.isAbsolute(repoPath)) return void res.status(400).json({ ok: false, error: "仓库路径必须是绝对路径" });
        const info = await stat(repoPath).catch(() => null);
        if (!info || !info.isDirectory()) return void res.status(400).json({ ok: false, error: "仓库路径不存在或不是目录" });
        const repo = upsertRepo(config, repoPath, String(req.body?.name || "") || undefined);
        config.activeRepoId = repo.id;
        saveConfig(config);
        res.json({ ok: true, repo: { ...repo, ...readRepoGitInfo(repo.path) } });
    }));
    app.delete("/repos/:id", route(async (req, res) => {
        if (!removeRepo(config, routeParam(req.params.id))) return void res.status(404).json({ ok: false, error: "仓库不存在" });
        saveConfig(config);
        res.json({ ok: true });
    }));
    app.get("/repo/tree", route(async (req, res) => {
        const repo = repoForRequest(config, req.query.repoId);
        if (!repo) return void res.status(404).json({ ok: false, error: "未注册的仓库" });
        const tree = await buildRepoTree(repo.path, req.query.path, req.query.depth);
        res.json({ ok: true, root: tree.root, entries: tree.entries, truncated: tree.truncated });
    }));
    app.get("/repo/file", route(async (req, res) => {
        const repo = repoForRequest(config, req.query.repoId);
        if (!repo) return void res.status(404).json({ ok: false, error: "未注册的仓库" });
        const file = await readRepoFile(repo.path, req.query.path);
        res.json({ ok: true, ...file });
    }));
    app.get("/repo/diff", route(async (req, res) => {
        const repo = repoForRequest(config, req.query.repoId);
        if (!repo) return void res.status(404).json({ ok: false, error: "未注册的仓库" });
        if (!readRepoGitInfo(repo.path).isGit) return void res.json({ ok: false, error: "当前仓库不是 git 仓库，无法读取 diff" });
        const result = await readRepoDiff(repo.path, req.query.path);
        res.json({ ok: true, ...result });
    }));
    app.get("/repo/status", route(async (req, res) => {
        const repo = repoForRequest(config, req.query.repoId);
        if (!repo) return void res.status(404).json({ ok: false, error: "未注册的仓库" });
        const status = await readRepoStatus(repo.path);
        res.json({ ok: true, repoId: repo.id, name: repo.name, path: repo.path, ...status });
    }));
    app.get("/agent/attachments/:attachmentId", route(async (req, res) => {
        const attachment = session.getTurnAttachment(String(req.query.clientId || ""), routeParam(req.params.attachmentId));
        const data = attachment.dataUrl.split(",", 2)[1];
        if (!data) throw new Error("图片附件内容无效");
        res.setHeader("Cache-Control", "no-store");
        res.type(attachment.type).send(Buffer.from(data, "base64"));
    }));
    app.get("/agent/message-assets/:messageKey/:assetFile", route(async (req, res) => {
        const asset = await messageMetadataStore.readAsset(routeParam(req.params.messageKey), routeParam(req.params.assetFile));
        if (!asset) return void res.status(404).json({ ok: false, error: "message asset not found" });
        res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
        res.type(asset.contentType).send(asset.data);
    }));
    app.post("/agent/local-file/reveal", route(async (req, res) => {
        const filePath = String(req.body?.path || "");
        if (!path.isAbsolute(filePath)) return res.status(400).json({ ok: false, error: "文件路径必须是绝对路径" });
        const file = await stat(filePath);
        await revealLocalFile(filePath, file.isDirectory());
        res.json({ ok: true });
    }));
    app.post("/agent/capture", route(async (req, res) => {
        const result = await captureWall({ nodeId: req.body?.nodeId, tag: req.body?.tag, windowTitle: req.body?.windowTitle, requireTitle: req.body?.requireTitle, force: req.body?.force === true });
        res.status(result.ok ? 200 : 200).json(result);
    }));
    // 诊断用：列出候选窗口与最终选中项，方便确认「抓到的是不是画布那个窗」。
    app.get("/agent/windows", route(async (req, res) => {
        const title = String(req.query.title || "") || undefined;
        const requireTitle = String(req.query.require || "") === "1";
        const windows = await listWindows();
        const picked = pickCaptureWindow(windows, { title, requireTitle });
        res.json({ ok: true, strategy: picked.strategy, chosen: picked.window, candidates: picked.candidates.slice(0, 10) });
    }));
    app.get("/agent/wall", route(async (_req, res) => res.json({ ok: true, items: await listWall() })));
    app.get("/agent/wall/:file", route(async (req, res) => {
        const data = await readWallFile(routeParam(req.params.file));
        if (!data) return void res.status(404).json({ ok: false, error: "产物图片不存在" });
        res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
        res.type("png").send(data);
    }));
    app.post("/agent/local-image", route(async (req, res) => {
        const filePath = String(req.body?.path || "");
        if (!path.isAbsolute(filePath) || !/\.(?:avif|gif|jpe?g|png|webp)$/i.test(filePath)) return res.status(400).json({ ok: false, error: "图片路径无效" });
        const file = await stat(filePath);
        if (!file.isFile()) return res.status(400).json({ ok: false, error: "图片文件无效" });
        res.setHeader("Cache-Control", "no-store");
        res.type(path.extname(filePath)).send(await readFile(filePath));
    }));
    app.post("/api/tools", route(async (req, res) => res.json({ ok: true, result: await session.callTool(req.body?.name, req.body?.input || {}) })));
    app.get("/agent/codex/workspace", (_req, res) => {
        const workspace = ensureSiteWorkspace(config);
        res.json({ ok: true, workspace, conversation: session.conversationStateSnapshot });
    });
    app.get("/agent/codex/models", route(async (_req, res) => res.json({ ok: true, ...(await listCodexModels(emit)) })));
    app.get("/agent/codex/skills", route(async (req, res) => {
        const workspace = ensureSiteWorkspace(config);
        const result = await listCodexSkills(emit, workspace.workspacePath, String(req.query.forceReload || "") === "1");
        res.json({ ok: true, data: result.skills.map((skill) => ({ ...skill, managed: skillStore.isManagedPath(skill.path) })), errors: result.errors });
    }));
    app.post("/agent/codex/skills/draft", codexMutation(async (req, res) => {
        const workspace = ensureSiteWorkspace(config);
        const source = String(req.body?.source || "");
        if (source !== "conversation" && source !== "canvas") return res.status(400).json({ ok: false, error: "Skill 草稿来源无效" });
        const clientId = String(req.body?.clientId || "");
        if (!clientId || !session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起提炼的网页已断开，请重新连接后再试" });
        const model = String(req.body?.model || "") || undefined;
        const effort = reasoningEffort(req.body?.effort);
        const previousCodexState = session.codexStateSnapshot;
        skillDraftRunning = true;
        try {
            if (source === "conversation") {
                const threadId = String(req.body?.threadId || "");
                if (!threadId) return res.status(409).json({ ok: false, error: "当前没有可提炼的对话" });
                if (threadId !== (workspace.activeThreadId || "")) return res.status(409).json({ ok: false, error: "当前对话已在其他页面切换，请同步后重试" });
                const history = await readCodexThread(emit, threadId, workspace.workspacePath);
                if (!history.messages.some((message) => message.role === "user" && message.turnId)) return res.status(409).json({ ok: false, error: "当前对话还没有可提炼的已完成内容" });
                session.setCodexState({ busy: true, threadId, turnId: "" }, { preserveReplay: true });
                const data = await generateCodexSkillDraft(emit, workspace.workspacePath, { source, threadId, model, effort });
                if (!session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起提炼的网页已断开，请重新连接后再试" });
                return res.json({ ok: true, data });
            }
            const snapshot = session.canvasStateForClient(clientId);
            if (!snapshot || (snapshot as Record<string, unknown>).hasCanvas === false) return res.status(409).json({ ok: false, error: "当前页面没有可提炼的画布" });
            session.setCodexState({ busy: true, threadId: workspace.activeThreadId || "", turnId: "" }, { preserveReplay: true });
            const data = await generateCodexSkillDraft(emit, workspace.workspacePath, { source, snapshot, model, effort });
            if (!session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起提炼的网页已断开，请重新连接后再试" });
            return res.json({ ok: true, data });
        } finally {
            skillDraftRunning = false;
            session.setCodexState(previousCodexState, { preserveReplay: true });
        }
    }));
    app.get("/agent/codex/skills/:name", route(async (req, res) => {
        res.json({ ok: true, data: await skillStore.get(routeParam(req.params.name)) });
    }));
    app.post("/agent/codex/skills", codexMutation(async (req, res) => {
        const data = await skillStore.create(req.body);
        session.emitAll("skills_changed", { forceReload: true });
        res.status(201).json({ ok: true, data });
    }));
    app.post("/agent/codex/skills/:name/enabled", codexMutation(async (req, res) => {
        if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ ok: false, error: "Skill 启用状态无效" });
        const workspace = ensureSiteWorkspace(config);
        const selector = skillSelector(req.body);
        if (selector.name !== routeParam(req.params.name)) return res.status(400).json({ ok: false, error: "Skill 选择无效" });
        const data = await configureCodexSkill(emit, workspace.workspacePath, selector, req.body.enabled);
        session.emitAll("skills_changed", { forceReload: true });
        res.json({ ok: true, data });
    }));
    app.post("/agent/codex/skills/:name/delete", codexMutation(async (req, res) => {
        await skillStore.delete(routeParam(req.params.name), String(req.body?.expectedRevision || ""));
        session.emitAll("skills_changed", { forceReload: true });
        res.json({ ok: true });
    }));
    app.post("/agent/codex/skills/:name", codexMutation(async (req, res) => {
        const data = await skillStore.update(routeParam(req.params.name), req.body);
        session.emitAll("skills_changed", { forceReload: true });
        res.json({ ok: true, data });
    }));
    app.get("/agent/codex/threads", route(async (req, res) => {
        const workspace = ensureSiteWorkspace(config);
        const result = await listCodexThreads(emit, { cwd: workspace.workspacePath, searchTerm: String(req.query.searchTerm || "") });
        res.json({ ok: true, workspace, conversation: session.conversationStateSnapshot, ...result });
    }));
    // M5: aggregate per-thread task status for the global queue view. The running
    // 每个线程各自报「在跑 / 等输入 / 空闲」：多窗并行时不能只看站点激活线程，
    // 否则后台窗正在跑的那一轮在队列里会显示成空闲（B3：队列要看出谁在跑）。
    app.get("/agent/queue", route(async (_req, res) => {
        const workspace = ensureSiteWorkspace(config);
        const result = await listCodexThreads(emit, { cwd: workspace.workspacePath });
        const codex = session.codexStateSnapshot;
        const conversation = session.conversationStateSnapshot;
        const pendingApprovals = session.codexPendingApprovals;
        const activeThreadId = workspace.activeThreadId || codex.threadId || conversation.threadId || "";
        const busyThreadIds = session.busyThreadIds;
        const runningThreadIds = [...busyThreadIds, ...claudeRunningThreadIds()];
        type QueueStatus = "waiting-input" | "approval" | "running" | "idle" | "failed";
        const data = (result.data || []).map((thread) => {
            const active = Boolean(activeThreadId) && thread.id === activeThreadId;
            const running = runningThreadIds.includes(thread.id);
            let status: QueueStatus = "idle";
            let waitingFor = "";
            if (pendingApprovals.some((item) => !item.threadId || item.threadId === thread.id) && (running || active)) {
                status = "approval";
                waitingFor = String(pendingApprovals.find((item) => !item.threadId || item.threadId === thread.id)?.method || "approval");
            } else if (running) {
                status = "running";
            } else if (active && conversation.status === "failed") {
                status = "failed";
            } else if (active && conversation.status === "preparing") {
                status = "waiting-input";
            }
            return { id: thread.id, title: thread.name || thread.preview || thread.id, source: thread.source, status, active, running, waitingFor, updatedAt: thread.updatedAt || 0, createdAt: thread.createdAt || 0 };
        });
        // H2：队列里要能直接处置权限请求，光给条数不够 —— 每条都得带 requestId（审批凭据）
        // 与 threadId（归属哪个会话窗），否则前端只能把用户再送回面板去点一遍。
        const pendingApprovalRequests = pendingApprovals
            .map((item) => ({
                requestId: String(item.requestId || ""),
                threadId: String(item.threadId || ""),
                method: String(item.method || ""),
                reason: String(item.reason || ""),
            }))
            .filter((item) => item.requestId);
        res.json({ ok: true, workspace, conversation, codex, busyThreadIds: runningThreadIds, pendingApprovals: pendingApprovals.length, pendingApprovalRequests, data, updatedAt: Date.now() });
    }));
    app.post("/agent/codex/threads/new", codexMutation(async (req, res) => {
        const clientId = String(req.body?.clientId || "");
        session.beginConversation({ sourceClientId: clientId });
        setActiveThread("", { emptyThread: true, draftThread: true, sourceClientId: clientId }, true);
        const thread = await prepareDraftThread(clientId, permissionMode(req.body?.permissionMode), String(req.body?.repoId || ""));
        res.json({ ok: true, workspace: ensureSiteWorkspace(config), conversation: session.conversationStateSnapshot, thread: summarizeCodexThread(thread), messages: [] });
    }));
    app.post("/agent/codex/threads/reset", codexMutation(async (req, res) => {
        const clientId = String(req.body?.clientId || "");
        session.beginConversation({ sourceClientId: clientId });
        setActiveThread("", { emptyThread: true, draftThread: true, sourceClientId: clientId }, true);
        await prepareDraftThread(clientId, permissionMode(req.body?.permissionMode), String(req.body?.repoId || ""));
        res.json({ ok: true, workspace: ensureSiteWorkspace(config), conversation: session.conversationStateSnapshot });
    }));
    app.get("/agent/codex/threads/:threadId", route(async (req, res) => {
        const workspace = ensureSiteWorkspace(config);
        const threadId = routeParam(req.params.threadId);
        res.json({ ok: true, workspace, conversation: session.conversationStateSnapshot, ...(await readCodexThread(emit, threadId, workspace.workspacePath)) });
    }));
    app.post("/agent/codex/history/ack", (req, res) => {
        const threadId = String(req.body?.threadId || "");
        const turnIds = Array.isArray(req.body?.turnIds) ? req.body.turnIds.map(String) : [];
        session.acknowledgeCodexHistory(threadId, turnIds);
        res.json({ ok: true });
    });
    app.post("/agent/codex/threads/:threadId/resume", codexThreadMutation((req: Request) => routeParam(req.params.threadId), async (req: Request, res: Response) => {
        const threadId = routeParam(req.params.threadId);
        const clientId = String(req.body?.clientId || "");
        try {
            const result = await prepareExistingThread(threadId, clientId, permissionMode(req.body?.permissionMode), String(req.body?.repoId || ""));
            const nextWorkspace = setActiveThread(threadId, { sourceClientId: clientId }, true);
            res.json({ ok: true, workspace: nextWorkspace, conversation: session.conversationStateSnapshot, ...result });
        } catch (error) {
            failPreparedConversation(error, threadId, clientId);
            throw error;
        }
    }));
    app.post("/agent/codex/threads/:threadId/delete", codexMutation(async (req, res) => {
        const workspace = ensureSiteWorkspace(config);
        const threadId = routeParam(req.params.threadId);
        await archiveCodexThread(emit, threadId, workspace.workspacePath);
        const nextWorkspace = setActiveThread(workspace.activeThreadId === threadId ? "" : workspace.activeThreadId || "", { sourceClientId: String(req.body?.clientId || "") });
        res.json({ ok: true, workspace: nextWorkspace, conversation: session.conversationStateSnapshot });
    }));
    app.post("/agent/codex/turn", codexThreadMutation((req: Request) => String(req.body?.threadId || ""), async (req: Request, res: Response) => {
        const attachments = Array.isArray(req.body?.attachments) ? (req.body.attachments as AgentAttachment[]) : [];
        const canvasAttachments = Array.isArray(req.body?.canvasAttachments) ? (req.body.canvasAttachments as AgentAttachment[]) : [];
        const imageChannelReady = req.body?.imageChannelReady !== false;
        const workspace = ensureSiteWorkspace(config);
        const prompt = String(req.body?.prompt || "");
        if (!prompt.trim()) return res.status(400).json({ ok: false, error: "请输入任务内容" });
        const clientId = String(req.body?.clientId || "");
        if (!clientId || !session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起任务的网页已断开，请重新连接后再试" });
        const requestedThreadId = String(req.body?.threadId || "");
        const activeThreadId = workspace.activeThreadId || "";
        const conversation = session.conversationStateSnapshot;
        const requestedConversationId = String(req.body?.conversationId || "");
        const expectedRevision = Number(req.body?.expectedRevision || 0);
        const activeThreadTurn = requestedThreadId === activeThreadId && conversation.threadId === activeThreadId;
        const backgroundThreadTurn = requestedThreadId !== activeThreadId && session.isThreadReadyForTurn(requestedThreadId);
        if (!activeThreadTurn && !backgroundThreadTurn) {
            return res.status(409).json({ ok: false, code: "CONVERSATION_STALE", error: "当前会话已切换，已同步最新状态，请确认后重试", state: conversation });
        }
        if (activeThreadTurn && (!activeThreadId || !["ready", "warning"].includes(conversation.status))) {
            return res.status(409).json({ ok: false, code: "CONVERSATION_NOT_READY", error: "Codex 对话仍在初始化，请等待 MCP 加载完成", state: conversation });
        }
        const model = String(req.body?.model || "") || undefined;
        const effort = reasoningEffort(req.body?.effort);
        const skill = req.body?.skill === undefined ? undefined : await resolveCodexSkill(emit, workspace.workspacePath, skillSelector(req.body.skill), true);
        const turnCwd = resolveCodexCwd({ repoId: req.body?.repoId, cwd: req.body?.cwd });
        const messageId = String(req.body?.messageId || Date.now());
        const messageText = String(req.body?.messageText || prompt || `发送了 ${attachments.length} 张图片`);
        const messageMetadata = await messageMetadataStore.recordPending(messageId, req.body?.messageMetadata);
        let threadId = backgroundThreadTurn ? requestedThreadId : activeThreadId;
        logger.info("Codex turn accepted", { threadId: req.body?.threadId, model: model || "default", reasoningEffort: effort || "default", promptLength: prompt.length, attachmentCount: attachments.length });
        session.bindClient(clientId);
        session.markConversationRunning(threadId);
        session.setCodexState({ busy: true, threadId, turnId: "" });
        try {
            let turnId = "";
            const attachmentRefs = session.setTurnAttachments(clientId, [...attachments, ...canvasAttachments]);
            session.emitThread("chat_message", threadId, {
                sourceClientId: clientId,
                message: { id: `${threadId}:pending:synthetic:user`, itemId: "synthetic:user", clientMessageId: messageId, threadId, turnId: "", role: "user", text: messageText, ...messageMetadata },
            });
            let chatTurnId = "";
            /** 将包装层日志和兜底错误固定广播到当前 turn。 */
            const lifecycleEmit = (type: string, payload: unknown) => {
                const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : { value: payload };
                const eventThreadId = String(value.threadId || value.thread_id || threadId);
                const eventTurnId = String(value.turnId || value.turn_id || turnId);
                const sourceClientId = String(value.sourceClientId || clientId);
                session.emitThread(type, eventThreadId, {
                    ...value,
                    threadId: eventThreadId,
                    thread_id: eventThreadId,
                    ...(eventTurnId ? { turnId: eventTurnId, turn_id: eventTurnId } : {}),
                    ...(sourceClientId ? { sourceClientId } : {}),
                });
            };
            void runCodexTurn(buildTurnContextPrompt(prompt, turnContextAttachments(attachmentRefs), imageChannelReady), lifecycleEmit, [...attachments, ...canvasAttachments], {
                threadId,
                cwd: turnCwd,
                permissionMode: permissionMode(req.body?.permissionMode),
                model,
                effort,
                ...(skill ? { skill: { name: skill.name, path: skill.path } } : {}),
                messageText,
                appEmit: emit,
                onStart: () => session.bindClient(clientId),
                onThread: (actualThreadId) => {
                    const threadChanged = actualThreadId !== threadId;
                    void messageMetadataStore.bindThread(messageId, actualThreadId).catch((error) => logger.warn("Failed to bind message metadata to thread", { clientMessageId: messageId, threadId: actualThreadId, error }));
                    if (actualThreadId !== threadId) {
                        threadId = actualThreadId;
                        setActiveThread(threadId, { emptyThread: true, sourceClientId: clientId });
                    }
                    session.markConversationRunning(threadId);
                    session.setCodexState({ busy: true, threadId, turnId: "" });
                    if (threadChanged) {
                        session.emitThread("chat_message", threadId, {
                            sourceClientId: clientId,
                            message: { id: `${threadId}:pending:synthetic:user`, itemId: "synthetic:user", clientMessageId: messageId, threadId, turnId: "", role: "user", text: messageText, ...messageMetadata },
                        });
                    }
                },
                onTurn: (actualTurnId) => {
                    turnId = actualTurnId;
                    void messageMetadataStore.bindTurn(messageId, threadId, turnId).catch((error) => logger.warn("Failed to bind message metadata to turn", { clientMessageId: messageId, threadId, turnId, error }));
                    if (chatTurnId !== turnId) {
                        chatTurnId = turnId;
                        session.emitThread("chat_message", threadId, {
                            turnId,
                            sourceClientId: clientId,
                            message: { id: `${threadId}:${turnId}:synthetic:user`, itemId: "synthetic:user", clientMessageId: messageId, threadId, turnId, role: "user", text: messageText, ...messageMetadata },
                        });
                    }
                    logger.info("Codex turn started", { threadId, turnId, model: model || "default", reasoningEffort: effort || "default" });
                    session.setCodexState({ busy: true, threadId, turnId });
                },
                onFinish: () => {
                    logger.info("Codex turn finished", { threadId, turnId });
                    if (!turnId) void messageMetadataStore.remove(messageId, threadId).catch((error) => logger.warn("Failed to remove unbound message metadata", { clientMessageId: messageId, error }));
                    session.clearTurnAttachments(clientId);
                    if (clientId) session.releaseClient(clientId);
                    session.setCodexState({ busy: false, threadId, turnId });
                    session.finishConversationRun(threadId);
                },
            });
            res.json({ ok: true, threadId });
        } catch (error) {
            await messageMetadataStore.remove(messageId, threadId).catch((metadataError) => logger.warn("Failed to remove rejected message metadata", { clientMessageId: messageId, error: metadataError }));
            session.releaseClient(clientId);
            session.setCodexState({ busy: false, threadId, turnId: "" });
            session.finishConversationRun(threadId);
            throw error;
        }
    }));

    /** 将 Codex 写操作串行化，避免多窗口在异步请求期间交叉修改会话。 */
    function codexMutation(handler: (req: Request, res: Response) => unknown | Promise<unknown>, threadIdOf?: (req: Request) => string) {
        return route(async (req, res) => {
            if (!session.beginCodexMutation(threadIdOf?.(req) || undefined)) return res.status(409).json({ ok: false, code: "CONVERSATION_BUSY", error: "Codex 正在运行或正在切换会话，请稍后重试", state: session.conversationStateSnapshot });
            try {
                return await handler(req, res);
            } finally {
                session.endCodexMutation();
            }
        });
    }
    /** 同 codexMutation，但先按请求线程判锁，供 turn / resume 等按线程并行的端点使用。 */
    function codexThreadMutation(threadIdOf: (req: Request) => string, handler: (req: Request, res: Response) => unknown | Promise<unknown>) {
        return codexMutation(handler, threadIdOf);
    }
    app.post("/agent/codex/approval", route(async (req, res) => {
        const decision = String(req.body?.decision || "");
        if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) return res.status(400).json({ ok: false, error: "无效的审批决定" });
        const ok = await resolveCodexApproval(String(req.body?.requestId || ""), decision);
        res.status(ok ? 200 : 409).json({ ok, ...(ok ? {} : { error: "审批请求已失效" }) });
    }));
    app.post("/agent/codex/interrupt", route(async (req, res) => {
        const ok = await interruptCodexTurn(skillDraftRunning ? undefined : String(req.body?.threadId || ""));
        res.status(ok ? 200 : 409).json({ ok, ...(ok ? {} : { error: "当前没有可停止的任务" }) });
    }));
    // M5: Claude Code 作为第二家 driver。线程 / 历史 / 中断与 Codex 对齐，
    // 返回值统一成 Codex 的响应形状，前端只切路径前缀、不写第二套面板逻辑。
    app.get("/agent/drivers", route(async (_req, res) => {
        res.json({ ok: true, data: await driverInventory() });
    }));
    app.get("/agent/claude/workspace", (_req, res) => {
        res.json({ ok: true, workspace: claudeWorkspace() });
    });
    app.get("/agent/claude/models", (_req, res) => {
        res.json({ ok: true, data: CLAUDE_MODELS.map((model) => ({ id: model.id, model: model.id, displayName: model.displayName, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }], isDefault: Boolean(model.isDefault) })) });
    });
    app.get("/agent/claude/threads", (_req, res) => {
        res.json({ ok: true, workspace: claudeWorkspace(), conversation: claudeConversation(""), data: claudeThreadStore.list().map(codexThreadSummary), running: claudeRunningThreadIds() });
    });
    app.post("/agent/claude/threads/new", (req, res) => {
        const thread = claudeThreadStore.create({ name: typeof req.body?.name === "string" ? req.body.name : undefined, cwd: typeof req.body?.cwd === "string" ? req.body.cwd : ensureSiteWorkspace(config).workspacePath });
        res.json({ ok: true, workspace: claudeWorkspace(thread.id), conversation: claudeConversation(thread.id), thread: codexThreadSummary(thread), messages: [] });
    });
    // 面板的「新对话」走 reset，语义与 new 相同；保留两个入口是为了不改前端调用点。
    app.post("/agent/claude/threads/reset", (req, res) => {
        const thread = claudeThreadStore.create({ cwd: ensureSiteWorkspace(config).workspacePath });
        res.json({ ok: true, workspace: claudeWorkspace(thread.id), conversation: claudeConversation(thread.id), thread: codexThreadSummary(thread), messages: [] });
    });
    app.get("/agent/claude/threads/:threadId", (req, res) => {
        const thread = claudeThreadStore.get(String(req.params.threadId));
        if (!thread) return void res.status(404).json({ ok: false, error: "thread not found" });
        res.json({ ok: true, workspace: claudeWorkspace(thread.id), conversation: claudeConversation(thread.id), thread: codexThreadSummary(thread), messages: claudeMessages(thread), settledTurnIds: [], historyReady: true });
    });
    app.post("/agent/claude/threads/:threadId/resume", (req, res) => {
        const thread = claudeThreadStore.touch(String(req.params.threadId), { cwd: typeof req.body?.cwd === "string" ? req.body.cwd : undefined });
        if (!thread) return void res.status(404).json({ ok: false, error: "thread not found" });
        res.json({ ok: true, workspace: claudeWorkspace(thread.id), conversation: claudeConversation(thread.id), thread: codexThreadSummary(thread), messages: claudeMessages(thread), settledTurnIds: [], historyReady: true });
    });
    app.post("/agent/claude/threads/:threadId/delete", (req, res) => {
        const threadId = String(req.params.threadId);
        if (claudeRunningThreadIds().includes(threadId)) interruptClaudeTurn(threadId);
        const removed = claudeThreadStore.remove(threadId);
        res.status(removed ? 200 : 404).json({ ok: removed, ...(removed ? {} : { error: "thread not found" }) });
    });
    app.post("/agent/claude/turn", (req, res) => {
        const threadId = String(req.body?.threadId || "");
        const accepted = runClaudeTurn({
            threadId,
            prompt: String(req.body?.prompt || ""),
            cwd: typeof req.body?.cwd === "string" ? req.body.cwd : undefined,
            permissionMode: permissionMode(req.body?.permissionMode),
            model: typeof req.body?.model === "string" ? req.body.model : undefined,
        }, emit);
        if (!accepted) return void res.status(400).json({ ok: false, error: "prompt required" });
        res.json({ ok: true, threadId, turnId: `claude-turn-${Date.now().toString(36)}` });
    });
    app.post("/agent/claude/interrupt", (req, res) => {
        const ok = interruptClaudeTurn(String(req.body?.threadId || ""));
        res.status(ok ? 200 : 409).json({ ok, ...(ok ? {} : { error: "当前没有可停止的任务" }) });
    });
    // Claude 线程历史由桥端自己落盘，没有 Codex 那种 turn 级 ack 语义。
    app.post("/agent/claude/history/ack", (_req, res) => res.json({ ok: true }));
    // 逐条工具审批是 Codex 的机制；Claude 走 --permission-mode，这里明确拒绝而不是假装成功。
    app.post("/agent/claude/approval", (_req, res) => res.status(409).json({ ok: false, error: "claude driver 使用 permission-mode，不支持逐条审批" }));
    // 技能面板在 Claude driver 下暂无技能来源；返回空列表 + 说明，不报错也不造假数据。
    app.get("/agent/claude/skills", (_req, res) => res.json({ ok: true, data: [], note: "claude driver 暂不支持技能市场" }));
    app.use((_req, res) => res.status(404).json({ ok: false, error: "not found" }));
    app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
        logger.error("HTTP request failed", { method: req.method, path: req.path, error });
        if (error instanceof SkillStoreError || error instanceof CodexSkillLookupError) return void res.status(error.statusCode).json({ ok: false, error: error.message });
        if (error instanceof RepoPathError) return void res.status(error.statusCode).json({ ok: false, error: error.message });
        res.status(500).json({ ok: false, error: error.message });
    });

    const server = app.listen(port, "127.0.0.1", () => {
        console.log("CanvasAgents Agent");
        if (!options.skipVersionCheck) checkVersions();
        console.log(`Local URL: ${config.url}`);
        console.log(`Connect token: ${config.token}`);
        console.log("Codex MCP is not installed by this command.");
        console.log("Optional MCP add: codex mcp add canvasagents -- npx -y canvasagents-agent@latest mcp");
        console.log("Remove manually added MCP: codex mcp remove canvasagents");
        if (logger.enabled) console.log(`Debug log: ${logger.filePath}`);
        logger.info("Canvas Agent started", { url: config.url, workspace: ensureSiteWorkspace(config).workspacePath, debugLog: logger.filePath });
        const activeThreadId = initialWorkspace.activeThreadId || "";
        if (activeThreadId && session.beginCodexMutation()) {
            void prepareExistingThread(activeThreadId).catch(async (error) => {
                if (!isRecoverableThreadError(error)) return failPreparedConversation(error, activeThreadId);
                session.beginConversation();
                setActiveThread("", { emptyThread: true, draftThread: true }, true);
                await prepareDraftThread("", "request");
            }).finally(() => session.endCodexMutation()).catch(() => undefined);
        }
    });
    terminalManager.registerHttp(server, (req, url) => validToken(req as unknown as Parameters<typeof validToken>[0], url, config.token));
    return server;
}

/** 将异步 Express 路由异常交给统一错误处理中间件。 */
function route(handler: (req: Request, res: Response) => Promise<unknown>) {
    return (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next);
}

/** 从请求查询参数中解析已注册仓库；显式传入的 repoId 未注册时返回 undefined，缺省时回退 activeRepoId。 */
function repoForRequest(config: CanvasAgentConfig, value: unknown) {
    const repoId = String(value ?? "").trim();
    if (repoId) return findRepo(config, repoId);
    return findRepo(config, config.activeRepoId || "");
}

/** 从 Express 路由参数中读取单个字符串。 */
function routeParam(value: string | string[]) {
    return Array.isArray(value) ? value[0] || "" : value;
}

function permissionMode(value: unknown): AgentPermissionMode {
    return value === "automatic" || value === "full" ? value : "request";
}

function reasoningEffort(value: unknown): CodexReasoningEffort | undefined {
    return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra" ? value : undefined;
}

function startupStatus(value: unknown): "starting" | "ready" | "failed" | "cancelled" {
    return value === "starting" || value === "ready" || value === "failed" ? value : "cancelled";
}

function mcpInventory(value: unknown) {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const server = item as Record<string, unknown>;
        const name = String(server.name || "");
        return name ? [{ name, authStatus: String(server.authStatus || "") || undefined }] : [];
    });
}

/** 读取浏览器提交的 Skill 选择器；真实路径随后必须通过原生列表校验。 */
function skillSelector(value: unknown): CodexSkillSelector {
    const selector = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const name = typeof selector.name === "string" ? selector.name : "";
    const skillPath = typeof selector.path === "string" ? selector.path : "";
    if (!name || !skillPath) throw new CodexSkillLookupError("Skill 选择无效", 400);
    return { name, path: skillPath };
}

/** 使用当前操作系统的文件管理器定位本地文件。 */
function revealLocalFile(filePath: string, isDirectory: boolean) {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
    const args = process.platform === "darwin"
        ? ["-R", filePath]
        : process.platform === "win32"
            ? [isDirectory ? filePath : `/select,${filePath}`]
            : [isDirectory ? filePath : path.dirname(filePath)];
    return new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { detached: true, stdio: "ignore" });
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
        child.once("error", reject);
    });
}

/** 结合服务配置解析当前请求 URL。 */
function requestUrl(req: Request, config: CanvasAgentConfig) {
    return new URL(req.originalUrl || req.url || "/", config.url);
}

/** 设置跨域响应头并记录通过 token 授权的来源。 */
function setCors(req: Request, res: Response, url: URL, config: CanvasAgentConfig) {
    const origin = req.headers.origin;
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type,x-canvas-agent-token");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    if (!origin || req.method === "OPTIONS" || url.pathname === "/health" || url.pathname === "/config") return true;
    config.origins ||= [];
    if (validToken(req, url, config.token) && !config.origins.includes(origin)) {
        config.origins.push(origin);
        saveConfig(config);
    }
    res.setHeader("Vary", "Origin");
    return config.origins.includes(origin);
}

/** 校验请求查询参数或请求头中的连接 token。 */
function validToken(req: Request, url: URL, token: string) {
    const header = req.headers["x-canvas-agent-token"];
    return url.searchParams.get("token") === token || header === token || (Array.isArray(header) && header.includes(token));
}

/** 向 Agent 提示词追加本轮图片附件引用说明。 */
function withAttachmentContext(prompt: string, attachments: Array<{ id: string; name: string; source?: "upload" | "canvas"; canvasNodeId?: string }>, imageChannelReady: boolean) {
    const uploaded = attachments.filter((item) => item.source !== "canvas");
    const onCanvas = attachments.filter((item) => item.source === "canvas");
    const sections: string[] = [];
    if (attachments.length) {
        const list = attachments.map((item, index) => {
            const origin = item.source === "canvas" ? `画布已有素材，画布节点 nodeId=${JSON.stringify(item.canvasNodeId || "")}` : "用户本轮上传";
            return `${index + 1}. attachmentId=${item.id}, name=${JSON.stringify(item.name)}, 来源=${origin}`;
        }).join("\n");
        const rules: string[] = [];
        if (uploaded.length) rules.push("用户本轮上传的图片：需要放入画布或作为生成参考图时，先调用 canvas_create_attachment_nodes，再使用返回的画布节点 ID 创建生成流程。");
        if (onCanvas.length) rules.push(`画布已有素材（共 ${onCanvas.length} 个）：这些图片已经在当前画布上，直接把它们上面的 nodeId 作为参考节点使用；禁止对它们调用 canvas_create_attachment_nodes——那会在画布上产生完全重复的图片节点。`);
        sections.push(`本轮可用图片附件（顺序与图片输入一致）：\n${list}\n${rules.join("\n")}`);
    }
    if (!imageChannelReady) {
        sections.push("当前网页没有可用的生图通道（未配置图片模型的 Base URL / API Key）：任何需要产出图片的任务必须使用 Codex 内置 imagegen 技能完成，不要调用 canvas_generate_image、canvas_generate_image_prompt_flow 或 canvas_run_generation——它们会被网页侧拦截并且不会产出任何图片。内置生图完成后，其结果会由 Canvas Agent 自动展示到对话并插入当前画布。");
    }
    if (!sections.length) return prompt;
    return `${prompt}\n\n${sections.join("\n\n")}`;
}

/** Claude driver 的 workspace 视图：与 Codex 的 AgentWorkspace 同形。 */
function claudeWorkspace(activeThreadId = ""): { workspacePath: string; activeThreadId?: string } {
    const latest = activeThreadId || claudeThreadStore.list()[0]?.id || "";
    return { workspacePath: "", activeThreadId: latest || undefined };
}

/** 让前端复用同一套 conversation 状态机：Claude 永远 ready，没有 MCP 预热。 */
function claudeConversation(threadId: string) {
    return { revision: 1, conversationId: threadId, threadId, status: "ready" as const, mcpStatuses: {} };
}

/** Claude 线程 → Codex 线程摘要形状（字段名保持一致，值不编造）。 */
function codexThreadSummary(thread: { id: string; name?: string; preview: string; cwd?: string; createdAt: number; updatedAt: number }) {
    return { id: thread.id, preview: thread.preview, name: thread.name ?? null, cwd: thread.cwd, status: "idle", createdAt: thread.createdAt, updatedAt: thread.updatedAt };
}

/** Claude 消息 → 面板渲染用的 AgentChatItem 形状。 */
function claudeMessages(thread: { id: string; messages: Array<{ role: "user" | "assistant"; text: string; at: number }> }) {
    return thread.messages.map((message, index) => ({ id: `${thread.id}-${index}`, threadId: thread.id, role: message.role, text: message.text, meta: new Date(message.at).toISOString() }));
}
