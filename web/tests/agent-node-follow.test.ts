import { describe, expect, test } from "bun:test";

import { followBadge, followWindow, pruneFollowBindings, unfollowWindow } from "../src/lib/canvas/node-follow-window";
import { createAgentWindow, emptyAgentConversation } from "../src/lib/agent/agent-windows";
import type { CanvasNodeData } from "../src/types/canvas";

function node(id: string): CanvasNodeData {
    return { id, type: "image" as CanvasNodeData["type"], position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, metadata: {} } as unknown as CanvasNodeData;
}

describe("node-follow-window", () => {
    test("followWindow 写入 followWindowId 且不影响其他节点", () => {
        const nodes = [node("a"), node("b")];
        const next = followWindow(nodes, "a", "w1");
        expect(next[0].metadata?.followWindowId).toBe("w1");
        expect(next[1].metadata?.followWindowId).toBeUndefined();
        expect(nodes[0].metadata?.followWindowId).toBeUndefined();
    });

    test("unfollowWindow 清除绑定", () => {
        const next = unfollowWindow(followWindow([node("a")], "a", "w1"), "a");
        expect(next[0].metadata?.followWindowId).toBeUndefined();
    });

    test("unfollowWindow 对未绑定节点是 no-op", () => {
        const nodes = [node("a")];
        expect(unfollowWindow(nodes, "a")).toEqual(nodes);
    });

    test("pruneFollowBindings 清理悬空绑定，保留有效绑定", () => {
        const nodes = followWindow(followWindow([node("a"), node("b"), node("c")], "a", "w1"), "b", "gone");
        const next = pruneFollowBindings(nodes, new Set(["w1"]));
        expect(next[0].metadata?.followWindowId).toBe("w1");
        expect(next[1].metadata?.followWindowId).toBeUndefined();
        expect(next[2].metadata?.followWindowId).toBeUndefined();
    });

    test("followBadge 返回 1-based 序号与标题", () => {
        const win = createAgentWindow({ id: "w1", title: "landingpage 改版", conversation: emptyAgentConversation() });
        const nodes = followWindow([node("a")], "a", "w1");
        expect(followBadge(nodes, "a", [win])).toEqual({ index: 1, title: "landingpage 改版" });
        expect(followBadge(nodes, "a", [])).toBeNull();
        expect(followBadge(nodes, "missing", [win])).toBeNull();
    });
});
