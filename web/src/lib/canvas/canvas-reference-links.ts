import type { CanvasAgentOp } from "./canvas-agent-ops";

/** Connect the canvas references that started a generation to the nodes it just produced.
 *  References that no longer exist on the canvas are skipped, self-links are dropped,
 *  and duplicate links are collapsed so a repeated import cannot fan out the graph. */
export function referenceConnectionOps(referenceNodeIds: string[], targetNodeIds: string[], existingNodeIds: Iterable<string>): CanvasAgentOp[] {
    const existing = new Set(existingNodeIds);
    const targets = [...new Set(targetNodeIds.filter((id): id is string => Boolean(id)))];
    if (!targets.length) return [];
    return [...new Set(referenceNodeIds.filter((id): id is string => Boolean(id)))]
        .filter((id) => existing.has(id) && !targets.includes(id))
        .flatMap((fromNodeId) => targets.map((toNodeId): CanvasAgentOp => ({ type: "connect_nodes", fromNodeId, toNodeId })));
}
