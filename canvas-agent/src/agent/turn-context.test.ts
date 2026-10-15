import assert from "node:assert/strict";
import test from "node:test";

import { buildTurnContextPrompt, turnContextAttachments } from "./turn-context.js";

test("画布已有素材明确禁止重复建节点", () => {
    const prompt = buildTurnContextPrompt("把这张图改成蓝色调", [{ id: "canvas:node-1", name: "参考.png", source: "canvas", canvasNodeId: "node-1" }], true);
    assert.match(prompt, /把这张图改成蓝色调/);
    assert.match(prompt, /node-1/);
    assert.match(prompt, /禁止对它们调用 canvas_create_attachment_nodes/);
    assert.doesNotMatch(prompt, /用户本轮上传的图片：/);
});

test("本轮上传的附件仍要求先创建画布节点", () => {
    const prompt = buildTurnContextPrompt("生成一张图", [{ id: "attachment-1", name: "a.png", source: "upload" }], true);
    assert.match(prompt, /用户本轮上传的图片：需要放入画布/);
    assert.doesNotMatch(prompt, /禁止对它们调用 canvas_create_attachment_nodes/);
});

test("无可用生图通道时要求改用 Codex 内置 imagegen", () => {
    const prompt = buildTurnContextPrompt("生成一张图", [], false);
    assert.match(prompt, /内置 imagegen/);
    assert.match(prompt, /不要调用 canvas_generate_image/);
});

test("有生图通道时不插入内置生图指令", () => {
    const prompt = buildTurnContextPrompt("生成一张图", [], true);
    assert.equal(prompt, "生成一张图");
});

test("没有任何附件也没有通道信息时原样返回 prompt", () => {
    assert.equal(buildTurnContextPrompt("你好", [], true), "你好");
});

test("本轮上传与画布素材同时存在时两条规则都在", () => {
    const prompt = buildTurnContextPrompt("合成", [{ id: "attachment-1", name: "a.png", source: "upload" }, { id: "canvas:node-1", name: "b.png", source: "canvas", canvasNodeId: "node-1" }], true);
    assert.match(prompt, /用户本轮上传的图片：需要放入画布/);
    assert.match(prompt, /画布已有素材（共 1 个）/);
});

test("turnContextAttachments 归一化缺失字段并保留画布来源", () => {
    const list = turnContextAttachments([{ name: "参考.png", source: "canvas", canvasNodeId: "n1" }, { dataUrl: "data:image/png;base64,eA==" }]);
    assert.equal(list[0].id, "attachment-1");
    assert.equal(list[0].name, "参考.png");
    assert.equal(list[0].source, "canvas");
    assert.equal(list[0].canvasNodeId, "n1");
    assert.equal(list[1].id, "attachment-2");
    assert.equal(list[1].name, "图片 2");
    assert.equal(list[1].source, undefined);
    assert.equal(list[1].canvasNodeId, undefined);
});
