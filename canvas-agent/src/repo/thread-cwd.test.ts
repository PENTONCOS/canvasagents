import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { resolveThreadCwd } from "./thread-cwd.js";
import { createRepoWorktree } from "./worktree.js";

const execFileAsync = promisify(execFile);
const IDENTITY = ["-c", "user.email=canvas-agent@test.local", "-c", "user.name=Canvas Agent Test", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];

async function git(cwd: string, args: string[]) {
    const { stdout } = await execFileAsync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" });
    return stdout.trim();
}

async function makeRepo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-thread-cwd-repo-"));
    await git(root, ["init", "-q"]);
    fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-q", "-m", "init commit"]);
    return root;
}

/** 每个用例都自己建/删临时目录，测试之间不共享状态。 */
async function withTempBase(run: (ctx: { base: string; repo: string; otherRepo: string }) => Promise<void>) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-thread-cwd-base-"));
    const repo = await makeRepo();
    const otherRepo = await makeRepo();
    try {
        await run({ base, repo, otherRepo });
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(otherRepo, { recursive: true, force: true });
    }
}

test("repoId 命中注册仓库时直接用它，忽略同时传进来的 cwd", async () => {
    await withTempBase(async ({ repo }) => {
        const cwd = resolveThreadCwd({ repoId: "repo-1", cwd: "/tmp/任何地方" }, [{ id: "repo-1", path: repo }], () => "/fallback");
        assert.equal(cwd, repo);
    });
});

test("cwd 正好是注册仓库路径时放行", async () => {
    await withTempBase(async ({ repo }) => {
        const cwd = resolveThreadCwd({ cwd: repo }, [{ id: "repo-1", path: repo }], () => "/fallback");
        assert.equal(cwd, repo);
    });
});

test("已注册仓库的真 worktree 可以当工作目录", async () => {
    await withTempBase(async ({ base, repo }) => {
        const created = await createRepoWorktree({ repoPath: repo, taskId: "任务 A", baseDir: base });
        const cwd = resolveThreadCwd({ cwd: created.worktree.path }, [{ id: "repo-1", path: repo }], () => "/fallback", { baseDir: base });
        assert.equal(cwd, created.worktree.path);
    });
});

test("别的仓库的 worktree 不认，回退站点工作空间", async () => {
    await withTempBase(async ({ base, repo, otherRepo }) => {
        const created = await createRepoWorktree({ repoPath: otherRepo, taskId: "任务 B", baseDir: base });
        let fallbackCalls = 0;
        const cwd = resolveThreadCwd({ cwd: created.worktree.path }, [{ id: "repo-1", path: repo }], () => {
            fallbackCalls += 1;
            return "/site-workspace";
        }, { baseDir: base });
        assert.equal(cwd, "/site-workspace");
        assert.equal(fallbackCalls, 1);
    });
});

test("worktree 根目录之外的路径一律不认（请求里的 cwd 是前端给的，不能当目录白名单）", async () => {
    await withTempBase(async ({ base, repo }) => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-thread-cwd-outside-"));
        try {
            fs.writeFileSync(path.join(outside, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "fake")}\n`);
            const cwd = resolveThreadCwd({ cwd: outside }, [{ id: "repo-1", path: repo }], () => "/site-workspace", { baseDir: base });
            assert.equal(cwd, "/site-workspace");
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });
});

test("普通空目录（没有 .git 文件）不认", async () => {
    await withTempBase(async ({ base, repo }) => {
        const plain = path.join(base, "just-a-dir");
        fs.mkdirSync(plain, { recursive: true });
        const cwd = resolveThreadCwd({ cwd: plain }, [{ id: "repo-1", path: repo }], () => "/site-workspace", { baseDir: base });
        assert.equal(cwd, "/site-workspace");
    });
});

test("相对 cwd 与空 cwd 都回退，且回退只在真需要时才取", () => {
    let fallbackCalls = 0;
    const fallback = () => {
        fallbackCalls += 1;
        return "/site-workspace";
    };
    assert.equal(resolveThreadCwd({ cwd: "relative/dir" }, [], fallback), "/site-workspace");
    assert.equal(resolveThreadCwd({ cwd: "   " }, [], fallback), "/site-workspace");
    assert.equal(resolveThreadCwd({}, [], fallback), "/site-workspace");
    assert.equal(fallbackCalls, 3);
});

test("repoId 未注册时不静默退到「随便一个仓库」，仍按 cwd 判定", async () => {
    await withTempBase(async ({ repo, otherRepo }) => {
        const repos = [{ id: "repo-1", path: repo }, { id: "repo-2", path: otherRepo }];
        // 另一个仓库已注册，所以它的路径可以当 cwd。
        assert.equal(resolveThreadCwd({ repoId: "gone", cwd: otherRepo }, repos, () => "/site-workspace"), otherRepo);
        // 只给一个不存在的 repoId、没有 cwd：回退站点工作空间，而不是挑第一个仓库顶上。
        assert.equal(resolveThreadCwd({ repoId: "gone" }, repos, () => "/site-workspace"), "/site-workspace");
        // 未注册仓库的路径 + 它不属于任何注册仓库 → 同样回退。
        const stranger = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-thread-cwd-stranger-"));
        try {
            assert.equal(resolveThreadCwd({ cwd: stranger }, repos, () => "/site-workspace"), "/site-workspace");
        } finally {
            fs.rmSync(stranger, { recursive: true, force: true });
        }
    });
});
