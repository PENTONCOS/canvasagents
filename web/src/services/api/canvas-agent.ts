import i18n from "@/i18n";
import { agentApiPath } from "@/lib/agent/agent-driver";
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { AgentReasoningEffort } from "@/stores/use-agent-store";

type AgentConfigResponse = { ok?: boolean; protocolVersion?: number; url?: string; token?: string; hasToken?: boolean };
const AGENT_MESSAGE_ASSET_PATTERN = /^agent-asset:([a-f0-9]{64})\/([a-f0-9]{64}\.(?:gif|jpe?g|png|webp))$/;

export class AgentApiError<T = unknown> extends Error {
    constructor(readonly status: number, readonly response: T & { code?: string; error?: string; msg?: string }) {
        super(response.error || response.msg || i18n.t("agent.state.requestFailed"));
        this.name = "AgentApiError";
    }
}

export type AgentSkillScope = "user" | "repo" | "system" | "admin";
export type AgentSkillInterface = { displayName?: string | null; shortDescription?: string | null; defaultPrompt?: string | null };
export type AgentSkillSummary = {
    name: string;
    description: string;
    shortDescription?: string | null;
    interface?: AgentSkillInterface | null;
    dependencies?: unknown;
    path: string;
    scope: AgentSkillScope;
    enabled: boolean;
    managed: boolean;
};
export type AgentSkillDetail = {
    name: string;
    description: string;
    instructions: string;
    interface?: AgentSkillInterface | null;
    path: string;
    managed: true;
    revision: string;
};
export type AgentSkillInput = { name?: string; description: string; instructions: string; interface?: AgentSkillInterface | null; expectedRevision?: string };
export type AgentSkillDraft = { name: string; displayName: string; description: string; instructions: string; shortDescription: string; defaultPrompt: string };
export type AgentSkillDraftInput = { source: "conversation" | "canvas"; threadId: string; clientId: string; model?: string; effort?: AgentReasoningEffort };
export type AgentSkillsResponse = { ok?: boolean; data?: AgentSkillSummary[]; errors?: unknown[] };
export type AgentSkillResponse = { ok?: boolean; data?: AgentSkillDetail };
export type AgentSkillDraftResponse = { ok?: boolean; data?: AgentSkillDraft };

export async function postState(endpoint: string, token: string, clientId: string, snapshot: CanvasAgentSnapshot | null) {
    try {
        const response = await fetch(`${endpoint}/canvas/state?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(snapshot ? { ...snapshot, hasCanvas: true } : { hasCanvas: false }),
        });
        return response.ok;
    } catch {
        return false;
    }
}

export async function activateAgentClient(endpoint: string, token: string, clientId: string) {
    try {
        await fetch(`${endpoint}/canvas/activate?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`, { method: "POST" });
    } catch {}
}

export async function postToolResult(endpoint: string, token: string, clientId: string, body: { requestId: string; result?: unknown; error?: string }) {
    await fetchAgentJson(endpoint, token, `/canvas/result?clientId=${encodeURIComponent(clientId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export async function postCodexApproval(endpoint: string, token: string, requestId: string, decision: "accept" | "acceptForSession" | "decline") {
    await fetchAgentJson(endpoint, token, agentApiPath("/approval"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, decision }) });
}

export async function interruptCodexTurn(endpoint: string, token: string, threadId?: string) {
    await fetchAgentJson(endpoint, token, agentApiPath("/interrupt"), jsonPost({ threadId }));
}

export async function acknowledgeCodexHistory(endpoint: string, token: string, threadId: string, turnIds: string[]) {
    await fetchAgentJson(endpoint, token, agentApiPath("/history/ack"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId, turnIds }) });
}

export async function revealAgentLocalFile(endpoint: string, token: string, path: string) {
    await fetchAgentJson(endpoint, token, "/agent/local-file/reveal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
}

export function resolveAgentMessageAssetUrl(endpoint: string, token: string, value: string) {
    const match = AGENT_MESSAGE_ASSET_PATTERN.exec(value);
    if (!match) return value.startsWith("agent-asset:") ? "" : value;
    const baseUrl = endpoint.trim().replace(/\/$/, "");
    return baseUrl && token ? `${baseUrl}/agent/message-assets/${match[1]}/${match[2]}?token=${encodeURIComponent(token)}` : "";
}

export function fetchCodexSkills(endpoint: string, token: string, forceReload = false) {
    return fetchAgentJson<AgentSkillsResponse>(endpoint, token, agentApiPath(`/skills${forceReload ? "?forceReload=1" : ""}`));
}

export function fetchCodexSkill(endpoint: string, token: string, name: string) {
    return fetchAgentJson<AgentSkillResponse>(endpoint, token, agentApiPath(`/skills/${encodeURIComponent(name)}`));
}

export function createCodexSkill(endpoint: string, token: string, input: AgentSkillInput) {
    return fetchAgentJson<AgentSkillResponse>(endpoint, token, agentApiPath("/skills"), jsonPost(input));
}

export function createCodexSkillDraft(endpoint: string, token: string, input: AgentSkillDraftInput) {
    return fetchAgentJson<AgentSkillDraftResponse>(endpoint, token, agentApiPath("/skills/draft"), jsonPost(input));
}

export function updateCodexSkill(endpoint: string, token: string, name: string, input: AgentSkillInput) {
    return fetchAgentJson<AgentSkillResponse>(endpoint, token, agentApiPath(`/skills/${encodeURIComponent(name)}`), jsonPost(input));
}

export function deleteCodexSkill(endpoint: string, token: string, name: string, expectedRevision: string) {
    return fetchAgentJson<{ ok?: boolean }>(endpoint, token, agentApiPath(`/skills/${encodeURIComponent(name)}/delete`), jsonPost({ expectedRevision }));
}

export function setCodexSkillEnabled(endpoint: string, token: string, skill: Pick<AgentSkillSummary, "name" | "path">, enabled: boolean) {
    return fetchAgentJson<{ ok?: boolean }>(endpoint, token, agentApiPath(`/skills/${encodeURIComponent(skill.name)}/enabled`), jsonPost({ ...skill, enabled }));
}

export async function fetchAgentJson<T>(endpoint: string, token: string, path: string, init?: RequestInit) {
    const url = `${endpoint}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    const res = await fetch(url, init);
    const data = (await res.json().catch(() => ({}))) as T & { error?: string; msg?: string };
    if (!res.ok) throw new AgentApiError(res.status, data);
    return data;
}

// G3: 产物墙。桥用 screencapture 截取画布窗口，落盘 ~/.canvasagents/wall，网页只做读取与手动触发。
export type AgentWallItem = { file: string; url: string; nodeId?: string; tag?: string; bytes: number; createdAt: number };
export type AgentWallResponse = { ok?: boolean; items?: AgentWallItem[] };
export type AgentCaptureResponse = { ok?: boolean; code?: string; error?: string; file?: string; url?: string; bytes?: number; windowId?: number; windowName?: string; strategy?: string };

/**
 * G3: 锁定截图窗口的标题标记。与 `app-providers` 写入的 document.title 一致，
 * 桥端用它把「画布那个窗」和「随便一个浏览器窗」区分开。
 */
export const CANVAS_WINDOW_MARKER = "CanvasAgents";

/** 优先用当前页真实标题（可能被页面改写），退回固定标记。 */
function windowTitleHint() {
    if (typeof document === "undefined") return CANVAS_WINDOW_MARKER;
    return document.title.trim() || CANVAS_WINDOW_MARKER;
}

export function fetchAgentWall(endpoint: string, token: string) {
    return fetchAgentJson<AgentWallResponse>(endpoint, token, "/agent/wall", { headers: repoAuthHeaders(token) });
}

export type AgentCaptureRequest = { nodeId?: string; tag?: string; windowTitle?: string; requireTitle?: boolean; force?: boolean };

/**
 * 默认带上窗口标题标记并要求「标题必须命中」：宁可拒绝，也不截错窗口。
 * 调用方显式传 windowTitle/requireTitle 可覆盖。
 */
export function requestAgentCapture(endpoint: string, token: string, body: AgentCaptureRequest) {
    const payload: AgentCaptureRequest = { windowTitle: windowTitleHint(), requireTitle: true, ...body };
    return fetchAgentJson<AgentCaptureResponse>(endpoint, token, "/agent/capture", { method: "POST", headers: repoAuthHeaders(token, true), body: JSON.stringify(payload) });
}

/** 画布侧自动沉淀：截图是旁路，失败不能影响 agent turn，所以静默吞错。 */
export function requestAgentCaptureSilently(endpoint: string, token: string, body: AgentCaptureRequest) {
    if (!endpoint || !token) return;
    void requestAgentCapture(endpoint, token, body).catch(() => undefined);
}

export function resolveAgentWallFileUrl(endpoint: string, token: string, file: string) {
    const baseUrl = endpoint.trim().replace(/\/$/, "");
    return baseUrl && token ? `${baseUrl}/agent/wall/${encodeURIComponent(file)}?token=${encodeURIComponent(token)}` : "";
}

// M5: code browser endpoints. The agent authenticates these with the x-canvas-agent-token
// header (same token the terminal bridge uses); fetchAgentJson still appends the query token
// so both auth styles keep working.
export type AgentRepoSummary = { id: string; name: string; path: string; isGit: boolean; branch?: string };
export type AgentReposResponse = { ok?: boolean; repos?: AgentRepoSummary[]; activeRepoId?: string };
export type AgentRepoResponse = { ok?: boolean; repo?: AgentRepoSummary };
export type AgentRepoTreeEntry = { path: string; name: string; type: "file" | "dir"; size?: number };
export type AgentRepoTreeResponse = { ok?: boolean; entries?: AgentRepoTreeEntry[]; truncated?: boolean };
export type AgentRepoFileResponse = { ok?: boolean; path?: string; content?: string; size?: number; truncated?: boolean; language?: string };
export type AgentRepoDiffResponse = { ok?: boolean; path?: string; diff?: string };

// M6: repo status powers the repo node summary (branch, dirty marker, last commit).
export type AgentRepoLastCommit = { sha?: string; subject?: string; author?: string; date?: string };
export type AgentRepoStatusResponse = {
    ok?: boolean;
    repoId?: string;
    name?: string;
    path?: string;
    isGit?: boolean;
    branch?: string;
    dirty?: boolean;
    ahead?: number;
    behind?: number;
    lastCommit?: AgentRepoLastCommit;
};

function repoAuthHeaders(token: string, json = false): Record<string, string> {
    return json ? { "content-type": "application/json", "x-canvas-agent-token": token } : { "x-canvas-agent-token": token };
}

export function fetchAgentRepos(endpoint: string, token: string) {
    return fetchAgentJson<AgentReposResponse>(endpoint, token, "/repos", { headers: repoAuthHeaders(token) });
}

export function createAgentRepo(endpoint: string, token: string, body: { path: string; name?: string }) {
    return fetchAgentJson<AgentRepoResponse>(endpoint, token, "/repos", { method: "POST", headers: repoAuthHeaders(token, true), body: JSON.stringify(body) });
}

export function fetchAgentRepoTree(endpoint: string, token: string, params: { repoId: string; path?: string; depth?: number }) {
    const query = new URLSearchParams();
    query.set("repoId", params.repoId);
    if (params.path) query.set("path", params.path);
    if (typeof params.depth === "number") query.set("depth", String(params.depth));
    return fetchAgentJson<AgentRepoTreeResponse>(endpoint, token, `/repo/tree?${query.toString()}`, { headers: repoAuthHeaders(token) });
}

export function fetchAgentRepoFile(endpoint: string, token: string, params: { repoId: string; path: string }) {
    const query = new URLSearchParams();
    query.set("repoId", params.repoId);
    query.set("path", params.path);
    return fetchAgentJson<AgentRepoFileResponse>(endpoint, token, `/repo/file?${query.toString()}`, { headers: repoAuthHeaders(token) });
}

export function fetchAgentRepoDiff(endpoint: string, token: string, params: { repoId: string; path?: string }) {
    const query = new URLSearchParams();
    query.set("repoId", params.repoId);
    if (params.path) query.set("path", params.path);
    return fetchAgentJson<AgentRepoDiffResponse>(endpoint, token, `/repo/diff?${query.toString()}`, { headers: repoAuthHeaders(token) });
}

// M6: /repo/status returns the branch/dirty/lastCommit summary the repo node renders.
export function fetchAgentRepoStatus(endpoint: string, token: string, params: { repoId: string }) {
    const query = new URLSearchParams();
    query.set("repoId", params.repoId);
    return fetchAgentJson<AgentRepoStatusResponse>(endpoint, token, `/repo/status?${query.toString()}`, { headers: repoAuthHeaders(token) });
}

// M7: image structure layer. The parser runs behind the agent bridge (the raw service has no
// CORS headers), so both calls authenticate with the same x-canvas-agent-token header as /repo/*.
export type AgentImageParseLang = "zh-Hans" | "en-US";
export type AgentImageParseBody = { image?: string; path?: string; options?: { lang?: AgentImageParseLang; maxRegions?: number } };
export type AgentImageParseResponse = {
    ok?: boolean;
    width?: number;
    height?: number;
    engine?: string;
    regions?: unknown[];
    warnings?: string[];
    error?: string;
};
export type AgentImageHealthResponse = { ok?: boolean; engine?: string; version?: string };

// POST /image/parse. A 502 body carries { ok:false, error }, surfaced through AgentApiError.message.
export function parseImageRegions(endpoint: string, token: string, body: AgentImageParseBody) {
    return fetchAgentJson<AgentImageParseResponse>(endpoint, token, "/image/parse", { method: "POST", headers: repoAuthHeaders(token, true), body: JSON.stringify(body) });
}

export function fetchImageParseHealth(endpoint: string, token: string) {
    return fetchAgentJson<AgentImageHealthResponse>(endpoint, token, "/image/health", { headers: repoAuthHeaders(token) });
}

export async function discoverAgentConfig(endpoint: string) {
    try {
        const res = await fetch(`${endpoint}/config`);
        if (!res.ok) return null;
        const data = (await res.json()) as AgentConfigResponse;
        return data.ok ? data : null;
    } catch {
        return null;
    }
}

function jsonPost(body: unknown): RequestInit {
    return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
