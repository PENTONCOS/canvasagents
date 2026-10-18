import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { isSafeWallFile, parseWallFileName, pruneWall, sanitizeNodeId, wallFileName } from "./capture.js";

test("sanitizeNodeId 只保留安全字符并截断", () => {
    assert.equal(sanitizeNodeId("node-1_Abc"), "node-1_Abc");
    assert.equal(sanitizeNodeId("../../etc/passwd"), "etcpasswd");
    assert.equal(sanitizeNodeId("a b/c?d"), "abcd");
    assert.equal(sanitizeNodeId(undefined), "");
    assert.equal(sanitizeNodeId("x".repeat(80)).length, 48);
});

test("wallFileName / parseWallFileName 往返一致", () => {
    assert.equal(wallFileName(1700000000000, "node-7"), "1700000000000-node-7.png");
    assert.equal(wallFileName(1700000000000, ""), "1700000000000.png");
    assert.deepEqual(parseWallFileName("1700000000000-node-7.png"), { createdAt: 1700000000000, nodeId: "node-7" });
    assert.deepEqual(parseWallFileName("1700000000000.png"), { createdAt: 1700000000000, nodeId: "" });
    assert.equal(parseWallFileName("not-a-shot.png"), null);
    assert.equal(parseWallFileName("1700000000000-node-7.jpg"), null);
});

test("isSafeWallFile 拒绝目录穿越", () => {
    assert.equal(isSafeWallFile("1700000000000.png"), true);
    assert.equal(isSafeWallFile("../secret.png"), false);
    assert.equal(isSafeWallFile("dir/1700000000000.png"), false);
    assert.equal(isSafeWallFile(""), false);
    assert.equal(isSafeWallFile("shot.PNG"), true);
});

test("pruneWall 只保留最新 max 张", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wall-prune-"));
    for (const name of ["1000.png", "2000.png", "3000.png", "4000.png", "5000.png"]) {
        await writeFile(path.join(dir, name), "x");
    }
    const removed = await pruneWall(dir, 3);
    assert.equal(removed, 2);
    assert.deepEqual((await readdir(dir)).sort(), ["3000.png", "4000.png", "5000.png"]);
    // 未超上限时不动文件
    assert.equal(await pruneWall(dir, 3), 0);
});

test("pruneWall 对不存在的目录返回 0", async () => {
    assert.equal(await pruneWall(path.join(tmpdir(), "wall-missing-xyz"), 3), 0);
});
