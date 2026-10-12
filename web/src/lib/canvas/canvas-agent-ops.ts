import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { getNodeSpec, isRegisteredNodeType } from "@/lib/canvas/node-registry";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type CanvasNodeTimelineEntry, type CanvasNodeTypeId, type ViewportTransform } from "@/types/canvas";

export type CanvasAgentOp =
    | { type: "add_node"; id?: string; nodeType?: CanvasNodeTypeId; title?: string; position?: { x: number; y: number }; x?: number; y?: number; width?: number; height?: number; metadata?: CanvasNodeMetadata }
    | { type: "update_node"; id: string; patch?: Partial<CanvasNodeData>; metadata?: CanvasNodeMetadata }
    | { type: "delete_node"; id?: string; ids?: string[]; nodeType?: CanvasNodeTypeId }
    | { type: "delete_connections"; id?: string; ids?: string[]; all?: boolean }
    | { type: "connect_nodes"; id?: string; fromNodeId: string; toNodeId: string }
    | { type: "set_viewport"; viewport: ViewportTransform }
    | { type: "select_nodes"; ids: string[] }
    | { type: "run_generation"; nodeId: string; mode?: "text" | "image" | "video" | "audio"; prompt?: string };

export type CanvasAgentSnapshot = {
    projectId: string;
    title: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds: string[];
    viewport: ViewportTransform;
};

export function summarizeCanvasAgentOps(ops?: CanvasAgentOp[]) {
    const counts = (Array.isArray(ops) ? ops : []).reduce<Record<string, number>>((acc, op) => {
        if (!op?.type) return acc;
        acc[op.type] = (acc[op.type] || 0) + 1;
        return acc;
    }, {});
    return Object.entries(counts)
        .map(([type, count]) => `${opLabel(type)} ${count}`)
        .join("，");
}

export function applyCanvasAgentOps(snapshot: CanvasAgentSnapshot, ops?: CanvasAgentOp[]) {
    let nodes = snapshot.nodes;
    let connections = snapshot.connections;
    let selectedNodeIds = snapshot.selectedNodeIds;
    let viewport = snapshot.viewport;

    (Array.isArray(ops) ? ops : []).forEach((op, index) => {
        if (!op?.type) return;
        if (op.type === "add_node") {
            const nodeType = op.nodeType && isRegisteredNodeType(op.nodeType) ? op.nodeType : CanvasNodeType.Text;
            const spec = getNodeSpec(nodeType);
            const node: CanvasNodeData = {
                id: op.id || `${nodeType}-${Date.now()}-${index}`,
                type: nodeType,
                title: op.title || spec.title,
                position: op.position || { x: op.x ?? index * 36, y: op.y ?? index * 36 },
                width: op.width || spec.width,
                height: op.height || spec.height,
                metadata: { ...spec.metadata, ...op.metadata },
            };
            nodes = [...nodes, node];
            selectedNodeIds = [node.id];
        }
        if (op.type === "update_node") {
            if (!op.id) return;
            nodes = nodes.map((node) => (node.id === op.id ? { ...node, ...op.patch, metadata: { ...node.metadata, ...op.patch?.metadata, ...op.metadata } } : node));
        }
        if (op.type === "delete_node") {
            const ids = new Set(op.ids || (op.id ? [op.id] : op.nodeType ? nodes.filter((node) => node.type === op.nodeType).map((node) => node.id) : []));
            nodes = nodes.filter((node) => !ids.has(node.id));
            connections = connections.filter((conn) => !ids.has(conn.fromNodeId) && !ids.has(conn.toNodeId));
            selectedNodeIds = selectedNodeIds.filter((id) => !ids.has(id));
        }
        if (op.type === "delete_connections") {
            const ids = new Set(op.ids || (op.id ? [op.id] : []));
            connections = op.all ? [] : connections.filter((conn) => !ids.has(conn.id));
        }
        if (op.type === "connect_nodes") {
            if (!op.fromNodeId || !op.toNodeId) return;
            const exists = connections.some((conn) => conn.fromNodeId === op.fromNodeId && conn.toNodeId === op.toNodeId);
            const hasNodes = nodes.some((node) => node.id === op.fromNodeId) && nodes.some((node) => node.id === op.toNodeId);
            if (!exists && hasNodes) connections = [...connections, { id: op.id || nanoid(), fromNodeId: op.fromNodeId, toNodeId: op.toNodeId }];
        }
        if (op.type === "set_viewport" && op.viewport) viewport = op.viewport;
        if (op.type === "select_nodes") selectedNodeIds = (op.ids || []).filter((id) => nodes.some((node) => node.id === id));
    });

    return { ...snapshot, nodes, connections, selectedNodeIds, viewport };
}

/** M3: derive per-node timeline entries from agent ops by diffing before/after snapshots. */
export function collectNodeTimeline(ops: CanvasAgentOp[], before: CanvasAgentSnapshot, after: CanvasAgentSnapshot) {
    const at = Date.now();
    const map = new Map<string, CanvasNodeTimelineEntry[]>();
    const add = (id: string | undefined, entry: CanvasNodeTimelineEntry) => {
        if (!id) return;
        const list = map.get(id) || [];
        list.push(entry);
        map.set(id, list);
    };
    const beforeIds = new Set(before.nodes.map((node) => node.id));
    const addedNodes = after.nodes.filter((node) =>!beforeIds.has(node.id));
    let addIndex = 0;
    (Array.isArray(ops)? ops: []).forEach((op) => {
        if (!op?.type) return;
        const entry: CanvasNodeTimelineEntry = { at, kind: op.type };
        if (op.type === "add_node") {
            const id = op.id || addedNodes[addIndex++]?.id;
            add(id, entry);
        } else if (op.type === "update_node") {
            add(op.id, entry);
        } else if (op.type === "connect_nodes") {
            add(op.fromNodeId, entry);
            add(op.toNodeId, entry);
        } else if (op.type === "delete_connections") {
            const ids = new Set(op.ids || (op.id? [op.id]: []));
            const removed = op.all? before.connections: before.connections.filter((conn) => ids.has(conn.id));
            removed.forEach((conn) => {
                add(conn.fromNodeId, entry);
                add(conn.toNodeId, entry);
            });
        } else if (op.type === "run_generation" && op.nodeId) {
            const prompt = op.prompt?.trim();
            add(op.nodeId, { ...entry, detail: prompt?.slice(0, 80) });
        }
        // delete_node targets disappear; set_viewport/select_nodes are not node-scoped.
    });
    return map;
}

function opLabel(type: string) {
    return i18n.t(`canvas.agentOps.${type}`, { defaultValue: type });
}
