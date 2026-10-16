import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { readRepoStatus, RepoPathError } from "./fs-ops.js";

const execFileAsync = promisify(execFile);
/** 固定提交身份，避免依赖本机 git 配置。 */
const IDENTITY = ["-c", "user.email=canvas-agent@test.local", "-c", "user.name=Canvas Agent Test", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];

/** 在指定目录执行 git。 */
async function git(cwd: string, args: string[]) {
    const { stdout } = await execFileAsync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" });
    return stdout.trim();
}

/** 创建临时目录。 */
function makeDir(prefix: string) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("readRepoStatus 读取 git 仓库的分支、脏标记与最近提交", async () => {
    const root = makeDir("canvas-agent-status-git-");
    try {
        await git(root, ["init", "-q"]);
        fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
        await git(root, ["add", "."]);
        await git(root, ["commit", "-q", "-m", "init commit"]);

        const clean = await readRepoStatus(root);
        assert.equal(clean.isGit, true);
        assert.equal(clean.branch, "main");
        assert.equal(clean.dirty, false);
        assert.equal(clean.ahead, undefined);
        assert.equal(clean.behind, undefined);
        assert.equal(clean.lastCommit?.subject, "init commit");
        assert.equal(clean.lastCommit?.author, "Canvas Agent Test");
        assert.match(String(clean.lastCommit?.sha), /^[0-9a-f]{40}$/);
        assert.match(String(clean.lastCommit?.date), /^\d{4}-\d{2}-\d{2}T/);

        fs.writeFileSync(path.join(root, "dirty.txt"), "draft\n");
        const dirty = await readRepoStatus(root);
        assert.equal(dirty.isGit, true);
        assert.equal(dirty.dirty, true);
        assert.equal(dirty.lastCommit?.subject, "init commit");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("readRepoStatus 计算相对上游的 ahead/behind", async () => {
    const sandbox = makeDir("canvas-agent-status-remote-");
    try {
        const remote = path.join(sandbox, "origin.git");
        fs.mkdirSync(remote, { recursive: true });
        await git(remote, ["init", "-q", "--bare"]);

        const root = path.join(sandbox, "work");
        fs.mkdirSync(root, { recursive: true });
        await git(root, ["init", "-q"]);
        fs.writeFileSync(path.join(root, "a.txt"), "a\n");
        await git(root, ["add", "."]);
        await git(root, ["commit", "-q", "-m", "commit A"]);
        await git(root, ["remote", "add", "origin", remote]);
        await git(root, ["push", "-q", "-u", "origin", "main"]);
        assert.equal((await readRepoStatus(root)).ahead, 0);
        assert.equal((await readRepoStatus(root)).behind, 0);

        fs.writeFileSync(path.join(root, "b.txt"), "b\n");
        await git(root, ["add", "."]);
        await git(root, ["commit", "-q", "-m", "commit B"]);
        const ahead = await readRepoStatus(root);
        assert.equal(ahead.ahead, 1);
        assert.equal(ahead.behind, 0);
        assert.equal(ahead.lastCommit?.subject, "commit B");

        await git(root, ["push", "-q", "origin", "main"]);
        const clone = path.join(sandbox, "clone");
        await execFileAsync("git", ["clone", "-q", remote, clone]);
        // clone 停在 commit A（本地 reset 后），上游有 commit B，本地落后 1 个提交。
        await git(clone, ["reset", "-q", "--hard", "HEAD~1"]);
        await git(clone, ["fetch", "-q", "origin"]);
        const behind = await readRepoStatus(clone);
        assert.equal(behind.ahead, 0);
        assert.equal(behind.behind, 1);
    } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
    }
});

test("readRepoStatus 对非 git 目录返回 isGit:false 且不报错", async () => {
    const plain = makeDir("canvas-agent-status-plain-");
    try {
        fs.writeFileSync(path.join(plain, "note.txt"), "plain\n");
        assert.deepEqual(await readRepoStatus(plain), { isGit: false });
    } finally {
        fs.rmSync(plain, { recursive: true, force: true });
    }
});

test("readRepoStatus 对不存在的目录抛 400 级错误", async () => {
    const missing = path.join(makeDir("canvas-agent-status-missing-"), "nope");
    await assert.rejects(() => readRepoStatus(missing), RepoPathError);
    await assert.rejects(() => readRepoStatus(missing), /仓库目录不存在/);
});

test("readRepoStatus 对空 git 仓库不报错且没有最近提交", async () => {
    const root = makeDir("canvas-agent-status-empty-");
    try {
        await git(root, ["init", "-q"]);
        const status = await readRepoStatus(root);
        assert.equal(status.isGit, true);
        assert.equal(status.branch, "main");
        assert.equal(status.dirty, false);
        assert.equal(status.lastCommit, undefined);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
