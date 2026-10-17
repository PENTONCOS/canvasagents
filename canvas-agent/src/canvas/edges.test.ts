import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";

import { buildCanvasToolRequest } from "./operations.js";
import { canvasOpSchema, toolInputSchemas } from "./schemas.js";
import { CanvasSession } from "./session.js";
import { compactCanvasState, compactConnection, EDGE_METADATA_PREVIEW_LIMIT, parseToolInput } from "./tools.js";
import type { CanvasConnection, CanvasSnapshot } from "./types.js";

/** 读取测试对象字段。 */
function field(value: unknown, key: string) {
    return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

/** 断言 schema 校验通过并返回解析结果。 */
function parseOk(schema: { parse: (input: unknown) => unknown }, input: unknown) {
    return schema.parse(input) as Record<string, unknown>;
}

/** 构造带连线的最小画布快照。 */
function snapshotWith(connections: CanvasConnection[]): CanvasSnapshot {
    return { projectId: "canvas-1", nodes: [], connections, selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } };
}

test("connect_nodes 操作接受 edgeType/label/metadata.contract", () => {
    const op = parseOk(canvasOpSchema, {
        type: "connect_nodes",
        fromNodeId: "req",
        toNodeId: "svc",
        edgeType: "http",
        label: "GET /orders",
        metadata: { contract: { method: "GET", path: "/orders", notes: "查询订单" }, extra: 1 },
    });
    assert.equal(op.edgeType, "http");
    assert.equal(op.label, "GET /orders");
    assert.deepEqual(op.metadata, { contract: { method: "GET", path: "/orders", notes: "查询订单" }, extra: 1 });
});

test("connect_nodes 操作拒绝未知 edgeType 与非对象 contract", () => {
    assert.equal(canvasOpSchema.safeParse({ type: "connect_nodes", fromNodeId: "a", toNodeId: "b", edgeType: "grpc" }).success, false);
    assert.equal(canvasOpSchema.safeParse({ type: "connect_nodes", fromNodeId: "a", toNodeId: "b", metadata: { contract: "not-an-object" } }).success, false);
    assert.equal(canvasOpSchema.safeParse({ type: "connect_nodes", fromNodeId: "a", toNodeId: "b" }).success, true);
});

test("update_connection 操作接受边语义补丁", () => {
    const op = parseOk(canvasOpSchema, { type: "update_connection", id: "edge-1", edgeType: "event", label: "订单事件", metadata: { contract: { path: "/orders" } } });
    assert.equal(op.id, "edge-1");
    assert.equal(op.edgeType, "event");
    assert.deepEqual(op.metadata, { contract: { path: "/orders" } });
});

test("canvas_connect_nodes 工具入参校验后转为 apply_ops 边字段", () => {
    const input = parseToolInput("canvas_connect_nodes", {
        connections: [{ fromNodeId: "req", toNodeId: "svc", edgeType: "db", label: "读写订单库", metadata: { contract: { path: "/db/orders" } } }],
    });
    const request = buildCanvasToolRequest("canvas_connect_nodes", input, null);
    assert.equal(request.name, "canvas_apply_ops");
    assert.deepEqual(field(request.input, "ops"), [{
        type: "connect_nodes",
        fromNodeId: "req",
        toNodeId: "svc",
        edgeType: "db",
        label: "读写订单库",
        metadata: { contract: { path: "/db/orders" } },
    }]);
    assert.equal(toolInputSchemas.canvas_connect_nodes.safeParse({ connections: [{ fromNodeId: "a", toNodeId: "b", edgeType: "mq" }] }).success, false);
});

test("节点 metadata 的 stage 受枚举校验并在创建/更新路径透传", () => {
    const create = parseToolInput("canvas_create_node", { nodeType: "text", metadata: { stage: "requirement", content: "需求正文" } });
    const ops = field(buildCanvasToolRequest("canvas_create_node", create, null).input, "ops") as Array<Record<string, unknown>>;
    assert.deepEqual(ops[0].metadata, { stage: "requirement", content: "需求正文" });

    const update = parseToolInput("canvas_update_node", { id: "n1", metadata: { stage: "service" } });
    const updateOps = field(buildCanvasToolRequest("canvas_update_node", update, null).input, "ops") as Array<Record<string, unknown>>;
    assert.deepEqual(updateOps[0].metadata, { stage: "service" });

    assert.equal(toolInputSchemas.canvas_create_node.safeParse({ nodeType: "text", metadata: { stage: "runtime" } }).success, true);
    assert.equal(toolInputSchemas.canvas_create_node.safeParse({ nodeType: "text", metadata: { stage: "ops" } }).success, false);
    assert.equal(toolInputSchemas.canvas_update_node.safeParse({ id: "n1", metadata: { stage: "unknown" } }).success, false);
    assert.equal(canvasOpSchema.safeParse({ type: "add_node", metadata: { stage: "test" } }).success, true);
    assert.equal(canvasOpSchema.safeParse({ type: "update_node", id: "n1", metadata: { stage: "deploy" } }).success, false);
});

test("canvas_create_node 接受网页端已注册的扩展节点类型并原样透传", () => {
    const extended = ["code", "repo", "service", "image-regions", "editor", "preview", "terminal", "group"];
    extended.forEach((nodeType) => {
        assert.equal(toolInputSchemas.canvas_create_node.safeParse({ nodeType }).success, true, `${nodeType} 应被接受`);
        const ops = field(buildCanvasToolRequest("canvas_create_node", parseToolInput("canvas_create_node", { nodeType, metadata: { stage: "code" } }), null).input, "ops") as Array<Record<string, unknown>>;
        assert.equal(ops[0].nodeType, nodeType, `${nodeType} 应透传到 add_node`);
        assert.deepEqual(ops[0].metadata, { stage: "code" });
    });

    assert.equal(toolInputSchemas.canvas_create_node.safeParse({ nodeType: "unknown-type" }).success, false);
    assert.equal(canvasOpSchema.safeParse({ type: "add_node", nodeType: "unknown-type" }).success, false);
    assert.equal(canvasOpSchema.safeParse({ type: "add_node", nodeType: "repo" }).success, true);
});

test("canvas_update_edge 按 from/to 定位并局部合并 metadata（不改动其他键）", () => {
    const state = snapshotWith([{
        id: "edge-1",
        fromNodeId: "req",
        toNodeId: "svc",
        type: "flow",
        label: "旧标签",
        metadata: { contract: { method: "GET", path: "/orders", notes: "沿用" }, note: "保留" },
    }]);
    const request = buildCanvasToolRequest("canvas_update_edge", {
        fromNodeId: "req",
        toNodeId: "svc",
        edgeType: "http",
        label: "新标签",
        metadata: { contract: { path: "/orders/v2" } },
    }, state);
    assert.deepEqual(field(request.input, "ops"), [{
        type: "update_connection",
        id: "edge-1",
        fromNodeId: "req",
        toNodeId: "svc",
        edgeType: "http",
        label: "新标签",
        metadata: { contract: { method: "GET", path: "/orders/v2", notes: "沿用" }, note: "保留" },
    }]);
});

test("canvas_update_edge 支持 edgeId 定位且只带本次修改的字段", () => {
    const state = snapshotWith([{ id: "edge-9", fromNodeId: "a", toNodeId: "b", type: "flow", metadata: { note: "keep" } }]);
    const request = buildCanvasToolRequest("canvas_update_edge", { edgeId: "edge-9", metadata: { note: "changed", added: true } }, state);
    assert.deepEqual(field(request.input, "ops"), [{
        type: "update_connection",
        id: "edge-9",
        fromNodeId: "a",
        toNodeId: "b",
        metadata: { note: "changed", added: true },
    }]);
});

test("canvas_update_edge 对缺失目标与缺失标识报可读错误", () => {
    assert.throws(() => buildCanvasToolRequest("canvas_update_edge", { fromNodeId: "a", toNodeId: "b" }, null), /当前画布没有可更新的连线/);
    assert.throws(() => buildCanvasToolRequest("canvas_update_edge", { fromNodeId: "a", toNodeId: "b" }, snapshotWith([])), /当前画布没有可更新的连线/);
    assert.throws(() => buildCanvasToolRequest("canvas_update_edge", { fromNodeId: "a", toNodeId: "missing" }, snapshotWith([{ id: "edge-1", fromNodeId: "a", toNodeId: "b" }])), /找不到要更新的连线：a -> missing/);
    assert.throws(() => buildCanvasToolRequest("canvas_update_edge", { edgeId: "edge-x" }, snapshotWith([{ id: "edge-1", fromNodeId: "a", toNodeId: "b" }])), /找不到要更新的连线：edgeId=edge-x/);
    assert.throws(() => buildCanvasToolRequest("canvas_update_edge", { label: "x" }, snapshotWith([{ id: "edge-1", fromNodeId: "a", toNodeId: "b" }])), /需要 edgeId/);
});

test("compactCanvasState 回吐 edgeType/label/metadata 且缺省 type 为 flow", () => {
    const state = snapshotWith([
        { id: "edge-1", fromNodeId: "a", toNodeId: "b", type: "depends-on", label: "依赖", metadata: { contract: { path: "/x" } } },
        { id: "edge-2", fromNodeId: "b", toNodeId: "c" },
    ]);
    const connections = compactCanvasState(state).connections as Array<Record<string, unknown>>;
    assert.deepEqual(connections[0], { id: "edge-1", fromNodeId: "a", toNodeId: "b", type: "depends-on", label: "依赖", metadata: { contract: { path: "/x" } } });
    assert.deepEqual(connections[1], { id: "edge-2", fromNodeId: "b", toNodeId: "c", type: "flow" });
});

test("compactConnection 对超大 metadata 截断并标记 metadataTruncated，且不改动原始对象", () => {
    const original: CanvasConnection = { id: "edge-1", fromNodeId: "a", toNodeId: "b", metadata: { contract: { openapi: "x".repeat(EDGE_METADATA_PREVIEW_LIMIT + 100) } } };
    const compacted = compactConnection(original) as Record<string, unknown>;
    const metadata = compacted.metadata as Record<string, unknown>;
    assert.equal(metadata.metadataTruncated, true);
    assert.equal(String(metadata.preview).length, EDGE_METADATA_PREVIEW_LIMIT + 3);
    assert.equal(String(metadata.preview).endsWith("..."), true);
    assert.equal(compacted.type, "flow");
    assert.equal(field(original.metadata, "metadataTruncated"), undefined);
    assert.equal(JSON.stringify(original.metadata).length > EDGE_METADATA_PREVIEW_LIMIT, true);
});

test("canvas_update_edge 通过当前画布定位连线并发送给目标网页", async (t) => {
    const session = new CanvasSession();
    const client = connect(session, "first");
    t.after(() => client.close());
    session.updateState(snapshotWith([{ id: "edge-1", fromNodeId: "req", toNodeId: "svc", type: "flow", metadata: { contract: { method: "GET" } } }]), "first");

    const pending = session.callTool("canvas_update_edge", { fromNodeId: "req", toNodeId: "svc", edgeType: "http", metadata: { contract: { path: "/orders" } } });
    const call = client.event("tool_call");
    assert.equal(field(call, "name"), "canvas_apply_ops");
    const ops = field(field(call, "input"), "ops") as Array<Record<string, unknown>>;
    assert.equal(ops[0].type, "update_connection");
    assert.equal(ops[0].id, "edge-1");
    assert.deepEqual(ops[0].metadata, { contract: { method: "GET", path: "/orders" } });
    session.resolveResult("first", { requestId: String(field(call, "requestId")), result: { ok: true } });
    assert.deepEqual(await pending, { ok: true });
});

test("canvas_get_state 读回带语义的连线", async (t) => {
    const session = new CanvasSession();
    const client = connect(session, "first");
    t.after(() => client.close());
    session.updateState(snapshotWith([{ id: "edge-1", fromNodeId: "req", toNodeId: "svc", type: "http", label: "GET /orders", metadata: { contract: { method: "GET", path: "/orders" } } }]), "first");

    const state = (await session.callTool("canvas_get_state", {})) as Record<string, unknown>;
    assert.deepEqual(state.connections, [{ id: "edge-1", fromNodeId: "req", toNodeId: "svc", type: "http", label: "GET /orders", metadata: { contract: { method: "GET", path: "/orders" } } }]);
});

/** 创建用于测试的画布 SSE 连接。 */
function connect(session: CanvasSession, clientId: string) {
    const response = new FakeSseResponse();
    session.openEvents(new URL(`http://127.0.0.1/events?clientId=${clientId}`), response as unknown as ServerResponse);
    return response;
}

/** 模拟 Node SSE 响应并提供事件读取能力。 */
class FakeSseResponse extends EventEmitter {
    private chunks: string[] = [];

    /** 模拟写入响应头。 */
    writeHead() {
        return this;
    }

    /** 保存写入的 SSE 文本块。 */
    write(chunk: string) {
        this.chunks.push(chunk);
        return true;
    }

    /** 读取指定类型的首个 SSE 事件数据。 */
    event(type: string) {
        return this.events(type)[0];
    }

    /** 读取指定类型的全部 SSE 事件数据。 */
    events(type: string) {
        return this.chunks.flatMap((chunk) => {
            if (!chunk.startsWith(`event: ${type}\n`)) return [];
            const data = chunk.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
            return data ? [JSON.parse(data) as unknown] : [];
        });
    }

    /** 触发连接关闭事件。 */
    close() {
        this.emit("close");
    }
}
