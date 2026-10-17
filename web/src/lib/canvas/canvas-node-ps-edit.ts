// "Edit this image in PS" writes back to the *same* image node. This module holds the pure part of
// that write so it can be unit tested without a browser: the node keeps its id and its `image` type,
// the exported bitmap replaces the node content, and the PS save is appended to the node's edit
// history (see editor-bridge.buildEditorSavePatch) so the canvas timeline lists it as an event.
import { buildEditorSavePatch } from "@/lib/canvas/editor-bridge";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

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
