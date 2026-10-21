// M6: pure helpers for edge semantics. DOM-free so the normalization and label rules can be
// unit tested directly (see tests/canvas-semantics.test.ts) and reused by the renderer and panel.
import type { CanvasConnection, CanvasEdgeContract, CanvasEdgeMetadata, CanvasEdgeType } from "@/types/canvas";

export const CANVAS_EDGE_TYPES: CanvasEdgeType[] = ["flow", "http", "depends-on", "event", "db", "derives", "specifies", "covers", "violates", "proves"];
export const DEFAULT_EDGE_TYPE: CanvasEdgeType = "flow";

// Visual identity per edge type: flow solid slate, http blue, depends-on gray dashed, event
// purple, db orange. `dash` is an SVG stroke-dasharray value; undefined means a solid stroke.
export const EDGE_STYLE: Record<CanvasEdgeType, { color: string; dash?: string }> = {
    flow: { color: "#64748b" },
    http: { color: "#3b82f6" },
    "depends-on": { color: "#94a3b8", dash: "6 4" },
    event: { color: "#a855f7" },
    db: { color: "#f97316" },
    // M0: delivery domain semantics
    derives: { color: "#0ea5e9", dash: "2 3" },
    specifies: { color: "#8b5cf6", dash: "2 3" },
    covers: { color: "#22c55e", dash: "2 3" },
    violates: { color: "#ef4444", dash: "4 3" },
    proves: { color: "#eab308", dash: "2 3" },
};

// Drops unknown or stale edge types (hand-edited canvases) instead of crashing the renderer.
export function normalizeEdgeType(value: unknown): CanvasEdgeType {
    return typeof value === "string" && (CANVAS_EDGE_TYPES as string[]).includes(value) ? (value as CanvasEdgeType) : DEFAULT_EDGE_TYPE;
}

export function edgeStyle(type: unknown): { color: string; dash?: string } {
    return EDGE_STYLE[normalizeEdgeType(type)];
}

export function edgeTypeLabelKey(type: unknown): string {
    return `canvas.edge.types.${normalizeEdgeType(type)}`;
}

// Normalized contract with every field present as a trimmed string.
export type EdgeContract = { method: string; path: string; request: string; response: string; notes: string };

// Normalized edge state read from a connection; never undefined so the panel can bind directly.
export type EdgeView = { type: CanvasEdgeType; label: string; contract: EdgeContract };

function normalizeText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

export function readEdgeContract(contract?: CanvasEdgeContract | null): EdgeContract {
    return {
        method: normalizeText(contract?.method),
        path: normalizeText(contract?.path),
        request: normalizeText(contract?.request),
        response: normalizeText(contract?.response),
        notes: normalizeText(contract?.notes),
    };
}

export function readEdgeConnection(connection?: Pick<CanvasConnection, "type" | "label" | "metadata"> | null): EdgeView {
    return {
        type: normalizeEdgeType(connection?.type),
        label: normalizeText(connection?.label),
        contract: readEdgeContract(connection?.metadata?.contract),
    };
}

// Builds the metadata/label portion written back through the canvas state or an agent op.
// Empty strings collapse to undefined so serialized canvases stay clean.
export function edgeConnectionPatch(view: EdgeView): Pick<CanvasConnection, "type" | "label" | "metadata"> {
    const contract: CanvasEdgeContract = {
        method: view.contract.method || undefined,
        path: view.contract.path || undefined,
        request: view.contract.request || undefined,
        response: view.contract.response || undefined,
        notes: view.contract.notes || undefined,
    };
    const hasContract = Object.values(contract).some((value) => value !== undefined);
    return {
        type: normalizeEdgeType(view.type),
        label: view.label || undefined,
        metadata: hasContract ? { contract } : undefined,
    };
}

// Contract signature "METHOD path" (method uppercased), empty when either half is missing.
export function contractSignature(contract?: EdgeContract | CanvasEdgeContract | null): string {
    const method = normalizeText(contract?.method).toUpperCase();
    const path = normalizeText(contract?.path);
    if (!method || !path) return "";
    return `${method} ${path}`;
}

// Label rendered at the edge midpoint: an explicit label wins, otherwise the contract signature.
export function edgeDisplayLabel(connection?: Pick<CanvasConnection, "label" | "metadata"> | null): string {
    const label = normalizeText(connection?.label);
    if (label) return label;
    return contractSignature(connection?.metadata?.contract);
}
