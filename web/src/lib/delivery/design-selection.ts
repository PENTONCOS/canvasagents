import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

// Design 节点靠 metadata.variantOf 归组：A 版节点是锚点（variantOf === 自身 id），B/C 指向锚点。
export function designGroupKey(node: CanvasNodeData) {
    return node.metadata?.variantOf || node.id;
}

/**
 * 把「选定某版设计」翻译成节点元数据操作：同组只保留目标节点 selected=true。
 * store 里的 DesignVariant 负责实体层「至多一版选中」，这里负责画布节点层的徽标回写，
 * 两者必须一起做，否则刷新后节点徽标和实体状态会对不上。
 */
export function buildDesignSelectionOps(nodes: CanvasNodeData[], targetNodeId: string): CanvasAgentOp[] {
    const target = nodes.find((node) => node.id === targetNodeId);
    if (!target || target.type !== CanvasNodeType.Design) return [];
    const key = designGroupKey(target);
    return nodes
        .filter((node) => node.type === CanvasNodeType.Design && designGroupKey(node) === key)
        .map((node) => ({ type: "update_node" as const, id: node.id, metadata: { selected: node.id === targetNodeId } }));
}
