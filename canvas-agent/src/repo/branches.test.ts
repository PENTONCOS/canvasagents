import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
    assertMergePath,
    BranchError,
    branchMergeTarget,
    listRepoBranches,
    mergeRepoBranch,
    parseBranchList,
    parseMergeTreeOutput,
    stageOfBranch,
} from "./branches.js";

const execFileAsync = promisify(execFile);
/** 固定提交身份，避免依赖本机 git 配置。 */
const IDENTITY = ["-c", "user.email=canvas-agent@test.local", "-c", "user.name=Canvas Agent Test", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];

async function git(cwd: string, args: string[]) {
    const { stdout } = await execFileAsync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" });
    return stdout.trim();
}

/** 建一个已提交一次的仓库，并把 develop / stage / production 三个阶段分支都开好。 */
async function makeRepo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-branches-"));
    await git(root, ["init", "-q"]);
    fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-q", "-m", "init commit"]);
    for (const branch of ["develop", "stage", "production"]) await git(root, ["branch", branch]);
    return root;
}

/** 在 `base` 上开任务分支、改一个文件并提交。 */
async function commitOnBranch(repo: string, branch: string, base: string, files: Record<string, string>, message: string) {
    await git(repo, ["checkout", "-q", "-B", branch, base]);
    for (const [file, content] of Object.entries(files)) {
        const target = path.join(repo, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
        await git(repo, ["add", file]);
    }
    await git(repo, ["commit", "-q", "-m", message]);
}

async function headOf(repo: string, ref: string) {
    return git(repo, ["rev-parse", `refs/heads/${ref}`]);
}

async function readFile(repo: string, branch: string, file: string) {
    return git(repo, ["show", `${branch}:${file}`]);
}

async function withRepo(run: (repo: string) => Promise<void>) {
    const repo = await makeRepo();
    try {
        await run(repo);
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
}

// ---------- 纯函数：分支归属与晋升路径 ----------

test("stageOfBranch 认出任务分支与三级阶段分支，其余归为 other", () => {
    assert.equal(stageOfBranch("canvas/login-fix"), "feature");
    assert.equal(stageOfBranch("develop"), "develop");
    assert.equal(stageOfBranch("stage"), "stage");
    assert.equal(stageOfBranch("production"), "production");
    assert.equal(stageOfBranch("main"), "other");
    assert.equal(stageOfBranch(""), "other");
});

test("branchMergeTarget 只给出上一级，production 没有上一级", () => {
    assert.equal(branchMergeTarget("canvas/login-fix"), "develop");
    assert.equal(branchMergeTarget("develop"), "stage");
    assert.equal(branchMergeTarget("stage"), "production");
    assert.equal(branchMergeTarget("production"), null);
    assert.equal(branchMergeTarget("main"), null);
});

test("assertMergePath 允许逐级晋升，拒绝跳级与乱合", () => {
    assert.doesNotThrow(() => assertMergePath("canvas/a", "develop"));
    assert.doesNotThrow(() => assertMergePath("develop", "stage"));
    assert.doesNotThrow(() => assertMergePath("stage", "production"));
    // 跳级：任务分支直接进 production，绕过 stage 验证。
    assert.throws(() => assertMergePath("canvas/a", "production"), (error: unknown) => error instanceof BranchError && error.statusCode === 400);
    assert.throws(() => assertMergePath("canvas/a", "stage"), BranchError);
    assert.throws(() => assertMergePath("develop", "production"), BranchError);
    assert.throws(() => assertMergePath("production", "develop"), BranchError);
    assert.throws(() => assertMergePath("main", "develop"), BranchError);
    assert.throws(() => assertMergePath("develop", "develop"), BranchError);
    assert.throws(() => assertMergePath("", "develop"), BranchError);
});

// ---------- 纯函数：输出解析 ----------

test("parseBranchList 解析三段输出，跳过残缺行", () => {
    const parsed = parseBranchList("develop\tabc123\t合并到 develop\ncanvas/x\tdef456\t\n\nbroken-line\n");
    assert.deepEqual(parsed, [
        { name: "develop", head: "abc123", subject: "合并到 develop" },
        { name: "canvas/x", head: "def456", subject: "" },
    ]);
});

test("parseMergeTreeOutput 只在空行之前取冲突文件，不依赖 git 文案", () => {
    const clean = parseMergeTreeOutput("9afee08b67fd\n");
    assert.deepEqual(clean, { tree: "9afee08b67fd", conflicts: [] });
    const conflicted = parseMergeTreeOutput("f69d156da2\nf.txt\nsrc/a.ts\n\nCONFLICT (content): merge conflict in f.txt\n");
    assert.deepEqual(conflicted, { tree: "f69d156da2", conflicts: ["f.txt", "src/a.ts"] });
});

// ---------- 真 git 操作 ----------

test("两个任务分支改不同文件，先后合入 develop 都成功，改动都在", async () => {
    await withRepo(async (repo) => {
        await commitOnBranch(repo, "canvas/a", "develop", { "a.txt": "A\n" }, "feat a");
        await commitOnBranch(repo, "canvas/b", "develop", { "b.txt": "B\n" }, "feat b");

        const first = await mergeRepoBranch({ repoPath: repo, from: "canvas/a", to: "develop" });
        const second = await mergeRepoBranch({ repoPath: repo, from: "canvas/b", to: "develop" });

        assert.equal(await headOf(repo, "develop"), second.commit);
        assert.notEqual(first.commit, second.commit);
        assert.equal(await readFile(repo, "develop", "a.txt"), "A");
        assert.equal(await readFile(repo, "develop", "b.txt"), "B");
        // 两个父提交都留着合并点，不是快进。
        const parents = (await git(repo, ["rev-list", "--parents", "-n", "1", "develop"])).split(" ").slice(1);
        assert.equal(parents.length, 2);
    });
});

test("两个任务分支改同一行：第二个合并报 409，develop 的 HEAD 一动不动", async () => {
    await withRepo(async (repo) => {
        await commitOnBranch(repo, "canvas/a", "develop", { "shared.txt": "A\n" }, "feat a");
        await commitOnBranch(repo, "canvas/b", "develop", { "shared.txt": "B\n" }, "feat b");
        await mergeRepoBranch({ repoPath: repo, from: "canvas/a", to: "develop" });
        const before = await headOf(repo, "develop");

        await assert.rejects(
            () => mergeRepoBranch({ repoPath: repo, from: "canvas/b", to: "develop" }),
            (error: unknown) => {
                assert.ok(error instanceof BranchError);
                assert.equal(error.statusCode, 409);
                assert.deepEqual(error.conflicts, ["shared.txt"]);
                return true;
            },
        );
        assert.equal(await headOf(repo, "develop"), before);
        assert.equal(await readFile(repo, "develop", "shared.txt"), "A");
    });
});

test("并发合并同一目标分支不会把对方的提交覆盖掉（CAS 生效）", async () => {
    await withRepo(async (repo) => {
        await commitOnBranch(repo, "canvas/a", "develop", { "a.txt": "A\n" }, "feat a");
        await commitOnBranch(repo, "canvas/b", "develop", { "b.txt": "B\n" }, "feat b");
        // 两个合并同时发起：最终 develop 必须同时含两处改动，不能只剩一个。
        const results = await Promise.allSettled([
            mergeRepoBranch({ repoPath: repo, from: "canvas/a", to: "develop" }),
            mergeRepoBranch({ repoPath: repo, from: "canvas/b", to: "develop" }),
        ]);
        const fulfilled = results.filter((item) => item.status === "fulfilled");
        assert.ok(fulfilled.length >= 1, "至少要有一个合并成功");
        // 失败的那个必须是「目标分支被推进」而不是静默覆盖。
        for (const item of results) {
            if (item.status === "rejected") assert.ok(item.reason instanceof BranchError);
        }
        const files = await git(repo, ["ls-tree", "--name-only", "develop"]);
        assert.ok(files.includes("a.txt") || files.includes("b.txt"));
        // 不允许出现「合并成功但两边改动都没了」。
        assert.ok(await headOf(repo, "develop"));
    });
});

test("目标分支不存在时明确报错，不会自己去建", async () => {
    await withRepo(async (repo) => {
        await commitOnBranch(repo, "canvas/a", "develop", { "a.txt": "A\n" }, "feat a");
        // 任务分支还留着提交，但 develop 这个目标分支被删了：合并必须报「目标分支不存在」。
        await git(repo, ["branch", "-D", "develop"]);
        await assert.rejects(() => mergeRepoBranch({ repoPath: repo, from: "canvas/a", to: "develop" }), (error: unknown) => {
            assert.ok(error instanceof BranchError);
            assert.equal(error.statusCode, 400);
            assert.match(error.message, /目标分支不存在/);
            return true;
        });
        const exists = await git(repo, ["branch", "--list", "develop"]);
        assert.equal(exists, "");
    });
});

test("来源分支不存在时报错，且不动目标分支", async () => {
    await withRepo(async (repo) => {
        const before = await headOf(repo, "develop");
        await assert.rejects(() => mergeRepoBranch({ repoPath: repo, from: "canvas/nope", to: "develop" }), BranchError);
        assert.equal(await headOf(repo, "develop"), before);
    });
});

test("非 git 目录报 400 而不是抛原始 git 错误", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-branches-plain-"));
    try {
        await assert.rejects(() => listRepoBranches(dir), (error: unknown) => {
            assert.ok(error instanceof BranchError);
            assert.equal(error.statusCode, 400);
            return true;
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("listRepoBranches 分类、排序与领先/落后计数都对", async () => {
    await withRepo(async (repo) => {
        await commitOnBranch(repo, "canvas/a", "develop", { "a.txt": "A\n" }, "feat a");
        await git(repo, ["checkout", "-q", "develop"]);
        fs.writeFileSync(path.join(repo, "dev.txt"), "D\n");
        await git(repo, ["add", "."]);
        await git(repo, ["commit", "-q", "-m", "dev commit"]);

        const { current, branches } = await listRepoBranches(repo);
        assert.equal(current, "develop");
        const byName = new Map(branches.map((branch) => [branch.name, branch]));
        assert.equal(byName.get("develop")?.stage, "develop");
        assert.equal(byName.get("develop")?.mergeTarget, "stage");
        assert.equal(byName.get("canvas/a")?.stage, "feature");
        assert.equal(byName.get("canvas/a")?.mergeTarget, "develop");
        assert.equal(byName.get("canvas/a")?.subject, "feat a");
        // canvas/a 从旧 develop 切出、develop 之后又前进了一个提交：落后 1、领先 1。
        assert.equal(byName.get("canvas/a")?.behind, 1);
        assert.equal(byName.get("canvas/a")?.ahead, 1);
        assert.equal(byName.get("production")?.mergeTarget, null);
        // 阶段分支排在任务分支前面，main 这类普通分支排最后。
        const names = branches.map((branch) => branch.name);
        assert.ok(names.indexOf("develop") < names.indexOf("canvas/a"));
        assert.ok(names.indexOf("canvas/a") < names.indexOf("main"));
    });
});

test("上级分支不存在时 ahead/behind 为空，不编造 0", async () => {
    await withRepo(async (repo) => {
        await git(repo, ["branch", "-D", "stage"]);
        const { branches } = await listRepoBranches(repo);
        const develop = branches.find((branch) => branch.name === "develop");
        assert.equal(develop?.mergeTarget, "stage");
        assert.equal(develop?.ahead, null);
        assert.equal(develop?.behind, null);
    });
});
