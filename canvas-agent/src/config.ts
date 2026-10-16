import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 17371;
export const CONFIG_DIR = path.join(os.homedir(), ".canvasagents");
export const CONFIG_FILE = path.join(CONFIG_DIR, "canvas-agent.json");
export const VERSION = readPackageVersion();
export const AGENT_PROMPT = fs.readFileSync(new URL("../agent-instructions.md", import.meta.url), "utf8");
const initializedWorkspaces = new Set<string>();

export type SiteWorkspaceConfig = { workspacePath: string; activeThreadId?: string; pinnedThreadIds?: string[] };
export type SiteRepo = { id: string; name: string; path: string };
export type CanvasAgentConfig = { url: string; token: string; origins?: string[]; workspace?: SiteWorkspaceConfig; repos?: SiteRepo[]; activeRepoId?: string };
export type RepoGitInfo = { isGit: boolean; branch?: string };

/** 读取本地 Canvas Agent 配置，不存在时生成默认配置。 */
export function loadConfig(create = false): CanvasAgentConfig {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as CanvasAgentConfig;
    } catch {
        const config = { url: `http://127.0.0.1:${Number(process.env.PORT) || DEFAULT_PORT}`, token: crypto.randomBytes(18).toString("hex") };
        if (create) saveConfig(config);
        return config;
    }
}

/** 将 Canvas Agent 配置写入用户配置目录。 */
export function saveConfig(config: CanvasAgentConfig) {
    writeConfigFile(CONFIG_DIR, CONFIG_FILE, config);
}

/** 写入配置并强制目录 0700、文件 0600，包括纠正已有宽松权限。 */
export function writeConfigFile(dir: string, file: string, config: CanvasAgentConfig) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(file, 0o600);
}

/** 确保站点级 Codex 工作空间存在并已初始化。 */
export function ensureSiteWorkspace(config: CanvasAgentConfig) {
    const current = config.workspace;
    if (current?.workspacePath) {
        const workspacePath = resolveWorkspacePath(current.workspacePath);
        initializeWorkspace(workspacePath);
        return { ...current, workspacePath };
    }
    const workspacePath = path.join(CONFIG_DIR, "codex-workspaces", "site");
    config.workspace = { workspacePath };
    initializeWorkspace(workspacePath);
    saveConfig(config);
    return { workspacePath };
}

/** 更新站点级 Codex 工作空间配置。 */
export function updateSiteWorkspace(config: CanvasAgentConfig, patch: Partial<SiteWorkspaceConfig>) {
    const current = ensureSiteWorkspace(config);
    const workspacePath = patch.workspacePath ? resolveWorkspacePath(patch.workspacePath) : current.workspacePath;
    const next = { ...current, ...patch, workspacePath };
    config.workspace = { workspacePath: next.workspacePath, activeThreadId: next.activeThreadId, pinnedThreadIds: next.pinnedThreadIds };
    initializeWorkspace(workspacePath);
    saveConfig(config);
    return config.workspace;
}

/** 由仓库绝对路径派生稳定 ID，同一路径始终得到同一 ID。 */
export function deriveRepoId(repoPath: string) {
    return `repo-${crypto.createHash("sha1").update(path.resolve(repoPath)).digest("hex").slice(0, 10)}`;
}

/** 按 ID 查找已注册仓库，未注册时返回 undefined。 */
export function findRepo(config: CanvasAgentConfig, id: string) {
    if (!id) return undefined;
    return (config.repos || []).find((repo) => repo.id === id);
}

/** 注册仓库；同一路径重复注册幂等，返回已存在的记录。 */
export function upsertRepo(config: CanvasAgentConfig, repoPath: string, name?: string): SiteRepo {
    const resolved = path.resolve(repoPath);
    const id = deriveRepoId(resolved);
    config.repos ||= [];
    const existing = config.repos.find((repo) => repo.path === resolved) || config.repos.find((repo) => repo.id === id);
    if (existing) {
        if (name && name.trim()) existing.name = name.trim();
        return existing;
    }
    const repo: SiteRepo = { id, name: name?.trim() || path.basename(resolved) || resolved, path: resolved };
    config.repos.push(repo);
    return repo;
}

/** 删除已注册仓库，并清理指向它的 activeRepoId。 */
export function removeRepo(config: CanvasAgentConfig, id: string) {
    const repos = config.repos || [];
    const index = repos.findIndex((repo) => repo.id === id);
    if (index < 0) return false;
    repos.splice(index, 1);
    if (config.activeRepoId === id) config.activeRepoId = "";
    return true;
}

/** 检测目录是否为 git 仓库，并尽量从 .git/HEAD 读取当前分支。 */
export function readRepoGitInfo(repoPath: string): RepoGitInfo {
    const marker = path.join(repoPath, ".git");
    let info: fs.Stats;
    try {
        info = fs.statSync(marker);
    } catch {
        return { isGit: false };
    }
    if (info.isFile()) return { isGit: true };
    try {
        const head = fs.readFileSync(path.join(marker, "HEAD"), "utf8").trim();
        const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return match ? { isGit: true, branch: match[1] } : { isGit: true };
    } catch {
        return { isGit: true };
    }
}

/** 创建工作空间目录并写入默认 AGENTS.md。 */
function initializeWorkspace(workspacePath: string) {
    if (initializedWorkspaces.has(workspacePath)) return;
    fs.mkdirSync(workspacePath, { recursive: true });
    const instructionsFile = path.join(workspacePath, "AGENTS.md");
    const current = fs.existsSync(instructionsFile) ? fs.readFileSync(instructionsFile, "utf8") : "";
    if (!current || current.startsWith("# CanvasAgents Agent")) fs.writeFileSync(instructionsFile, AGENT_PROMPT);
    initializedWorkspaces.add(workspacePath);
}

/** 将用户输入的工作空间路径解析为绝对路径。 */
function resolveWorkspacePath(value: string) {
    if (value === "~") return os.homedir();
    if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
    return path.resolve(value);
}

/** 从当前包信息中读取 Canvas Agent 版本号。 */
function readPackageVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
        return pkg.version || "0.0.0";
    } catch {
        return "0.0.0";
    }
}
