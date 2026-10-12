import { create } from "zustand";

import type { CanvasNodeTypeId } from "@/types/canvas";

// M1 immersive redesign: cross-page "create a node" requests. The command palette
// (and future surfaces) request a node here; the canvas project page consumes the
// pending type via createNode and clears it.
type CommandStore = {
    pendingNodeType: CanvasNodeTypeId | null;
    requestNode: (type: CanvasNodeTypeId) => void;
    clearPendingNode: () => void;
};

export const useCommandStore = create<CommandStore>()((set) => ({
    pendingNodeType: null,
    requestNode: (type) => set({ pendingNodeType: type }),
    clearPendingNode: () => set({ pendingNodeType: null }),
}));
