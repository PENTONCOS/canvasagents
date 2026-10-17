// Canvas Journal: the traceable "what changed and who did it" base layer. A pair of canvas
// snapshots (same field set as the undo/redo entry built by pages/canvas/project.tsx) is diffed into
// human-readable operation entries, stored append-only, and later rendered as an "operations" list
// with "jump back to a step" plus assistant turns/tool calls flowing into the same stream.
//
// Everything here is pure and framework-free: no React, no DOM, no store access. The diff never
// mutates its arguments, ordering is deterministic (same input -> byte-identical output), and large
// values (image data URLs in particular) are replaced by compact `{ __ref, len, sha }` placeholders
// so a patch/meta can never inline a full data URL. Entries carry i18n keys, never literal text.

import { nanoid } from "nanoid";

import type { CanvasConnection, CanvasJournalActor, CanvasJournalActorKind, CanvasJournalEntry, CanvasJournalKind, CanvasJournalSummary, CanvasJournalTargets, CanvasNodeData } from "@/types/canvas";

export type { CanvasJournalActor, CanvasJournalEntry, CanvasJournalKind } from "@/types/canvas";

// An append-only journal keeps at most this many entries; appending past the cap drops the oldest.
export const CANVAS_JOURNAL_LIMIT = 2000;

// Every kind the diff can emit and normalize can accept. A stored entry with any other kind is
// treated as dirty data and dropped by normalizeJournalEntry.
export const CANVAS_JOURNAL_KINDS: CanvasJournalKind[] = ["node.add", "node.remove", "node.update", "node.move", "node.resize", "node.content", "node.image-edit", "edge.add", "edge.remove", "edge.update", "project.rename", "agent.turn", "agent.tool"];

const JOURNAL_KIND_SET: ReadonlySet<string> = new Set<string>(CANVAS_JOURNAL_KINDS);

const ACTOR_KIND_SET: ReadonlySet<string> = new Set<string>(["user", "agent", "system"]);

// i18n key per kind (see i18n/locales/*.ts under canvas.journal). Kept as a total record so adding a
// kind without a key fails type-checking.
const KIND_SUMMARY_KEYS: Record<CanvasJournalKind, string> = {
    "node.add": "canvas.journal.nodeAdd",
    "node.remove": "canvas.journal.nodeRemove",
    "node.update": "canvas.journal.nodeUpdate",
    "node.move": "canvas.journal.nodeMove",
    "node.resize": "canvas.journal.nodeResize",
    "node.content": "canvas.journal.nodeContent",
    "node.image-edit": "canvas.journal.nodeImageEdit",
    "edge.add": "canvas.journal.edgeAdd",
    "edge.remove": "canvas.journal.edgeRemove",
    "edge.update": "canvas.journal.edgeUpdate",
    "project.rename": "canvas.journal.projectRename",
    "agent.turn": "canvas.journal.agentTurn",
    "agent.tool": "canvas.journal.agentTool",
};

// When several fields of one node change in the same batch, one merged entry is emitted whose kind is
// the first match in this list. Order is fixed (not alphabetical): the most specific/meaningful
// change wins, and `edge.update`-style generic fallbacks come last.
const NODE_KIND_PRIORITY: CanvasJournalKind[] = ["node.image-edit", "node.content", "node.resize", "node.move", "node.update"];

// metadata keys that have a dedicated kind; everything else folds into the generic node.update.
const NODE_METADATA_SPECIAL_KEYS: ReadonlySet<string> = new Set<string>(["content", "editor", "history"]);

const DEFAULT_REDACT_MAX_LEN = 2000;
const MAX_LIMIT = Number.MAX_SAFE_INTEGER;

// Structural snapshot: any object carrying the fields the undo/redo entry carries. Only `nodes`,
// `connections` and `title` are diffed here; unknown fields are ignored. CanvasHistoryEntry (and
// CanvasProject) satisfy this shape, and tests can build plain objects.
export type CanvasJournalSnapshot = {
    nodes?: CanvasNodeData[];
    connections?: CanvasConnection[];
    title?: string;
};

export type CanvasJournalDiffOptions = {
    now?: () => number; // epoch ms source; called once per diff so a batch shares one timestamp
    makeId?: () => string; // id source, called once per emitted entry
    seqStart?: number; // seq of the first entry (default 0)
};

// Standalone shape used before seq/id/at are stamped.
type CanvasJournalSpec = {
    kind: CanvasJournalKind;
    targets: CanvasJournalTargets;
    summary: CanvasJournalSummary;
    patch?: unknown;
    meta?: Record<string, unknown>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
    return isPlainObject(value) ? value : {};
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compareIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

// --- deep equality (order-insensitive for object keys, exact for arrays) ------------------------

function deepEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
        return left.every((item, index) => deepEqual(item, right[index]));
    }
    if (isPlainObject(left) && isPlainObject(right)) {
        const leftKeys = Object.keys(left);
        const rightKeys = Object.keys(right);
        if (leftKeys.length !== rightKeys.length) return false;
        return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]));
    }
    return false;
}

// --- redaction --------------------------------------------------------------------------------

// Short, dependency-free FNV-1a (32-bit) hash rendered as 8 lowercase hex chars. Used only as a
// stable fingerprint inside redaction placeholders, never as a security digest.
function fnv1a32(input: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

function normalizeRedactLimit(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function redactValue(value: unknown, limit: number, seen: Set<object>): unknown {
    if (typeof value === "string") return value.length > limit ? { __ref: true, len: value.length, sha: fnv1a32(value) } : value;
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    let clone: unknown;
    if (Array.isArray(value)) clone = value.map((item) => redactValue(item, limit, seen));
    else {
        const result: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) result[key] = redactValue(child, limit, seen);
        clone = result;
    }
    seen.delete(value);
    return clone;
}

// Recursively replaces every string longer than `maxLen` with a compact `{ __ref: true, len, sha }`
// placeholder, so patch/meta never inline a full image data URL. Non-plain values (numbers,
// booleans, null) pass through untouched; a shared reference is only collapsed when it is part of a
// genuine cycle. The input is never mutated.
export function redactLargeValues(value: unknown, maxLen: number = DEFAULT_REDACT_MAX_LEN): unknown {
    return redactValue(value, normalizeRedactLimit(maxLen, DEFAULT_REDACT_MAX_LEN), new Set<object>());
}

// --- node / edge field diffing -----------------------------------------------------------------

// Concrete fields that changed on one node, in a fixed order.
function diffNodeFields(prevNode: CanvasNodeData, nextNode: CanvasNodeData): string[] {
    const fields: string[] = [];
    if (prevNode.title !== nextNode.title) fields.push("title");
    if (prevNode.type !== nextNode.type) fields.push("type");
    if (!deepEqual(prevNode.position, nextNode.position)) fields.push("position");
    if (prevNode.width !== nextNode.width) fields.push("width");
    if (prevNode.height !== nextNode.height) fields.push("height");
    const prevMeta = asRecord(prevNode.metadata);
    const nextMeta = asRecord(nextNode.metadata);
    if (!deepEqual(prevMeta.content, nextMeta.content)) fields.push("content");
    if (!deepEqual(prevMeta.editor, nextMeta.editor)) fields.push("editor");
    if (!deepEqual(prevMeta.history, nextMeta.history)) fields.push("history");
    if (diffMetadataKeys(prevMeta, nextMeta)) fields.push("metadata");
    return fields;
}

// True when metadata differs in a key outside the specially handled ones.
function diffMetadataKeys(prevMeta: Record<string, unknown>, nextMeta: Record<string, unknown>): boolean {
    const keys = new Set<string>([...Object.keys(prevMeta), ...Object.keys(nextMeta)]);
    for (const key of keys) {
        if (NODE_METADATA_SPECIAL_KEYS.has(key)) continue;
        if (!deepEqual(prevMeta[key], nextMeta[key])) return true;
    }
    return false;
}

function nodeKinds(fields: string[]): CanvasJournalKind[] {
    const kinds = new Set<CanvasJournalKind>();
    if (fields.includes("content")) kinds.add("node.content");
    if (fields.includes("editor") || fields.includes("history")) kinds.add("node.image-edit");
    if (fields.includes("width") || fields.includes("height")) kinds.add("node.resize");
    if (fields.includes("position")) kinds.add("node.move");
    if (fields.includes("title") || fields.includes("type") || fields.includes("metadata")) kinds.add("node.update");
    return NODE_KIND_PRIORITY.filter((kind) => kinds.has(kind));
}

function diffEdgeFields(prevEdge: CanvasConnection, nextEdge: CanvasConnection): string[] {
    const fields: string[] = [];
    if (prevEdge.fromNodeId !== nextEdge.fromNodeId) fields.push("fromNodeId");
    if (prevEdge.toNodeId !== nextEdge.toNodeId) fields.push("toNodeId");
    if (prevEdge.type !== nextEdge.type) fields.push("type");
    if (prevEdge.label !== nextEdge.label) fields.push("label");
    if (!deepEqual(prevEdge.metadata, nextEdge.metadata)) fields.push("metadata");
    return fields;
}

// --- snapshot diff ----------------------------------------------------------------------------

function nodeSpec(kind: CanvasJournalKind, node: CanvasNodeData, fields: string[], patch: unknown, extraParams: Record<string, string | number> = {}): CanvasJournalSpec {
    return {
        kind,
        targets: { nodeIds: [node.id] },
        summary: { key: KIND_SUMMARY_KEYS[kind], params: { title: node.title, ...extraParams } },
        patch,
        meta: { fields },
    };
}

// Diffs two snapshots into ordered journal entries. Output order is fixed: project.rename first, then
// nodes (add, remove, update) and edges (add, remove, update), each group sorted by id ascending, so
// identical input always yields identical output.
export function diffCanvasSnapshots(prev: CanvasJournalSnapshot | null | undefined, next: CanvasJournalSnapshot | null | undefined, actor: CanvasJournalActor = { kind: "system" }, opts: CanvasJournalDiffOptions = {}): CanvasJournalEntry[] {
    const now = typeof opts.now === "function" ? opts.now : () => Date.now();
    const makeId = typeof opts.makeId === "function" ? opts.makeId : () => nanoid();
    const seqStart = typeof opts.seqStart === "number" && Number.isFinite(opts.seqStart) ? Math.floor(opts.seqStart) : 0;
    const at = now();

    const specs: CanvasJournalSpec[] = [];

    if (typeof prev?.title === "string" && typeof next?.title === "string" && prev.title !== next.title) {
        specs.push({ kind: "project.rename", targets: {}, summary: { key: KIND_SUMMARY_KEYS["project.rename"], params: { from: prev.title, to: next.title } } });
    }

    const prevNodes = Array.isArray(prev?.nodes) ? prev.nodes : [];
    const nextNodes = Array.isArray(next?.nodes) ? next.nodes : [];
    specs.push(...diffNodes(prevNodes, nextNodes));
    specs.push(...diffEdges(Array.isArray(prev?.connections) ? prev.connections : [], Array.isArray(next?.connections) ? next.connections : []));

    return specs.map((spec, index) => {
        const entry: CanvasJournalEntry = { seq: seqStart + index, id: makeId(), at, actor, kind: spec.kind, targets: spec.targets, summary: spec.summary };
        if (spec.patch !== undefined) entry.patch = spec.patch;
        if (spec.meta !== undefined) entry.meta = spec.meta;
        return entry;
    });
}

function indexNodes(nodes: CanvasNodeData[]): Map<string, CanvasNodeData> {
    const map = new Map<string, CanvasNodeData>();
    for (const node of nodes) if (isPlainObject(node) && typeof node.id === "string" && node.id) map.set(node.id, node);
    return map;
}

function diffNodes(prevNodes: CanvasNodeData[], nextNodes: CanvasNodeData[]): CanvasJournalSpec[] {
    const prevMap = indexNodes(prevNodes);
    const nextMap = indexNodes(nextNodes);

    const added = [...nextMap.keys()].filter((id) => !prevMap.has(id)).sort(compareIds);
    const removed = [...prevMap.keys()].filter((id) => !nextMap.has(id)).sort(compareIds);
    const common = [...prevMap.keys()].filter((id) => nextMap.has(id)).sort(compareIds);

    const specs: CanvasJournalSpec[] = [];
    for (const id of added) {
        const node = nextMap.get(id) as CanvasNodeData;
        specs.push(nodeSpec("node.add", node, ["added"], { after: redactLargeValues(node) }, { count: 1 }));
    }
    for (const id of removed) {
        const node = prevMap.get(id) as CanvasNodeData;
        specs.push(nodeSpec("node.remove", node, ["removed"], { before: redactLargeValues(node) }, { count: 1 }));
    }
    for (const id of common) {
        const prevNode = prevMap.get(id) as CanvasNodeData;
        const nextNode = nextMap.get(id) as CanvasNodeData;
        const fields = diffNodeFields(prevNode, nextNode);
        if (fields.length === 0) continue;
        const kinds = nodeKinds(fields);
        const kind = kinds[0] ?? "node.update";
        specs.push(nodeSpec(kind, nextNode, fields, { before: redactLargeValues(prevNode), after: redactLargeValues(nextNode) }, { count: fields.length }));
    }
    return specs;
}

function indexEdges(edges: CanvasConnection[]): Map<string, CanvasConnection> {
    const map = new Map<string, CanvasConnection>();
    for (const edge of edges) if (isPlainObject(edge) && typeof edge.id === "string" && edge.id) map.set(edge.id, edge);
    return map;
}

function edgeSpec(kind: CanvasJournalKind, params: Record<string, string | number>, patch: unknown, fields: string[]): CanvasJournalSpec {
    return { kind, targets: {}, summary: { key: KIND_SUMMARY_KEYS[kind], params }, patch, meta: { fields } };
}

function diffEdges(prevEdges: CanvasConnection[], nextEdges: CanvasConnection[]): CanvasJournalSpec[] {
    const prevMap = indexEdges(prevEdges);
    const nextMap = indexEdges(nextEdges);

    const added = [...nextMap.keys()].filter((id) => !prevMap.has(id)).sort(compareIds);
    const removed = [...prevMap.keys()].filter((id) => !nextMap.has(id)).sort(compareIds);
    const common = [...prevMap.keys()].filter((id) => nextMap.has(id)).sort(compareIds);

    const specs: CanvasJournalSpec[] = [];
    for (const id of added) {
        const edge = nextMap.get(id) as CanvasConnection;
        const spec = edgeSpec("edge.add", { from: edge.fromNodeId, to: edge.toNodeId }, { after: redactLargeValues(edge) }, ["added"]);
        spec.targets = { edgeIds: [id] };
        specs.push(spec);
    }
    for (const id of removed) {
        const edge = prevMap.get(id) as CanvasConnection;
        const spec = edgeSpec("edge.remove", { from: edge.fromNodeId, to: edge.toNodeId }, { before: redactLargeValues(edge) }, ["removed"]);
        spec.targets = { edgeIds: [id] };
        specs.push(spec);
    }
    for (const id of common) {
        const prevEdge = prevMap.get(id) as CanvasConnection;
        const nextEdge = nextMap.get(id) as CanvasConnection;
        const fields = diffEdgeFields(prevEdge, nextEdge);
        if (fields.length === 0) continue;
        const spec = edgeSpec("edge.update", { count: fields.length }, { before: redactLargeValues(prevEdge), after: redactLargeValues(nextEdge) }, fields);
        spec.targets = { edgeIds: [id] };
        specs.push(spec);
    }
    return specs;
}

// --- storage helpers --------------------------------------------------------------------------

// Turns a non-negative, finite limit into an integer; anything else (NaN, Infinity, negatives, a
// string, undefined) falls back to the default cap. Zero is honoured and means "keep nothing".
export function normalizeJournalLimit(value: unknown, fallback: number = CANVAS_JOURNAL_LIMIT): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
    return Math.floor(value);
}

// Rebuilds a single entry from untrusted input (the journal round-trips through localForage, the
// agent bridge, and plugins). Returns null when the entry cannot be trusted or rendered: `kind` must
// be known, `at` must be a finite epoch ms, and `summary.key` must be a non-empty i18n key.
// Recoverable gaps are filled (`actor` defaults to system, `seq` to 0, `id` to "<kind>-<at>"); empty
// optional strings are omitted and unknown extra keys are dropped.
export function normalizeJournalEntry(value: unknown): CanvasJournalEntry | null {
    if (!isPlainObject(value)) return null;
    if (typeof value.kind !== "string" || !JOURNAL_KIND_SET.has(value.kind)) return null;
    if (typeof value.at !== "number" || !Number.isFinite(value.at)) return null;
    const summary = normalizeJournalSummary(value.summary);
    if (!summary) return null;

    const kind = value.kind as CanvasJournalKind;
    const entry: CanvasJournalEntry = {
        seq: typeof value.seq === "number" && Number.isFinite(value.seq) ? Math.floor(value.seq) : 0,
        id: optionalString(value.id) ?? `${kind}-${value.at}`,
        at: value.at,
        actor: normalizeJournalActor(value.actor),
        kind,
        targets: normalizeJournalTargets(value.targets),
        summary,
    };
    if (value.patch !== undefined) entry.patch = value.patch;
    if (isPlainObject(value.meta)) entry.meta = value.meta;
    return entry;
}

export function normalizeJournalActor(value: unknown): CanvasJournalActor {
    if (!isPlainObject(value)) return { kind: "system" };
    const kind = typeof value.kind === "string" && ACTOR_KIND_SET.has(value.kind) ? (value.kind as CanvasJournalActorKind) : "system";
    const actor: CanvasJournalActor = { kind };
    const id = optionalString(value.id);
    const name = optionalString(value.name);
    if (id !== undefined) actor.id = id;
    if (name !== undefined) actor.name = name;
    return actor;
}

function normalizeJournalSummary(value: unknown): CanvasJournalSummary | null {
    if (!isPlainObject(value)) return null;
    const key = optionalString(value.key);
    if (key === undefined) return null;
    const summary: CanvasJournalSummary = { key };
    const params = normalizeJournalParams(value.params);
    if (params !== undefined) summary.params = params;
    return summary;
}

// Keeps only renderable params (finite numbers and strings); drops everything else, and omits the
// field entirely when nothing survives.
function normalizeJournalParams(value: unknown): Record<string, string | number> | undefined {
    if (!isPlainObject(value)) return undefined;
    const params: Record<string, string | number> = {};
    for (const [key, child] of Object.entries(value)) {
        if (typeof child === "string") params[key] = child;
        else if (typeof child === "number" && Number.isFinite(child)) params[key] = child;
    }
    return Object.keys(params).length > 0 ? params : undefined;
}

function normalizeJournalTargets(value: unknown): CanvasJournalTargets {
    const targets: CanvasJournalTargets = {};
    if (!isPlainObject(value)) return targets;
    const nodeIds = normalizeIdList(value.nodeIds);
    const edgeIds = normalizeIdList(value.edgeIds);
    if (nodeIds.length > 0) targets.nodeIds = nodeIds;
    if (edgeIds.length > 0) targets.edgeIds = edgeIds;
    return targets;
}

function normalizeIdList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const ids: string[] = [];
    for (const item of value) if (typeof item === "string" && item.length > 0 && !ids.includes(item)) ids.push(item);
    return ids;
}

// Keeps only the entries we can render, oldest first, and caps the result at `limit` (dropping the
// oldest first). A missing or non-array journal yields an empty list, never a throw.
export function normalizeJournal(value: unknown, limit: number = CANVAS_JOURNAL_LIMIT): CanvasJournalEntry[] {
    if (!Array.isArray(value)) return [];
    const max = normalizeJournalLimit(limit, CANVAS_JOURNAL_LIMIT);
    if (max <= 0) return [];
    const entries: CanvasJournalEntry[] = [];
    for (const item of value) {
        const entry = normalizeJournalEntry(item);
        if (entry) entries.push(entry);
    }
    return entries.length > max ? entries.slice(entries.length - max) : entries;
}

// Appends one entry (oldest first) and caps the result at `limit`, dropping the oldest entries first.
// The input array is never mutated, and the returned array holds freshly rebuilt copies, so a store
// update that spreads the patch cannot alias the previous journal. `dropped` is how many entries fell
// off the front to satisfy the cap.
export function appendJournalEntry(entries: unknown, entry: unknown, limit: number = CANVAS_JOURNAL_LIMIT): { entries: CanvasJournalEntry[]; dropped: number } {
    const max = normalizeJournalLimit(limit, CANVAS_JOURNAL_LIMIT);
    const base = normalizeJournal(entries, MAX_LIMIT);
    const appended = normalizeJournalEntry(entry);
    const combined = appended ? [...base, appended] : base;
    if (max <= 0) return { entries: [], dropped: combined.length };
    const dropped = Math.max(0, combined.length - max);
    return { entries: dropped > 0 ? combined.slice(dropped) : combined, dropped };
}
