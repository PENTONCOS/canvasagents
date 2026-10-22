// 画布节点更新的纯函数入口。
// updateMetadata 走的是「按 id 命中后才合并」这一条规则：需求便签、Markdown 等
// 多个同类节点并排时，改一条不能顺手把兄弟节点的 metadata 覆盖掉。
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

export function patchNodeMetadata(nodes: CanvasNodeData[], nodeId: string, patch: CanvasNodeMetadata): CanvasNodeData[] {
    return nodes.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...patch } } : node));
}
