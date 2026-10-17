// "Edit this image in PS" writes back to the *same* image node. This module holds the pure part of
// that write so it can be unit tested without a browser: the node keeps its id and its `image` type,
// the exported bitmap replaces the node content, and the PS save is appended to the node's edit
// history (see editor-bridge.buildEditorSavePatch) so the canvas timeline lists it as an event.
import { EDITOR_ENGINE_NAME, EDITOR_ENGINE_VERSION, buildEditorSavePatch } from "@/lib/canvas/editor-bridge";
import type { CanvasNodeData, CanvasNodeMetadata, Position } from "@/types/canvas";

// Merges an editor save into the node metadata: the artifact (content) plus the PS history entry,
// then — when the caller refreshed the stored bitmap — the fresh storage handle and dimensions, so
// the node renders the edited pixels instead of the stale pre-edit preview thumbnail.
// Batch image nodes render their primary entry, so the same write is mirrored there.
export function buildPsEditMetadata(metadata: CanvasNodeMetadata | undefined, dataUrl: string, savedAt: number, fresh?: CanvasNodeMetadata): CanvasNodeMetadata {
    const patch = buildEditorSavePatch(metadata, dataUrl, savedAt);
    const merged: CanvasNodeMetadata = { ...metadata, ...patch, ...(fresh || {}) };
    const images = metadata?.images;
    if (Array.isArray(images) && images.length > 0) {
        const primaryId = metadata?.primaryImageId || images[0]?.id;
        const source = fresh?.content ? fresh : patch;
        merged.images = images.map((image) =>
            image.id === primaryId
                ? {
                      ...image,
                      content: source.content ?? image.content,
                      storageKey: source.storageKey ?? image.storageKey,
                      naturalWidth: source.naturalWidth ?? image.naturalWidth,
                      naturalHeight: source.naturalHeight ?? image.naturalHeight,
                      bytes: source.bytes ?? image.bytes,
                      mimeType: source.mimeType ?? image.mimeType,
                  }
                : image,
        );
    }
    return merged;
}

// Applies a PS-edit save to the node list without creating a node: the edited image lands on the same
// node id, the node type is left untouched, and the input array is never mutated.
export function applyPsEditSave(nodes: CanvasNodeData[], nodeId: string, dataUrl: string, savedAt: number, fresh?: CanvasNodeMetadata): CanvasNodeData[] {
    return nodes.map((node) => (node.id === nodeId ? { ...node, metadata: buildPsEditMetadata(node.metadata, dataUrl, savedAt, fresh) } : node));
}

// World-space gap between the node the editor was opened from and the copy made by "save as a new
// node", so the pair reads as before/after instead of stacking on top of each other.
export const PS_SAVE_AS_NODE_GAP_PX = 48;

// Where the copy lands: immediately to the right of its source, on the same row. Pure geometry so it
// can be unit tested without a canvas.
export function psSaveAsNodePosition(node: Pick<CanvasNodeData, "position" | "width">): Position {
    return { x: node.position.x + node.width + PS_SAVE_AS_NODE_GAP_PX, y: node.position.y };
}

// Metadata for the copy. The caller stores the exported bitmap first (fresh storage handle +
// dimensions), so the new node references a real artifact instead of an inline data URL; the PS
// engine stamp is what tells the timeline where those pixels came from. The source node is untouched.
export function buildPsSaveAsNodeMetadata(fresh: CanvasNodeMetadata, savedAt: number): CanvasNodeMetadata {
    return { ...fresh, editor: { engine: EDITOR_ENGINE_NAME, version: EDITOR_ENGINE_VERSION, lastSavedAt: savedAt } };
}
