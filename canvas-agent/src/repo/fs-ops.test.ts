import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRepoTree, languageForFile, MAX_FILE_BYTES, readRepoFile, RepoPathError, resolveRepoPath } from "./fs-ops.js";

/** 创建临时仓库目录并写入若干文件。 */
function makeRepo(): string {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-repo-test-"));
    fs.mkdirSync(path.join(base, "src", "nested"), { recursive: true });
    fs.writeFileSync(path.join(base, "README.md"), "# 标题\n");
    fs.writeFileSync(path.join(base, "src", "index.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(base, "src", "nested", "deep.ts"), "export const deep = 2;\n");
    fs.mkdirSync(path.join(base, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(base, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
    return base;
}

test("resolveRepoPath 拒绝绝对路径", () => {
    const root = makeRepo();
    try {
        assert.throws(() => resolveRepoPath(root, "/etc/passwd"), RepoPathError);
        assert.throws(() => resolveRepoPath(root, "/etc/passwd"), /不接受绝对路径/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("resolveRepoPath 拒绝逃逸到仓库外的相对路径", () => {
    const root = makeRepo();
    try {
        assert.throws(() => resolveRepoPath(root, "../outside.txt"), /路径超出仓库范围/);
        assert.throws(() => resolveRepoPath(root, "src/../../etc/hosts"), /路径超出仓库范围/);
        assert.equal(resolveRepoPath(root, "src/index.ts"), path.join(root, "src", "index.ts"));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("buildRepoTree 跳过 node_modules 并遵守层级上限", async () => {
    const root = makeRepo();
    try {
        const tree = await buildRepoTree(root, "", 1);
        const paths = tree.entries.map((entry) => entry.path);
        assert.deepEqual(paths, ["src", "README.md"]);
        assert.equal(tree.truncated, false);

        const deeper = await buildRepoTree(root, "", 2);
        const deepPaths = deeper.entries.map((entry) => entry.path);
        assert.ok(deepPaths.includes("src/index.ts"));
        assert.ok(deepPaths.includes("src/nested"));
        assert.ok(!deepPaths.includes("src/nested/deep.ts"));
        assert.ok(!deepPaths.some((entry) => entry.includes("node_modules")));

        const subtree = await buildRepoTree(root, "src", 1);
        assert.deepEqual(subtree.entries.map((entry) => entry.path), ["src/nested", "src/index.ts"]);

        const subtreeDeep = await buildRepoTree(root, "src");
        assert.deepEqual(subtreeDeep.entries.map((entry) => entry.path), ["src/nested", "src/nested/deep.ts", "src/index.ts"]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("readRepoFile 返回文本内容与语言，拒绝二进制和越界路径", async () => {
    const root = makeRepo();
    try {
        const file = await readRepoFile(root, "src/index.ts");
        assert.equal(file.path, "src/index.ts");
        assert.equal(file.content, "export const value = 1;\n");
        assert.equal(file.truncated, false);
        assert.equal(file.language, "typescript");

        fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
        await assert.rejects(() => readRepoFile(root, "bin.dat"), /二进制/);
        await assert.rejects(() => readRepoFile(root, "../outside.txt"), /路径超出仓库范围/);
        await assert.rejects(() => readRepoFile(root, "missing.ts"), /文件不存在/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("readRepoFile 拒绝超过 2MB 的文件", async () => {
    const root = makeRepo();
    try {
        fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(MAX_FILE_BYTES + 1));
        await assert.rejects(() => readRepoFile(root, "big.txt"), /超过 2MB 上限/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("languageForFile 按扩展名映射", () => {
    assert.equal(languageForFile("a/b/index.tsx"), "typescript");
    assert.equal(languageForFile("main.py"), "python");
    assert.equal(languageForFile("unknown.binary"), undefined);
});
