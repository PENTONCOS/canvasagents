// Phase 3 follow-up: per-node edit history. Saving from the embedded PS-mode editor writes back to
// the very same image node (see editor-bridge.buildEditorSavePatch), and every one of those writes is
// logged on that node so the canvas timeline can show "this image went through PS" as an event next
// to the stage breakdown. Everything here is pure and DOM-free: the helpers never mutate their
// arguments, so bun:test can exercise them directly (see tests/canvas-node-history.test.ts).

import type { CanvasNodeEditKind, CanvasNodeEditRecord } from "@/types/canvas";

export type { CanvasNodeEditKind, CanvasNodeEditRecord } from "@/types/canvas";

// A node keeps at most this many records; appending past the cap drops the oldest entry first.
export const CANVAS_NODE_HISTORY_LIMIT = 50;

// Kinds the UI knows how to render (canvas.timeline.activity* keys). A record with any other kind is
// treated as dirty data and dropped by normalizeNodeEditRecord.
export const CANVAS_NODE_EDIT_KINDS: CanvasNodeEditKind[] = ["ps-edit", "region-edit"];

const EDIT_KIND_SET: ReadonlySet<string> = new Set<string>(CANVAS_NODE_EDIT_KINDS);

function isEditKind(value: unknown): value is CanvasNodeEditKind {
    return typeof value === "string" && EDIT_KIND_SET.has(value);
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Turns a non-negative, finite limit into an integer; anything else (NaN, Infinity, negatives, a
// string, undefined) falls back to the default cap. Zero is honoured and means "keep nothing".
export function normalizeNodeEditLimit(value: unknown, fallback: number = CANVAS_NODE_HISTORY_LIMIT): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
    return Math.floor(value);
}

// Rebuilds a single record from untrusted input: node metadata round-trips through JSON, the agent
// bridge, and plugins, so a record may be anything by the time we read it back. Returns null when the
// entry cannot be trusted: `at` must be a finite epoch ms and `kind` must be one the UI can render.
// Unknown extra keys are dropped, empty optional strings are omitted.
export function normalizeNodeEditRecord(value: unknown): CanvasNodeEditRecord | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (!isEditKind(candidate.kind)) return null;
    if (typeof candidate.at !== "number" || !Number.isFinite(candidate.at)) return null;
    const record: CanvasNodeEditRecord = { kind: candidate.kind, at: candidate.at };
    const engine = optionalString(candidate.engine);
    const version = optionalString(candidate.version);
    const summary = optionalString(candidate.summary);
    if (engine !== undefined) record.engine = engine;
    if (version !== undefined) record.version = version;
    if (summary !== undefined) record.summary = summary;
    return record;
}

// Keeps only the records we can render, preserving the source order (oldest first). A missing or
// non-array history yields an empty list, never a throw.
export function normalizeNodeHistory(value: unknown): CanvasNodeEditRecord[] {
    if (!Array.isArray(value)) return [];
    const records: CanvasNodeEditRecord[] = [];
    for (const entry of value) {
        const record = normalizeNodeEditRecord(entry);
        if (record) records.push(record);
    }
    return records;
}

// Appends one record (oldest first) and caps the result at `limit`, dropping the oldest entries
// first. The input array is never mutated: the caller gets a fresh array holding copies, so a store
// update that spreads the patch cannot alias the previous history.
export function appendNodeEdit(history: unknown, record: CanvasNodeEditRecord, limit: number = CANVAS_NODE_HISTORY_LIMIT): CanvasNodeEditRecord[] {
    const max = normalizeNodeEditLimit(limit, CANVAS_NODE_HISTORY_LIMIT);
    if (max <= 0) return [];
    const appended = [...normalizeNodeHistory(history), normalizeNodeEditRecord(record)].filter((entry): entry is CanvasNodeEditRecord => entry !== null);
    return appended.slice(Math.max(0, appended.length - max));
}
