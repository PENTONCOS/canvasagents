import { toolInputSchemas, toolNames, type ToolName } from "./schemas.js";
import type { CanvasConnection, CanvasNode, CanvasSnapshot } from "./types.js";

/** canvas_get_state 等列表工具返回的单节点内容预览上限（字符）。 */
export const NODE_CONTENT_PREVIEW_LIMIT = 2000;
/** canvas_get_node 返回单节点全文时的内容上限（字符）。 */
export const NODE_CONTENT_FULL_LIMIT = 200000;
/** canvas_get_state 返回单条边 metadata 的体积上限（字符）。 */
export const EDGE_METADATA_PREVIEW_LIMIT = 2000;

/** 判断传入名称是否为已注册的画布工具。 */
export function isToolName(name: unknown): name is ToolName {
    return typeof name === "string" && toolNames.includes(name as ToolName);
}

/** 按工具名称校验并解析调用参数。 */
export function parseToolInput(name: ToolName, input: unknown) {
    return toolInputSchemas[name].parse(input ?? {});
}

/** 压缩画布快照，避免向 Agent 返回过长的节点内容，并保留连线的边语义。 */
export function compactCanvasState(state: CanvasSnapshot | null) {
    if (!state) throw new Error("当前没有已连接画布");
    return { ...state, nodes: (state.nodes || []).map(compactNode), connections: (state.connections || []).map(compactConnection) };
}

/** 压缩单个画布节点的元数据内容，截断时用 contentTruncated 标记。 */
export function compactNode(node: CanvasNode) {
    const metadata = { ...(node.metadata || {}) };
    if (typeof metadata.content === "string" && metadata.content.length > NODE_CONTENT_PREVIEW_LIMIT) {
        metadata.content = `${metadata.content.slice(0, NODE_CONTENT_PREVIEW_LIMIT)}...`;
        metadata.contentTruncated = true;
    }
    compactDeliveryMetadata(node.type, metadata);
    return { id: node.id, type: node.type, title: node.title, position: node.position, width: node.width, height: node.height, metadata };
}

/** 交付域节点类型集合（与前端 types/canvas.ts 的 M0 枚举值一致）。 */
const DELIVERY_NODE_TYPES = new Set([
    "requirement",
    "journey",
    "journey.step",
    "design",
    "acceptance",
    "testcase",
    "bug",
    "environment",
    "run",
]);

/**
 * 交付域节点压缩（M0）：交付对象的短文本就是语义本体，整段保留；
 * 大体积媒体字段（图片引用/时间线/编辑历史）对 Agent 无意义，直接剔除，
 * 避免占用上下文预算。异常长的 statement 仍按预览上限截断并打标。
 */
function compactDeliveryMetadata(nodeType: string, metadata: Record<string, unknown>) {
    if (!DELIVERY_NODE_TYPES.has(nodeType)) return;
    for (const key of ["images", "references", "timeline", "history"]) delete metadata[key];
    // 设计稿只告诉 Agent「哪一版被选中」：三版内容同时进上下文会让它无从选择，
    // 也与产品规则「选定版本才进上下文」冲突。
    if (nodeType === "design") {
        delete metadata.content;
        delete metadata.images;
        delete metadata.status;
    }
    const statement = metadata.statement;
    if (typeof statement === "string" && statement.length > NODE_CONTENT_PREVIEW_LIMIT) {
        metadata.statement = `${statement.slice(0, NODE_CONTENT_PREVIEW_LIMIT)}.`;
        metadata.statementTruncated = true;
    }
}

/**
 * 压缩单条连线：保留 type/label/metadata 边语义，缺省 type 归一为 flow。
 * metadata 序列化后超过上限时截断并标记 metadataTruncated（原对象不被修改）。
 */
export function compactConnection(connection: CanvasConnection) {
    const metadata = connection.metadata;
    const json = metadata === undefined ? "" : safeJson(metadata);
    const compactedMetadata = metadata === undefined
        ? undefined
        : json.length > EDGE_METADATA_PREVIEW_LIMIT
            ? { metadataTruncated: true, preview: `${json.slice(0, EDGE_METADATA_PREVIEW_LIMIT)}...` }
            : metadata;
    return {
        id: connection.id,
        fromNodeId: connection.fromNodeId,
        toNodeId: connection.toNodeId,
        type: connection.type || connection.edgeType || "flow",
        ...(connection.label ? { label: connection.label } : {}),
        ...(compactedMetadata ? { metadata: compactedMetadata } : {}),
    };
}

/** 安全序列化为 JSON 字符串；不可序列化时返回空串。 */
function safeJson(value: unknown) {
    try {
        return JSON.stringify(value) ?? "";
    } catch {
        return "";
    }
}

/** 展开单个画布节点，保留完整内容供 canvas_get_node 读取。 */
export function expandNode(node: CanvasNode) {
    const metadata = { ...(node.metadata || {}) };
    let truncated = false;
    if (typeof metadata.content === "string" && metadata.content.length > NODE_CONTENT_FULL_LIMIT) {
        metadata.content = metadata.content.slice(0, NODE_CONTENT_FULL_LIMIT);
        truncated = true;
    }
    return { id: node.id, type: node.type, title: node.title, position: node.position, width: node.width, height: node.height, metadata, truncated };
}

/** 计算新节点在当前画布右侧的默认横坐标。 */
export function nextCanvasX(state: CanvasSnapshot | null) {
    const nodes = state?.nodes || [];
    return nodes.length ? Math.max(...nodes.map((node) => node.position.x + node.width)) + 80 : 0;
}
