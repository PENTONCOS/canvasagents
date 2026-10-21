import assert from "node:assert/strict";
import test from "node:test";

import { compactNode, expandNode, isToolName, NODE_CONTENT_FULL_LIMIT, NODE_CONTENT_PREVIEW_LIMIT } from "./tools.js";
import type { CanvasNode } from "./types.js";

/** 构造带指定正文的文本节点。 */
function textNode(content: string): CanvasNode {
    return { id: "node-1", type: "text", title: "需求文档", position: { x: 0, y: 0 }, width: 320, height: 200, metadata: { content } };
}

test("compactNode 保留不超过 2000 字符的内容且不加截断标记", () => {
    const content = "a".repeat(NODE_CONTENT_PREVIEW_LIMIT);
    const node = compactNode(textNode(content));
    assert.equal(node.metadata.content, content);
    assert.equal(node.metadata.contentTruncated, undefined);
});

test("compactNode 超过 2000 字符时截断并标记 contentTruncated", () => {
    const node = compactNode(textNode("a".repeat(NODE_CONTENT_PREVIEW_LIMIT + 1)));
    const content = node.metadata.content as string;
    assert.equal(content.length, NODE_CONTENT_PREVIEW_LIMIT + 3);
    assert.equal(content, `${"a".repeat(NODE_CONTENT_PREVIEW_LIMIT)}...`);
    assert.equal(node.metadata.contentTruncated, true);
});

test("compactNode 不改动原始节点 metadata", () => {
    const original = textNode("a".repeat(NODE_CONTENT_PREVIEW_LIMIT + 10));
    compactNode(original);
    assert.equal(original.metadata?.content, "a".repeat(NODE_CONTENT_PREVIEW_LIMIT + 10));
    assert.equal(original.metadata?.contentTruncated, undefined);
});

test("expandNode 返回完整内容且 truncated 为 false", () => {
    const content = "code".repeat(5000);
    const node = expandNode(textNode(content));
    assert.equal(node.metadata.content, content);
    assert.equal(node.truncated, false);
});

test("expandNode 超过 200000 字符时截断并标记 truncated", () => {
    const node = expandNode(textNode("b".repeat(NODE_CONTENT_FULL_LIMIT + 1)));
    assert.equal((node.metadata.content as string).length, NODE_CONTENT_FULL_LIMIT);
    assert.equal(node.truncated, true);
});

test("canvas_get_node 已注册为画布工具", () => {
    assert.equal(isToolName("canvas_get_node"), true);
    assert.equal(isToolName("canvas_get_node_full"), false);
});

test("compactNode 交付域节点剔除媒体字段并保留 statement 全文", () => {
    const node: CanvasNode = {
        id: "n1", type: "acceptance", title: "AC-01", position: { x: 0, y: 0 }, width: 320, height: 160,
        metadata: { status: "idle", acId: "AC-01", statement: "改约后立即显示新时间", images: [{ id: "big" }], timeline: [1, 2, 3] },
    };
    const out = compactNode(node);
    assert.equal((out.metadata as Record<string, unknown>).statement, "改约后立即显示新时间");
    assert.equal((out.metadata as Record<string, unknown>).acId, "AC-01");
    assert.equal((out.metadata as Record<string, unknown>).images, undefined);
    assert.equal((out.metadata as Record<string, unknown>).timeline, undefined);
});

test("compactNode 非交付域节点不受影响", () => {
    const node: CanvasNode = {
        id: "n2", type: "image", position: { x: 0, y: 0 }, width: 340, height: 240,
        metadata: { content: "pic", images: [{ id: "keep" }] },
    };
    const out = compactNode(node);
    assert.deepEqual((out.metadata as Record<string, unknown>).images, [{ id: "keep" }]);
});

test("compactNode 交付域 statement 超长时截断并打标", () => {
    const node: CanvasNode = {
        id: "n3", type: "requirement", position: { x: 0, y: 0 }, width: 280, height: 160,
        metadata: { statement: "a".repeat(NODE_CONTENT_PREVIEW_LIMIT + 1) },
    };
    const out = compactNode(node);
    assert.equal((out.metadata as Record<string, unknown>).statementTruncated, true);
    assert.equal(String((out.metadata as Record<string, unknown>).statement).length, NODE_CONTENT_PREVIEW_LIMIT + 1);
});
