import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 目录树返回的条目上限。 */
export const MAX_TREE_ENTRIES = 2000;
/** 目录树允许的最大层级。 */
export const MAX_TREE_DEPTH = 4;
/** 目录树默认层级。 */
export const DEFAULT_TREE_DEPTH = 2;
/** 允许读取的单文件字节上限（2MB）。 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 单文件文本返回的字符上限。 */
export const MAX_FILE_CHARS = 200000;
/** 目录遍历时跳过的重量级目录。 */
export const SKIPPED_DIRECTORIES = new Set([
    "node_modules", ".git", "dist", "build", ".next", "out", "coverage",
    ".turbo", ".cache", ".output", "vendor", "target", "__pycache__", ".venv", "venv",
]);

/** 仓库路径非法（越界、类型不符、超限）时抛出的 400 级错误。 */
export class RepoPathError extends Error {
    readonly statusCode = 400;

    constructor(message: string) {
        super(message);
        this.name = "RepoPathError";
    }
}

export type RepoTreeEntry = { path: string; name: string; type: "file" | "dir"; size?: number };
export type RepoTreeResult = { root: string; entries: RepoTreeEntry[]; truncated: boolean };
export type RepoFileResult = { path: string; content: string; size: number; truncated: boolean; language?: string };
export type RepoDiffResult = { path?: string; diff: string };
export type RepoCommitInfo = { sha: string; subject: string; author: string; date: string };
/** 仓库状态；非 git 仓库仅返回 isGit:false，其余字段缺省。 */
export type RepoStatusResult = { isGit: boolean; branch?: string; dirty?: boolean; ahead?: number; behind?: number; lastCommit?: RepoCommitInfo };

/** 将仓库内相对路径解析为绝对路径；绝对路径或越界一律拒绝。 */
export function resolveRepoPath(root: string, relative: unknown) {
    const rootAbs = path.resolve(root);
    const value = String(relative ?? "").trim();
    if (value && path.isAbsolute(value)) throw new RepoPathError("不接受绝对路径");
    const target = value ? path.resolve(rootAbs, value) : rootAbs;
    const rel = path.relative(rootAbs, target);
    if (rel && (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) throw new RepoPathError("路径超出仓库范围");
    return target;
}

/** 读取仓库相对路径的目录树。 */
export async function buildRepoTree(root: string, relative: unknown = "", depth: unknown = DEFAULT_TREE_DEPTH): Promise<RepoTreeResult> {
    const rootAbs = path.resolve(root);
    const base = resolveRepoPath(rootAbs, relative);
    const baseInfo = await stat(base).catch(() => null);
    if (!baseInfo || !baseInfo.isDirectory()) throw new RepoPathError("目录不存在");
    const limit = Math.min(Math.max(Math.trunc(Number(depth)) || DEFAULT_TREE_DEPTH, 1), MAX_TREE_DEPTH);
    const baseRel = base === rootAbs ? "" : toPosix(path.relative(rootAbs, base));
    const entries: RepoTreeEntry[] = [];
    let truncated = false;
    const walk = async (absDir: string, relDir: string, level: number) => {
        const dirents = await readdir(absDir, { withFileTypes: true }).catch(() => []);
        dirents.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (const dirent of dirents) {
            if (entries.length >= MAX_TREE_ENTRIES) {
                truncated = true;
                return;
            }
            const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
            if (dirent.isDirectory()) {
                if (SKIPPED_DIRECTORIES.has(dirent.name)) continue;
                entries.push({ path: rel, name: dirent.name, type: "dir" });
                if (level < limit) await walk(path.join(absDir, dirent.name), rel, level + 1);
            } else if (dirent.isFile()) {
                if (dirent.name === ".DS_Store") continue;
                const info = await stat(path.join(absDir, dirent.name)).catch(() => null);
                entries.push({ path: rel, name: dirent.name, type: "file", ...(info ? { size: info.size } : {}) });
            }
        }
    };
    await walk(base, baseRel, 1);
    return { root: rootAbs, entries, truncated };
}

/** 读取仓库内文本文件；二进制或超过 2MB 时拒绝。 */
export async function readRepoFile(root: string, relative: unknown): Promise<RepoFileResult> {
    const rootAbs = path.resolve(root);
    if (!String(relative ?? "").trim()) throw new RepoPathError("缺少文件路径");
    const target = resolveRepoPath(rootAbs, relative);
    const info = await stat(target).catch(() => null);
    if (!info || !info.isFile()) throw new RepoPathError("文件不存在");
    if (info.size > MAX_FILE_BYTES) throw new RepoPathError(`文件超过 2MB 上限（${info.size} 字节），无法读取`);
    const buffer = await readFile(target);
    if (looksBinary(buffer)) throw new RepoPathError("不支持读取二进制文件");
    const text = buffer.toString("utf8");
    const truncated = text.length > MAX_FILE_CHARS;
    return {
        path: toPosix(path.relative(rootAbs, target)),
        content: truncated ? text.slice(0, MAX_FILE_CHARS) : text,
        size: info.size,
        truncated,
        language: languageForFile(target),
    };
}

/** 读取仓库的 git diff；调用方需先确认是 git 仓库。 */
export async function readRepoDiff(root: string, relative: unknown = ""): Promise<RepoDiffResult> {
    const rootAbs = path.resolve(root);
    const item = String(relative ?? "").trim();
    let diffPath = "";
    if (item) {
        const target = resolveRepoPath(rootAbs, item);
        diffPath = toPosix(path.relative(rootAbs, target));
    }
    try {
        const { stdout } = await execFileAsync("git", diffPath ? ["diff", "--", diffPath] : ["diff"], { cwd: rootAbs, maxBuffer: 8 * 1024 * 1024 });
        return { ...(diffPath ? { path: diffPath } : {}), diff: stdout };
    } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        throw new RepoPathError(`读取 git diff 失败：${text}`);
    }
}

/**
 * 读取仓库状态：分支、是否有未提交改动、相对上游的 ahead/behind、最近一次提交。
 * 非 git 仓库直接返回 isGit:false（不报错）；目录不存在时抛 400 级错误。
 * 任何 git 子命令失败都退化为缺省字段，不影响整体结果。
 */
export async function readRepoStatus(root: string): Promise<RepoStatusResult> {
    const rootAbs = path.resolve(root);
    const info = await stat(rootAbs).catch(() => null);
    if (!info || !info.isDirectory()) throw new RepoPathError("仓库目录不存在");
    if (!(await isGitRepository(rootAbs))) return { isGit: false };
    // 优先用 symbolic-ref：空仓库（尚无提交）也能读到分支名；detached HEAD 时回退到 rev-parse。
    const branch = (await gitOutput(rootAbs, ["symbolic-ref", "--short", "-q", "HEAD"])) || (await gitOutput(rootAbs, ["rev-parse", "--abbrev-ref", "HEAD"]));
    const porcelain = await gitOutput(rootAbs, ["status", "--porcelain"]);
    const counts = (await gitOutput(rootAbs, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])).split(/\s+/).filter(Boolean).map(Number);
    const lastCommit = await readLastCommit(rootAbs);
    return {
        isGit: true,
        ...(branch && branch !== "HEAD" ? { branch } : {}),
        dirty: Boolean(porcelain),
        ...(counts.length === 2 && counts.every(Number.isFinite) ? { behind: counts[0], ahead: counts[1] } : {}),
        ...(lastCommit ? { lastCommit } : {}),
    };
}

/** 通过 .git 标记判断目录是否为 git 仓库（支持 .git 为目录或文件）。 */
async function isGitRepository(root: string) {
    const marker = await stat(path.join(root, ".git")).catch(() => null);
    return Boolean(marker);
}

/** 在仓库目录内执行 git 并返回裁剪后的输出；失败时返回空字符串。 */
async function gitOutput(root: string, args: string[]) {
    try {
        const { stdout } = await execFileAsync("git", args, { cwd: root, maxBuffer: 1024 * 1024, timeout: 10_000 });
        return stdout.trim();
    } catch {
        return "";
    }
}

/** 读取最近一次提交；空仓库或读取失败时返回 null。 */
async function readLastCommit(root: string): Promise<RepoCommitInfo | null> {
    const output = await gitOutput(root, ["log", "-1", "--pretty=format:%H%x1f%s%x1f%an%x1f%aI"]);
    if (!output) return null;
    const [sha, subject, author, date] = output.split(COMMIT_FIELD_SEPARATOR);
    if (!sha) return null;
    return { sha, subject: subject || "", author: author || "", date: date || "" };
}

/** 由扩展名映射前端高亮语言。 */
export function languageForFile(file: string) {
    return LANGUAGE_BY_EXTENSION[path.extname(file).toLowerCase()];
}

/** 判断缓冲区是否像二进制内容（出现 NUL 字节）。 */
function looksBinary(buffer: Buffer) {
    return buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

/** 将系统路径分隔符统一为 /。 */
function toPosix(value: string) {
    return value.split(path.sep).join("/");
}

/** git pretty 格式中的字段分隔符（Unit Separator），避免与提交信息内容冲突。 */
const COMMIT_FIELD_SEPARATOR = "\u001f";

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".json": "json", ".jsonc": "json", ".md": "markdown", ".mdx": "markdown",
    ".css": "css", ".scss": "scss", ".less": "less", ".html": "html", ".htm": "html",
    ".vue": "vue", ".svelte": "svelte", ".py": "python", ".rb": "ruby", ".go": "go",
    ".rs": "rust", ".java": "java", ".kt": "kotlin", ".swift": "swift", ".c": "c",
    ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp", ".cs": "csharp",
    ".php": "php", ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".fish": "shell",
    ".yml": "yaml", ".yaml": "yaml", ".toml": "toml", ".ini": "ini", ".sql": "sql",
    ".xml": "xml", ".svg": "xml", ".graphql": "graphql", ".gql": "graphql",
    ".dockerfile": "dockerfile", ".tf": "hcl", ".lua": "lua", ".r": "r", ".dart": "dart",
    ".txt": "plaintext", ".log": "plaintext", ".env": "plaintext", ".lock": "plaintext",
};
