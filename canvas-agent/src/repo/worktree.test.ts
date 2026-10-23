import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
    createRepoWorktree,
    findRepoWorktree,
    isRepoWorktreePath,
    listRepoWorktrees,
    parseWorktreeList,
    planWorktree,
    removeRepoWorktree,
    WORKTREE_BRANCH_PREFIX,
    WORKTREE_SLUG_MAX,
    WorktreeError,
    worktreeBranch,
    worktreeSlug,
} from "./worktree.js";

const execFileAsync = promisify(execFile);
/** 固定提交身份，避免依赖本机 git 配置。 */
const IDENTITY = ["-c", "user.email=canvas-agent@test.local", "-c", "user.name=Canvas Agent Test", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];

async function git(cwd: string, args: string[]) {
    const { stdout } = await execFileAsync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" });
    return stdout.trim();
}

function makeDir(prefix: string) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 建一个带初始提交的临时仓库，并返回它的路径。 */
async function makeRepo() {
    const root = makeDir("canvas-agent-worktree-repo-");
    await git(root, ["init", "-q"]);
    fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-q", "-m", "init commit"]);
    return root;
}

test("worktreeSlug 归一化任务 id 并挡住路径越界", () => {
    // 中文被折成短横线（git 分支名安全），保留下来的拉丁词按出现顺序拼接。
    assert.match(worktreeSlug("Task 01: 修复 bug!"), /^task-01-bug-[0-9a-f]{6}$/);
    // 大小写、空格、标点全部折叠成单个短横线，不留首尾横线。
    assert.match(worktreeSlug("  Hello   World  "), /^hello-world-[0-9a-f]{6}$/);
    // `..` 与 `/` 不能留在 slug 里，否则拼出来的路径会跑出 baseDir。
    const escaped = worktreeSlug("../../etc/passwd");
    assert.equal(escaped.includes(".."), false);
    assert.equal(escaped.includes("/"), false);
    assert.equal(escaped.startsWith("-"), false);
});

test("worktreeSlug 对超长 id 截断但仍能区分前缀相同的任务", () => {
    const common = "a".repeat(80);
    const a = worktreeSlug(`${common}-one`);
    const b = worktreeSlug(`${common}-two`);
    // 截断后主体相同（受 WORKTREE_SLUG_MAX 限制），靠末尾哈希区分。
    assert.equal(a.slice(0, WORKTREE_SLUG_MAX), b.slice(0, WORKTREE_SLUG_MAX));
    assert.notEqual(a, b);
    assert.equal(a.length <= WORKTREE_SLUG_MAX + 7, true);
});

test("worktreeSlug 空输入仍有稳定兜底，且分支带统一前缀", () => {
    assert.match(worktreeSlug(""), /^task-[0-9a-f]{6}$/);
    assert.equal(worktreeBranch("abc"), `${WORKTREE_BRANCH_PREFIX}${worktreeSlug("abc")}`);
    assert.equal(worktreeBranch("abc").startsWith("canvas/"), true);
});

test("planWorktree 是纯函数：同一任务落到同一路径，不同任务互不覆盖", async () => {
    const repoPath = path.join(os.tmpdir(), "some-repo");
    const first = planWorktree({ repoPath, taskId: "task-a", baseDir: "/tmp/base" });
    const again = planWorktree({ repoPath, taskId: "task-a", baseDir: "/tmp/base" });
    assert.deepEqual(first, again);
    const other = planWorktree({ repoPath, taskId: "task-b", baseDir: "/tmp/base" });
    assert.notEqual(first.path, other.path);
    // 目录名带上仓库名，多个仓库的任务 id 相同时不会互相踩。
    assert.equal(first.path.startsWith(path.join("/tmp/base", "some-repo-")), true);
    // 纯函数不碰磁盘：这里没 mkdir，目录本不该存在。
    assert.equal(fs.existsSync(first.path), false);
});

test("parseWorktreeList 解析 --porcelain 输出", () => {
    const porcelain = [
        "worktree /repo/main",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
        "",
        "worktree /base/repo-task-a-abcdef",
        "HEAD 2222222222222222222222222222222222222222",
        "branch refs/heads/canvas/task-a-abcdef",
        "",
        "worktree /base/detached",
        "HEAD 3333333333333333333333333333333333333333",
        "detached",
        "",
    ].join("\n");
    const records = parseWorktreeList(porcelain);
    assert.equal(records.length, 3);
    assert.equal(records[0].path, "/repo/main");
    assert.equal(records[0].branch, "main");
    assert.equal(records[0].detached, false);
    assert.equal(records[1].branch, "canvas/task-a-abcdef");
    assert.equal(records[1].head, "2".repeat(40));
    assert.equal(records[2].detached, true);
    assert.equal(records[2].branch, "");
    // 空输入不产生记录，也不抛错。
    assert.deepEqual(parseWorktreeList(""), []);
});

test("createRepoWorktree 建出真 worktree，重复调用幂等复用", async () => {
    const repoPath = await makeRepo();
    const baseDir = makeDir("canvas-agent-worktree-base-");
    try {
        const first = await createRepoWorktree({ repoPath, taskId: "task one", baseDir });
        assert.equal(first.created, true);
        assert.equal(first.branch, worktreeBranch("task one"));
        assert.equal(fs.existsSync(first.worktree.path), true);
        // 新 worktree 拿到同一份初始提交，但工作区是独立的。
        assert.equal(fs.readFileSync(path.join(first.worktree.path, "README.md"), "utf8"), "# repo\n");

        const records = await listRepoWorktrees(repoPath);
        assert.equal(records.length, 2);
        assert.equal(records.some((record) => path.resolve(record.path) === path.resolve(first.worktree.path)), true);

        const second = await createRepoWorktree({ repoPath, taskId: "task one", baseDir });
        assert.equal(second.created, false);
        assert.equal(path.resolve(second.worktree.path), path.resolve(first.worktree.path));
        // 幂等：不会因为重跑多出一个 worktree。
        assert.equal((await listRepoWorktrees(repoPath)).length, 2);
    } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
        fs.rmSync(repoPath, { recursive: true, force: true });
    }
});

test("两个任务的 worktree 真正隔离：改动互不可见", async () => {
    const repoPath = await makeRepo();
    const baseDir = makeDir("canvas-agent-worktree-iso-");
    try {
        const a = await createRepoWorktree({ repoPath, taskId: "task-a", baseDir });
        const b = await createRepoWorktree({ repoPath, taskId: "task-b", baseDir });
        fs.writeFileSync(path.join(a.worktree.path, "a.txt"), "from a\n");
        assert.equal(fs.existsSync(path.join(b.worktree.path, "a.txt")), false);
        assert.equal(fs.existsSync(path.join(repoPath, "a.txt")), false);
        // 各自有自己的 HEAD 与分支，主仓库仍停在 main。
        assert.equal(a.branch.startsWith("canvas/"), true);
        assert.notEqual(a.branch, b.branch);
        assert.equal(await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
        fs.rmSync(repoPath, { recursive: true, force: true });
    }
});

test("findRepoWorktree 找不到时返回 null，找到时返回登记记录", async () => {
    const repoPath = await makeRepo();
    const baseDir = makeDir("canvas-agent-worktree-find-");
    try {
        assert.equal(await findRepoWorktree(repoPath, "task-x", baseDir), null);
        const created = await createRepoWorktree({ repoPath, taskId: "task-x", baseDir });
        const found = await findRepoWorktree(repoPath, "task-x", baseDir);
        assert.equal(path.resolve(String(found?.path)), path.resolve(created.worktree.path));
        assert.equal(found?.branch, created.branch);
    } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
        fs.rmSync(repoPath, { recursive: true, force: true });
    }
});

test("removeRepoWorktree 只能删本仓库登记的 worktree，且拒绝删主工作区", async () => {
    const repoPath = await makeRepo();
    const baseDir = makeDir("canvas-agent-worktree-rm-");
    try {
        const created = await createRepoWorktree({ repoPath, taskId: "task-rm", baseDir });
        // 主工作区是仓库本身，必须拒绝。
        await assert.rejects(
            () => removeRepoWorktree({ repoPath, worktreePath: repoPath }),
            (error: unknown) => error instanceof WorktreeError && /main worktree/.test((error as Error).message),
        );
        // 仓库外的任意路径也拒绝（路径来自请求，不能信任）。
        const outside = makeDir("canvas-agent-worktree-outside-");
        try {
            await assert.rejects(
                () => removeRepoWorktree({ repoPath, worktreePath: outside }),
                (error: unknown) => error instanceof WorktreeError && /not a worktree/.test((error as Error).message),
            );
            assert.equal(fs.existsSync(outside), true);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }

        const result = await removeRepoWorktree({ repoPath, worktreePath: created.worktree.path });
        assert.equal(result.removed, true);
        assert.equal(fs.existsSync(created.worktree.path), false);
        // 删完只剩主工作区。
        assert.equal((await listRepoWorktrees(repoPath)).length, 1);
    } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
        fs.rmSync(repoPath, { recursive: true, force: true });
    }
});

test("非 git 仓库与不存在的目录报 WorktreeError（400 级）", async () => {
    const plain = makeDir("canvas-agent-worktree-plain-");
    try {
        await assert.rejects(
            () => createRepoWorktree({ repoPath: plain, taskId: "task", baseDir: path.join(plain, "wt") }),
            (error: unknown) => error instanceof WorktreeError && /not a git repository/.test((error as Error).message),
        );
        await assert.rejects(
            () => listRepoWorktrees(path.join(plain, "missing")),
            (error: unknown) => error instanceof WorktreeError && /does not exist/.test((error as Error).message),
        );
        // taskId 缺失是调用方错误，不能默默用一个空 slug 建目录。
        await assert.rejects(
            () => createRepoWorktree({ repoPath: plain, taskId: "   ", baseDir: path.join(plain, "wt2") }),
            (error: unknown) => error instanceof WorktreeError && /taskId is required/.test((error as Error).message),
        );
    } finally {
        fs.rmSync(plain, { recursive: true, force: true });
    }
});

test("isRepoWorktreePath 只认属于已注册仓库的真 worktree", async () => {
    const repoPath = await makeRepo();
    const baseDir = makeDir("canvas-agent-worktree-detect-");
    try {
        const created = await createRepoWorktree({ repoPath, taskId: "task-detect", baseDir });
        assert.equal(isRepoWorktreePath([repoPath], created.worktree.path, baseDir), true);
        // 主工作区不是 worktree（`.git` 是目录）。
        assert.equal(isRepoWorktreePath([repoPath], repoPath, baseDir), false);
        // 别家仓库的 worktree 不能冒充这一家的。
        assert.equal(isRepoWorktreePath([path.join(os.tmpdir(), "other-repo")], created.worktree.path, baseDir), false);
        // 不在 baseDir 下的路径直接不认，哪怕它看起来像 worktree。
        assert.equal(isRepoWorktreePath([repoPath], created.worktree.path, path.join(baseDir, "elsewhere")), false);

        // 伪造 `.git` 文件（gitdir 指向不存在的位置）不能骗过校验。
        const fake = path.join(baseDir, "repo-task-fake-000000");
        fs.mkdirSync(fake, { recursive: true });
        fs.writeFileSync(path.join(fake, ".git"), `gitdir: ${path.join(repoPath, ".git", "worktrees", "nope")}\n`);
        assert.equal(isRepoWorktreePath([repoPath], fake, baseDir), true);
        fs.writeFileSync(path.join(fake, ".git"), "not a gitdir pointer\n");
        assert.equal(isRepoWorktreePath([repoPath], fake, baseDir), false);
    } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
        fs.rmSync(repoPath, { recursive: true, force: true });
    }
});

test("worktree 路径被非 worktree 目录占用时拒绝创建", async () => {
    const repoPath = await makeRepo();
    const baseDir = makeDir("canvas-agent-worktree-occupied-");
    try {
        const plan = planWorktree({ repoPath, taskId: "task-clash", baseDir });
        fs.mkdirSync(plan.path, { recursive: true });
        fs.writeFileSync(path.join(plan.path, "user-file.txt"), "do not clobber\n");
        await assert.rejects(
            () => createRepoWorktree({ repoPath, taskId: "task-clash", baseDir }),
            (error: unknown) => error instanceof WorktreeError && /already exists/.test((error as Error).message),
        );
        // 占位目录里的用户文件必须还在——失败不能顺手清别人东西。
        assert.equal(fs.readFileSync(path.join(plan.path, "user-file.txt"), "utf8"), "do not clobber\n");
    } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
        fs.rmSync(repoPath, { recursive: true, force: true });
    }
});
