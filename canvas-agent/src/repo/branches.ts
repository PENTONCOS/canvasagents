import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * G4 分支并行：feature → develop → stage → production，多个需求可以同时在各自的
 * `canvas/<任务>` 分支上改，再一条一条往主线合。
 *
 * 为什么合并不在某个工作目录里跑 `git merge`：
 * 目标分支可能已经被主工作区或某个任务 worktree 占用，`git merge` 会直接顶掉别人
 * 的未提交改动；而「先 checkout 再 merge」在并发合并时还会互相踩。
 * 这里改用 git 的底层三步，完全不碰任何工作目录：
 *   1. `git merge-tree --write-tree` 只算合并结果与冲突（不写工作区）；
 *   2. `git commit-tree` 用算出的树生成合并提交（两个父提交）；
 *   3. `git update-ref` 带旧值做 CAS，只有在目标分支没被别人推进时才移动它。
 * 冲突时第 2、3 步根本不执行，所以目标分支 HEAD 原地不动——「不打架」是结构性保证，
 * 不是靠调用方小心。
 */

/** 阶段分支，顺序即晋升顺序。 */
export const STAGE_BRANCHES = ["develop", "stage", "production"] as const;
export type StageBranch = (typeof STAGE_BRANCHES)[number];
/** 任务分支前缀，与 E4 的 worktree 分支保持一致。 */
export const FEATURE_BRANCH_PREFIX = "canvas/";

/** 分支操作失败：入参/规则不允许是 400，合并冲突是 409。 */
export class BranchError extends Error {
    readonly statusCode: number;
    /** 冲突时的冲突文件（非冲突场景为空数组）。 */
    readonly conflicts: string[];

    constructor(message: string, statusCode = 400, conflicts: string[] = []) {
        super(message);
        this.name = "BranchError";
        this.statusCode = statusCode;
        this.conflicts = conflicts;
    }
}

export type BranchStage = StageBranch | "feature" | "other";

export function stageOfBranch(branch: string): BranchStage {
    const name = String(branch || "").trim();
    if (name.startsWith(FEATURE_BRANCH_PREFIX)) return "feature";
    if ((STAGE_BRANCHES as readonly string[]).includes(name)) return name as StageBranch;
    return "other";
}

/**
 * 一个分支往上合的目标分支。
 * 只允许逐级晋升：`canvas/*` → develop → stage → production。
 * 跳级（feature 直接进 production）在这里就被挡掉——跳级等于绕过 stage 的验证，
 * 是这套分支模型唯一真正危险的操作。
 */
export function branchMergeTarget(branch: string): StageBranch | null {
    const stage = stageOfBranch(branch);
    if (stage === "feature") return "develop";
    if (stage === "develop") return "stage";
    if (stage === "stage") return "production";
    return null;
}

export function assertMergePath(from: string, to: string): void {
    const source = String(from || "").trim();
    const target = String(to || "").trim();
    if (!source || !target) throw new BranchError("合并需要同时指定来源分支和目标分支");
    if (source === target) throw new BranchError("来源分支和目标分支不能相同");
    const expected = branchMergeTarget(source);
    if (!expected) {
        if (stageOfBranch(source) === "production") throw new BranchError("production 已经是最末一级，不能再往上合");
        throw new BranchError(`只允许合并任务分支或阶段分支，收到：${source}`);
    }
    if (target !== expected) {
        throw new BranchError(`只能逐级晋升：${source} 应合入 ${expected}，不能直接合入 ${target}`);
    }
}

export type BranchInfo = {
    name: string;
    stage: BranchStage;
    /** 分支当前 HEAD。 */
    head: string;
    /** 最近一次提交的标题，面板上直接显示。 */
    subject: string;
    /** 上级分支；production 与普通分支为空。 */
    mergeTarget: StageBranch | null;
    /** 相对上级分支领先/落后的提交数；上级分支不存在时为空。 */
    ahead: number | null;
    behind: number | null;
};

async function git(args: string[], cwd: string) {
    try {
        const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
        return stdout.trim();
    } catch (error) {
        const detail = error as { stderr?: string; message?: string };
        throw new BranchError((detail.stderr || detail.message || "git failed").trim());
    }
}

/** git 命令的「非零退出」也可能是有效结果（merge-tree 冲突就是 1），单独取 stdout/exitCode。 */
async function gitRaw(args: string[], cwd: string) {
    try {
        const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
        return { code: 0, stdout: stdout };
    } catch (error) {
        const detail = error as { code?: number; stdout?: string; stderr?: string; message?: string };
        return { code: typeof detail.code === "number" ? detail.code : 1, stdout: detail.stdout || "", stderr: detail.stderr || detail.message || "" };
    }
}

async function assertGitRepo(repoPath: string) {
    const result = await gitRaw(["rev-parse", "--is-inside-work-tree"], repoPath);
    if (result.code !== 0) throw new BranchError(`not a git repository: ${repoPath}`);
}

async function branchExists(repoPath: string, branch: string) {
    const result = await gitRaw(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoPath);
    return result.code === 0;
}

/** 解析 `git for-each-ref` 的三段输出：名字、HEAD、标题。 */
export function parseBranchList(output: string): Array<{ name: string; head: string; subject: string }> {
    return String(output || "")
        .split(/\r?\n/)
        .map((line) => line.split("\t"))
        .filter((parts) => parts.length >= 2 && parts[0].trim())
        .map((parts) => ({ name: parts[0].trim(), head: parts[1].trim(), subject: (parts[2] || "").trim() }));
}

/**
 * 列出仓库里的本地分支，并算出每个分支相对上级分支的领先/落后。
 * `current` 是主工作区当前检出的分支，前端用来标「你在这」。
 */
export async function listRepoBranches(repoPath: string): Promise<{ current: string; branches: BranchInfo[] }> {
    await assertGitRepo(repoPath);
    const raw = await git(["for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(contents:subject)", "refs/heads"], repoPath);
    const current = (await gitRaw(["symbolic-ref", "--quiet", "--short", "HEAD"], repoPath)).stdout.trim();
    const names = new Set(parseBranchList(raw).map((item) => item.name));
    const branches: BranchInfo[] = [];
    for (const item of parseBranchList(raw)) {
        const mergeTarget = branchMergeTarget(item.name);
        let ahead: number | null = null;
        let behind: number | null = null;
        if (mergeTarget && names.has(mergeTarget)) {
            // `rev-list --left-right --count A...B` 左边是 A 独有、右边是 B 独有。
            const counts = await gitRaw(["rev-list", "--left-right", "--count", `${mergeTarget}...${item.name}`], repoPath);
            if (counts.code === 0) {
                const [left, right] = counts.stdout.trim().split(/\s+/).map((value) => Number(value));
                behind = Number.isFinite(left) ? left : null;
                ahead = Number.isFinite(right) ? right : null;
            }
        }
        branches.push({ name: item.name, stage: stageOfBranch(item.name), head: item.head, subject: item.subject, mergeTarget, ahead, behind });
    }
    // 阶段分支按晋升顺序在前，任务分支按名字排，普通分支最后，面板上顺序稳定。
    const rank = (branch: BranchInfo) => {
        if (branch.stage === "other") return 100;
        if (branch.stage === "feature") return 10;
        return STAGE_BRANCHES.indexOf(branch.stage as StageBranch);
    };
    branches.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    return { current, branches };
}

/**
 * 解析 `git merge-tree --write-tree --name-only` 的输出。
 * 第一行是合并结果的树，接着（有冲突时）是冲突文件名，然后空行，之后是给人看的说明。
 * 说明文字会随 git 语言变化，所以只认「空行之前的文件名」，不解析任何文案。
 */
export function parseMergeTreeOutput(output: string): { tree: string; conflicts: string[] } {
    const lines = String(output || "").split(/\r?\n/);
    const tree = (lines[0] || "").trim();
    const conflicts: string[] = [];
    for (const line of lines.slice(1)) {
        if (!line.trim()) break;
        conflicts.push(line.trim());
    }
    return { tree, conflicts };
}

export type MergeBranchInput = { repoPath: string; from: string; to: string; message?: string };

/**
 * 把 `from` 合入 `to`，返回新提交。
 *
 * 冲突时抛 `BranchError(409)` 并带冲突文件；**目标分支不会动**（commit-tree / update-ref 没执行）。
 * 合并提交用 `-p to -p from` 两个父提交，即使能快进也保留合并点——这样「这个分支合过没有」
 * 在历史里一眼可见，回滚也只需 revert 一个提交。
 */
export async function mergeRepoBranch(input: MergeBranchInput): Promise<{ commit: string; tree: string; from: string; to: string }> {
    const from = String(input.from || "").trim();
    const to = String(input.to || "").trim();
    assertMergePath(from, to);
    await assertGitRepo(input.repoPath);
    if (!(await branchExists(input.repoPath, from))) throw new BranchError(`来源分支不存在：${from}`);
    if (!(await branchExists(input.repoPath, to))) throw new BranchError(`目标分支不存在：${to}（先建好 ${to} 再合并）`);

    const oldHead = (await git(["rev-parse", `refs/heads/${to}`], input.repoPath)).trim();
    const merged = await gitRaw(["merge-tree", "--write-tree", "--name-only", to, from], input.repoPath);
    const parsed = parseMergeTreeOutput(merged.stdout);
    if (merged.code !== 0 || parsed.conflicts.length) {
        // 冲突：一个提交都不写，目标分支保持原样。
        throw new BranchError(`${from} 合入 ${to} 有冲突，未做任何改动`, 409, parsed.conflicts);
    }
    if (!parsed.tree) throw new BranchError("git merge-tree 没有返回合并结果");

    const message = String(input.message || "").trim() || `merge: ${from} → ${to}`;
    const commit = await git(["commit-tree", parsed.tree, "-p", oldHead, "-p", from, "-m", message], input.repoPath);
    // CAS：如果算树到写 ref 之间有人推进了目标分支，update-ref 会失败而不是覆盖别人的提交。
    const updated = await gitRaw(["update-ref", `refs/heads/${to}`, commit, oldHead], input.repoPath);
    if (updated.code !== 0) throw new BranchError(`${to} 在合并期间被其他操作推进了，本次合并已放弃：${(updated.stderr || "").trim()}`);
    return { commit, tree: parsed.tree, from, to };
}
