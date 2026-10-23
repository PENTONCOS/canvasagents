import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * E4 独立 worktree：每个任务在自己的 git worktree 里开发，互不污染。
 *
 * 为什么要真 worktree 而不是「切分支」：同一工作目录里切分支，两个任务不能同时存在——
 * 任务 A 的未提交改动会被任务 B 的 checkout 顶掉，或者直接把 B 的改动带进 A 的提交。
 * worktree 是 git 原生支持的「同一仓库、多个工作目录」，各自有独立 HEAD 与工作区，
 * 共享对象库，所以隔离是真的，代价很小。
 *
 * 目录与分支名的算法在这里定死，并把「任务 id → 目录/分支」抽成纯函数，
 * 这样同一个任务重跑几次都落到同一个 worktree，不会越积越多。
 */

/** 任务分支统一前缀，便于在 `git branch` 里一眼看出哪些是助手开的。 */
export const WORKTREE_BRANCH_PREFIX = "canvas/";
/** slug 长度上限：再长的任务名也只取前 40 个字符，剩下的用哈希区分。 */
export const WORKTREE_SLUG_MAX = 40;
/** worktree 默认根目录：放在用户目录下，不污染被开发的仓库本身。 */
export const DEFAULT_WORKTREE_BASE = path.join(os.homedir(), ".canvasagents", "worktrees");

/** worktree 操作失败（非 git 仓库、路径越界、git 报错）统一按 400 级错误抛出。 */
export class WorktreeError extends Error {
    readonly statusCode = 400;

    constructor(message: string) {
        super(message);
        this.name = "WorktreeError";
    }
}

export type WorktreeRecord = {
    /** worktree 的绝对路径。 */
    path: string;
    /** 当前 HEAD；空仓库可能是全零 sha。 */
    head: string;
    /** 分支短名（已去掉 refs/heads/）；detached 时为空。 */
    branch: string;
    detached: boolean;
    bare: boolean;
};

export type PlannedWorktree = { slug: string; branch: string; path: string };

/**
 * 任务 id → 目录/分支用的 slug。
 *
 * 全部小写、非字母数字折成 `-`，同时把 `.` 一起折掉——这一步顺带挡掉 `..` 越界；
 * 末尾再拼一个任务 id 的短哈希，避免「用户名很长、前 40 字符相同」的任务互相踩。
 */
export function worktreeSlug(taskId: string): string {
    const raw = String(taskId || "").trim();
    const base = raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, WORKTREE_SLUG_MAX)
        .replace(/-+$/g, "");
    // 哈希取自原始 id（不是截断后的 slug），否则两个长 id 前缀相同仍然会撞。
    const digest = crypto.createHash("sha1").update(raw || "task").digest("hex").slice(0, 6);
    return `${base || "task"}-${digest}`;
}

export function worktreeBranch(taskId: string): string {
    return `${WORKTREE_BRANCH_PREFIX}${worktreeSlug(taskId)}`;
}

/** 任务 id → worktree 路径（纯函数：不碰磁盘，调用方自己决定要不要创建）。 */
export function planWorktree(input: { repoPath: string; taskId: string; baseDir?: string }): PlannedWorktree {
    const repoPath = path.resolve(input.repoPath);
    const slug = worktreeSlug(input.taskId);
    const repoName = path.basename(repoPath) || "repo";
    const baseDir = path.resolve(input.baseDir || DEFAULT_WORKTREE_BASE);
    return { slug, branch: `${WORKTREE_BRANCH_PREFIX}${slug}`, path: path.join(baseDir, `${repoName}-${slug}`) };
}

/** 解析 `git worktree list --porcelain`：空行分段，每段一个 worktree。 */
export function parseWorktreeList(porcelain: string): WorktreeRecord[] {
    const records: WorktreeRecord[] = [];
    for (const block of String(porcelain || "").split(/\r?\n\r?\n/)) {
        const lines = block.split(/\r?\n/).filter(Boolean);
        if (!lines.length) continue;
        const record: WorktreeRecord = { path: "", head: "", branch: "", detached: false, bare: false };
        for (const line of lines) {
            const [key, ...rest] = line.split(" ");
            const value = rest.join(" ");
            if (key === "worktree") record.path = value;
            else if (key === "HEAD") record.head = value;
            else if (key === "branch") record.branch = value.replace(/^refs\/heads\//, "");
            else if (key === "detached") record.detached = true;
            else if (key === "bare") record.bare = true;
        }
        if (record.path) records.push(record);
    }
    return records;
}

async function git(args: string[], cwd: string) {
    try {
        const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
        return stdout.trim();
    } catch (error) {
        const detail = error as { stderr?: string; message?: string };
        throw new WorktreeError((detail.stderr || detail.message || "git failed").trim());
    }
}

async function assertDirectory(target: string, label: string) {
    try {
        const info = await stat(target);
        if (!info.isDirectory()) throw new WorktreeError(`${label} is not a directory: ${target}`);
    } catch (error) {
        if (error instanceof WorktreeError) throw error;
        throw new WorktreeError(`${label} does not exist: ${target}`);
    }
}

async function assertGitRepo(repoPath: string) {
    await assertDirectory(repoPath, "repoPath");
    try {
        await git(["rev-parse", "--is-inside-work-tree"], repoPath);
    } catch {
        throw new WorktreeError(`not a git repository: ${repoPath}`);
    }
}

export async function listRepoWorktrees(repoPath: string): Promise<WorktreeRecord[]> {
    await assertGitRepo(repoPath);
    return parseWorktreeList(await git(["worktree", "list", "--porcelain"], repoPath));
}

export type CreateWorktreeInput = { repoPath: string; taskId: string; baseDir?: string; baseRef?: string };

/**
 * 为任务准备 worktree：已存在就复用（创建是幂等的，重跑不会越积越多），
 * 不存在就 `git worktree add -B <branch> <path> <baseRef|HEAD>`。
 * 返回 `created` 让调用方能区分「新建」与「复用」——面板上这两者的提示不一样。
 */
export async function createRepoWorktree(input: CreateWorktreeInput): Promise<{ created: boolean; worktree: WorktreeRecord; branch: string }> {
    const taskId = String(input.taskId || "").trim();
    if (!taskId) throw new WorktreeError("taskId is required");
    await assertGitRepo(input.repoPath);
    const plan = planWorktree(input);
    const existing = await listRepoWorktrees(input.repoPath);
    const found = existing.find((worktree) => path.resolve(worktree.path) === plan.path);
    if (found) return { created: false, worktree: found, branch: found.branch || plan.branch };

    // 目录被别的东西占了就不能硬上，否则 git 会把内容画进一个非空目录。
    let occupied = false;
    try {
        occupied = (await stat(plan.path)).isDirectory();
    } catch {
        occupied = false;
    }
    if (occupied) throw new WorktreeError(`worktree path already exists and is not a worktree of this repo: ${plan.path}`);

    await mkdir(path.dirname(plan.path), { recursive: true });
    const baseRef = String(input.baseRef || "HEAD");
    await git(["worktree", "add", "-B", plan.branch, plan.path, baseRef], input.repoPath);
    const after = await listRepoWorktrees(input.repoPath);
    const created = after.find((worktree) => path.resolve(worktree.path) === plan.path);
    if (!created) throw new WorktreeError(`worktree was not registered by git: ${plan.path}`);
    return { created: true, worktree: created, branch: plan.branch };
}

/**
 * 删除任务的 worktree。
 * 只允许删这个仓库自己登记过的 worktree，且不能是主工作区——
 * 路径参数来自请求体，不校验就能 `git worktree remove` 掉任意目录。
 */
export async function removeRepoWorktree(input: { repoPath: string; worktreePath: string; force?: boolean }): Promise<{ removed: boolean }> {
    await assertGitRepo(input.repoPath);
    const target = path.resolve(input.worktreePath);
    const worktrees = await listRepoWorktrees(input.repoPath);
    const main = worktrees.find((worktree) => !worktree.branch || worktree.bare) || worktrees[0];
    const record = worktrees.find((worktree) => path.resolve(worktree.path) === target);
    if (!record) throw new WorktreeError(`not a worktree of this repo: ${target}`);
    if (main && path.resolve(main.path) === target) throw new WorktreeError("refusing to remove the main worktree");
    await git(["worktree", "remove", ...(input.force ? ["--force"] : []), target], input.repoPath);
    // prune 清掉 git 里残留的登记（手动删目录后也靠它收拾）。
    await git(["worktree", "prune"], input.repoPath);
    return { removed: true };
}

/** 任务 id → 该任务在仓库里的 worktree（不存在返回 null），供「这个任务在哪开发」这类查询用。 */
export async function findRepoWorktree(repoPath: string, taskId: string, baseDir?: string): Promise<WorktreeRecord | null> {
    const plan = planWorktree({ repoPath, taskId, baseDir });
    const worktrees = await listRepoWorktrees(repoPath);
    return worktrees.find((worktree) => path.resolve(worktree.path) === plan.path) || null;
}

/**
 * 同步判断 `target` 是不是「某个已注册仓库的 worktree」。
 *
 * 线程建/恢复是同步解析 cwd 的，这里不能为了校验去跑 git。
 * 好在 git 自己在 worktree 根目录留了凭据：`.git` 是一个**文件**（不是目录），
 * 内容是 `gitdir: <主仓库>/.git/worktrees/<名字>`。三件事一起验，缺一条就不认，
 * 避免把用户自己的任意目录当成 worktree 交给 Agent 跑。
 */
export function isRepoWorktreePath(repoPaths: string[], target: string, baseDir?: string) {
    const resolved = path.resolve(String(target || ""));
    const base = path.resolve(baseDir || DEFAULT_WORKTREE_BASE);
    const relative = path.relative(base, resolved);
    // 越界（含 `..`、绝对路径穿越）一律不认。
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
    let gitFile = "";
    try {
        if (!statSync(resolved).isDirectory()) return false;
        if (!statSync(path.join(resolved, ".git")).isFile()) return false;
        gitFile = readFileSync(path.join(resolved, ".git"), "utf8").trim();
    } catch {
        return false;
    }
    const match = /^gitdir:\s*(.+)$/.exec(gitFile);
    if (!match) return false;
    const gitDir = path.resolve(resolved, match[1].trim());
    return repoPaths.some((repoPath) => {
        const prefix = path.join(path.resolve(repoPath), ".git", "worktrees") + path.sep;
        return gitDir.startsWith(prefix);
    });
}
