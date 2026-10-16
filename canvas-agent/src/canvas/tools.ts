import { toolInputSchemas, toolNames, type ToolName } from "./schemas.js";
import type { CanvasNode, CanvasSnapshot } from "./types.js";

/** canvas_get_state 等列表工具返回的单节点内容预览上限（字符）。 */
export const NODE_CONTENT_PREVIEW_LIMIT = 2000;
/** canvas_get_node 返回单节点全文时的内容上限（字符）。 */
export const NODE_CONTENT_FULL_LIMIT = 200000;

/** 判断传入名称是否为已注册的画布工具。 */
export function isToolName(name: unknown): name is ToolName {
    return typeof name === "string" && toolNames.includes(name as ToolName);
}

/** 按工具名称校验并解析调用参数。 */
export function parseToolInput(name: ToolName, input: unknown) {
    return toolInputSchemas[name].parse(input ?? {});
}

/** 压缩画布快照，避免向 Agent 返回过长的节点内容。 */
export function compactCanvasState(state: CanvasSnapshot | null) {
    if (!state) throw new Error("当前没有已连接画布");
    return { ...state, nodes: (state.nodes || []).map(compactNode) };
}

/** 压缩单个画布节点的元数据内容，截断时用 contentTruncated 标记。 */
export function compactNode(node: CanvasNode) {
    const metadata = { ...(node.metadata || {}) };
    if (typeof metadata.content === "string" && metadata.content.length > NODE_CONTENT_PREVIEW_LIMIT) {
        metadata.content = `${metadata.content.slice(0, NODE_CONTENT_PREVIEW_LIMIT)}...`;
        metadata.contentTruncated = true;
    }
    return { id: node.id, type: node.type, title: node.title, position: node.position, width: node.width, height: node.height, metadata };
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
