// M2: node-follows-agent-window binding. Pure helpers + tests in tests/agent-node-follow.test.ts
import type { CanvasNodeData } from "@/types/canvas";
import type { AgentWindow } from "@/lib/agent/agent-windows";

/** 给节点绑定要跟随的 agent window。 */
export function followWindow(nodes: CanvasNodeData[], nodeId: string, windowId: string): CanvasNodeData[] {
    return nodes.map((n) => (n.id === nodeId ? { ...n, metadata: { ...n.metadata, followWindowId: windowId } } : n));
}

/** 解除节点跟随。 */
export function unfollowWindow(nodes: CanvasNodeData[], nodeId: string): CanvasNodeData[] {
    return nodes.map((n) => {
        if (n.id !== nodeId || !n.metadata?.followWindowId) return n;
        const { followWindowId: _dropped, ...rest } = n.metadata;
        return { ...n, metadata: rest };
    });
}

/** window 关闭/不存在时清理所有悬空绑定。 */
export function pruneFollowBindings(nodes: CanvasNodeData[], validWindowIds: Set<string>): CanvasNodeData[] {
    return nodes.map((n) => {
        const id = n.metadata?.followWindowId;
        if (!id || validWindowIds.has(id)) return n;
        const { followWindowId: _dropped, ...rest } = n.metadata!;
        return { ...n, metadata: rest };
    });
}

/** 节点跟随徽标信息：window 存在时给序号 + 标题。 */
export function followBadge(nodes: CanvasNodeData[], nodeId: string, windows: AgentWindow[]): { index: number; title: string } | null {
    const id = nodes.find((n) => n.id === nodeId)?.metadata?.followWindowId;
    if (!id) return null;
    const index = windows.findIndex((w) => w.id === id);
    if (index < 0) return null;
    return { index: index + 1, title: windows[index].title };
}
