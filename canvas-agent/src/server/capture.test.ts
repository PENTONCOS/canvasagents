import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { pickCaptureWindow, type ScreenWindow } from "./capture.js";

test("pickCaptureWindow 优先选标题命中的浏览器窗口", () => {
    const windows: ScreenWindow[] = [
        { id: 1, owner: "Google Chrome", layer: 0, x: 0, y: 0, width: 3000, height: 1800, name: "别的标签页" },
        { id: 2, owner: "Google Chrome", layer: 0, x: 0, y: 0, width: 1200, height: 800, name: "CanvasAgents" },
        { id: 3, owner: "Finder", layer: 0, x: 0, y: 0, width: 2000, height: 2000, name: "Documents" },
    ];
    const picked = pickCaptureWindow(windows, { title: "canvasagents" });
    assert.equal(picked.window?.id, 2);
    assert.equal(picked.strategy, "title-match");
    assert.deepEqual(picked.candidates.map((item) => item.id), [2]);
});

test("pickCaptureWindow 标题不命中时退回面积最大的浏览器窗口", () => {
    const windows: ScreenWindow[] = [
        { id: 1, owner: "Google Chrome", layer: 0, x: 0, y: 0, width: 900, height: 600, name: "小窗" },
        { id: 2, owner: "Google Chrome", layer: 0, x: 0, y: 0, width: 3000, height: 1800, name: "大窗" },
        { id: 3, owner: "Finder", layer: 0, x: 0, y: 0, width: 4000, height: 4000, name: "更大的非浏览器窗" },
    ];
    const picked = pickCaptureWindow(windows, { title: "不存在的标题" });
    assert.equal(picked.window?.id, 2);
    assert.equal(picked.strategy, "largest-browser");
});

test("pickCaptureWindow 排除非普通层、小窗与非浏览器属主", () => {
    const windows: ScreenWindow[] = [
        { id: 1, owner: "Google Chrome", layer: 3, x: 0, y: 0, width: 3000, height: 1800, name: "浮动层" },
        { id: 2, owner: "Google Chrome", layer: 0, x: 0, y: 0, width: 200, height: 120, name: "小提示窗" },
        { id: 3, owner: "Dock", layer: 0, x: 0, y: 0, width: 3000, height: 1800, name: "Dock" },
    ];
    assert.equal(pickCaptureWindow(windows).window, null);
});

test("pickCaptureWindow 识别 Chromium 系属主，且无候选时返回 null", () => {
    const windows: ScreenWindow[] = [
        { id: 7, owner: "Brave Browser", layer: 0, x: 0, y: 0, width: 1600, height: 1000, name: "Brave" },
        { id: 8, owner: "Terminal", layer: 0, x: 0, y: 0, width: 1600, height: 1000, name: "zsh" },
    ];
    assert.equal(pickCaptureWindow(windows).window?.id, 7);
    assert.equal(pickCaptureWindow([]).window, null);
    assert.equal(pickCaptureWindow([]).strategy, "largest-browser");
});

test("pickCaptureWindow 允许用 owner 正则覆盖默认属主集合", () => {
    const windows: ScreenWindow[] = [
        { id: 1, owner: "Google Chrome", layer: 0, x: 0, y: 0, width: 3000, height: 1800, name: "Chrome" },
        { id: 2, owner: "Electron", layer: 0, x: 0, y: 0, width: 1200, height: 800, name: "画布客户端" },
    ];
    assert.equal(pickCaptureWindow(windows, { owner: "^Electron$" }).window?.id, 2);
    // 非法正则不应抛错，退回默认属主集合
    assert.equal(pickCaptureWindow(windows, { owner: "[" }).window?.id, 1);
});

test("pickCaptureWindow 要求标题必须命中时，宁可拒绝也不抓错窗", () => {
    const windows: ScreenWindow[] = [
        { id: 1, owner: "Google Chrome", layer: 0, x: 0, y: 0, width: 3000, height: 1800, name: "删除背景文字 png" },
    ];
    const picked = pickCaptureWindow(windows, { title: "CanvasAgents", requireTitle: true });
    assert.equal(picked.window, null);
    assert.equal(picked.strategy, "no-title-match");
    // 候选仍回传，便于把「当前可见窗口」告诉用户
    assert.deepEqual(picked.candidates.map((item) => item.id), [1]);
});

test("pickCaptureWindow 不要求标题时仍保留兼容的兵底行为", () => {
    const windows: ScreenWindow[] = [
        { id: 1, owner: "Google Chrome", layer: 0, x: 0, y: 0, width: 3000, height: 1800, name: "别的页" },
    ];
    const picked = pickCaptureWindow(windows, { title: "CanvasAgents" });
    assert.equal(picked.window?.id, 1);
    assert.equal(picked.strategy, "largest-browser");
});

test("pickCaptureWindow 无标题要求时不因缺 hint 而拒绝", () => {
    const windows: ScreenWindow[] = [
        { id: 1, owner: "Google Chrome", layer: 0, x: 0, y: 0, width: 3000, height: 1800, name: "" },
    ];
    assert.equal(pickCaptureWindow(windows, { requireTitle: true }).window?.id, 1);
});

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
