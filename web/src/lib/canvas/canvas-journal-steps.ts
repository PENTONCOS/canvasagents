// Canvas Journal "steps": the bridge between the append-only journal (lib/canvas/canvas-journal) and
// the undo/redo snapshot stacks in pages/canvas/project.tsx. Entries written by one history commit
// share a `commitId` and together form one "step"; the past/current/future stacks are projected into a
// single chronological timeline so a journal row can be resolved to "how many undos (or redos) land me
// on the state that step produced", or to "that state has already fallen out of the retained snapshot
// window". Everything here is pure and framework-free (no React, no DOM, no store), so bun:test can
// exercise the index/window math directly.

import type { CanvasJournalActor, CanvasJournalEntry, CanvasJournalTargets } from "@/types/canvas";

export type { CanvasJournalActor, CanvasJournalEntry } from "@/types/canvas";

// The operations list renders at most this many rows; the journal itself allows far more (see
// CANVAS_JOURNAL_LIMIT), so the panel bounds its work without lying about what was recorded.
export const CANVAS_JOURNAL_PANEL_LIMIT = 300;

// A patch summary shows at most this many lines; the panel labels the rest as truncated.
export const CANVAS_JOURNAL_PATCH_LINE_LIMIT = 24;

// Defaults for flattenJournalPatch: how deep to walk a patch, and how long a string may be before it
// is reported as a redacted reference instead of being rendered.
const PATCH_MAX_DEPTH = 4;
const PATCH_MAX_VALUE_LEN = 120;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compareStrings(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

// Turns a positive, finite count into an integer; anything else (NaN, Infinity, zero, negatives, a
// string, undefined) falls back to the default. Unlike the journal limit, zero is not honoured: the
// panel always has a usable cap.
function normalizePositiveCount(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

// --- commit identity --------------------------------------------------------------------------

// The commit id a journal entry was stamped with, read from `meta.commitId`. Entries written before
// this runtime wiring existed (or by another producer) simply have none.
export function journalCommitId(entry: unknown): string | undefined {
    if (!isPlainObject(entry)) return undefined;
    return isPlainObject(entry.meta) ? optionalString(entry.meta.commitId) : undefined;
}

// Stamps `meta.commitId` on an entry without mutating it. An empty/blank id is a no-op, so a caller
// can never write a half-formed step marker; existing meta keys (e.g. `fields`) are preserved.
export function withJournalCommitId(entry: CanvasJournalEntry, commitId: string): CanvasJournalEntry {
    const id = optionalString(commitId);
    if (id === undefined) return entry;
    return { ...entry, meta: { ...entry.meta, commitId: id } };
}

// How many things an entry actually changed: the diff's own count when present, else the number of
// reported fields, else 1 (a single add/remove/rename has no count parameter).
export function journalEntryChangeCount(entry: CanvasJournalEntry): number {
    const raw = isPlainObject(entry.summary?.params) ? entry.summary.params.count : undefined;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
    const fields = isPlainObject(entry.meta) ? entry.meta.fields : undefined;
    if (Array.isArray(fields) && fields.length > 0) return fields.length;
    return 1;
}

// --- grouping entries into steps --------------------------------------------------------------

export type CanvasJournalCommit = {
    key: string; // commitId when present, else "entry:<id>" so a legacy entry is its own step
    commitId?: string;
    entries: CanvasJournalEntry[];
    at: number; // earliest timestamp in the step
    actor: CanvasJournalActor; // actor of the first entry
};

// Groups entries into steps, preserving the input order (oldest first by construction). Consecutive
// entries sharing a commitId merge into one step; an entry without a commitId becomes its own step so
// it is never silently fused with a neighbour's step.
export function groupJournalCommits(entries: readonly CanvasJournalEntry[] = []): CanvasJournalCommit[] {
    const commits: CanvasJournalCommit[] = [];
    let current: CanvasJournalCommit | null = null;
    for (const entry of entries) {
        const commitId = journalCommitId(entry);
        const key = commitId ?? `entry:${entry.id}`;
        if (current && current.key === key) {
            current.entries.push(entry);
            current.at = Math.min(current.at, entry.at);
            continue;
        }
        current = { key, commitId, entries: [entry], at: entry.at, actor: entry.actor };
        commits.push(current);
    }
    return commits;
}

// --- snapshot stacks -> one chronological timeline --------------------------------------------

// Minimal structural shape the stacks helpers need: a snapshot someone tagged with the commit that
// produced it. CanvasHistoryEntry satisfies this, and tests can build plain objects.
export type CanvasHistoryStackEntry = { commitId?: string };

export type CanvasHistoryStacks<T> = { past: T[]; future: T[]; current: T | null };

export type CanvasHistoryTimeline = {
    commitIds: Array<string | undefined>; // chronological, oldest first
    currentIndex: number; // index of the snapshot the canvas shows right now
};

// Projects the undo/redo stacks into a single oldest-first timeline: every committed snapshot in
// `past`, the live state, then the redoable snapshots in `future` (nearest first). `currentIndex`
// equals `past.length`, so a negative delta is "undo N", a positive delta is "redo N".
export function buildHistoryTimeline<T extends CanvasHistoryStackEntry>(stacks: CanvasHistoryStacks<T>): CanvasHistoryTimeline {
    const past = Array.isArray(stacks.past) ? stacks.past : [];
    const future = Array.isArray(stacks.future) ? stacks.future : [];
    const current = stacks.current ?? null;
    if (!current) return { commitIds: [], currentIndex: 0 };
    const chronological = [...past, current, ...[...future].reverse()];
    return { commitIds: chronological.map((entry) => entry.commitId), currentIndex: past.length };
}

export type CanvasJournalLocation = { status: "current"; index: number; steps: 0 } | { status: "undo"; index: number; steps: number } | { status: "redo"; index: number; steps: number } | { status: "out-of-window"; index: -1; steps: 0 };

// Where a journal step sits relative to the live canvas: already shown ("current"), reachable by
// undoing, reachable only by redoing (the user undid past it), or no longer reachable because its
// snapshot fell out of the retained window. An unknown/absent commit id is treated as unreachable —
// the UI must label it as a record only, never pretend it can be restored.
export function resolveJournalLocation(timeline: CanvasHistoryTimeline, commitId: string | undefined): CanvasJournalLocation {
    const id = optionalString(commitId);
    if (id === undefined) return { status: "out-of-window", index: -1, steps: 0 };
    const index = timeline.commitIds.findIndex((value) => value === id);
    if (index < 0) return { status: "out-of-window", index: -1, steps: 0 };
    const delta = index - timeline.currentIndex;
    if (delta === 0) return { status: "current", index, steps: 0 };
    return delta < 0 ? { status: "undo", index, steps: -delta } : { status: "redo", index, steps: delta };
}

export type CanvasHistoryJumpPlan = { direction: "current" | "undo" | "redo"; steps: number };

// Plain arithmetic behind a jump, kept separate so the UI can describe it ("undo 3 steps") without
// touching the stacks.
export function planHistoryJump(currentIndex: number, targetIndex: number): CanvasHistoryJumpPlan {
    const delta = Math.trunc(targetIndex) - Math.trunc(currentIndex);
    if (delta === 0) return { direction: "current", steps: 0 };
    return delta < 0 ? { direction: "undo", steps: -delta } : { direction: "redo", steps: delta };
}

// Returns the stacks that land on `targetIndex` of the timeline, honouring the exact push/pop order
// the undo/redo callbacks use: an undo moves the live state to the front of `future`, a redo moves
// redoable states back onto `past` in order. The inputs are never mutated. An unreachable target
// returns the input stacks unchanged (with fresh arrays) instead of throwing.
export function jumpHistoryStacks<T extends CanvasHistoryStackEntry>(stacks: CanvasHistoryStacks<T>, targetIndex: number): CanvasHistoryStacks<T> {
    const past = Array.isArray(stacks.past) ? [...stacks.past] : [];
    const future = Array.isArray(stacks.future) ? [...stacks.future] : [];
    const current = stacks.current ?? null;
    if (!current) return { past, future, current: null };
    const plan = planHistoryJump(past.length, targetIndex);
    if (plan.direction === "current") return { past, future, current };
    if (plan.direction === "undo") {
        if (plan.steps > past.length) return { past, future, current };
        // `removed` is oldest-first and we land on removed[0]; the states we stepped past go onto
        // `future` in LIFO order (nearest redo last), i.e. removed[1..] reversed. The previous
        // `removed.slice(0, removed.length - 1)` dropped the wrong element, so any N >= 2 undo
        // produced a `future` that could not redo back to the original order.
        const removed = past.slice(past.length - plan.steps);
        return { past: past.slice(0, past.length - plan.steps), future: [...future, current, ...removed.slice(1).reverse()], current: removed[0] };
    }
    if (plan.steps > future.length) return { past, future, current };
    const taken = future.slice(future.length - plan.steps).reverse();
    return { past: [...past, current, ...taken.slice(0, taken.length - 1)], future: future.slice(0, future.length - plan.steps), current: taken[taken.length - 1] };
}

// --- rendering helpers --------------------------------------------------------------------------

// Newest first (the shape an operations list wants), stable for equal entries, capped at `limit`.
// `hidden` is how many recorded rows the panel is not rendering.
export function orderJournalForPanel(entries: readonly CanvasJournalEntry[] = [], limit: number = CANVAS_JOURNAL_PANEL_LIMIT): { entries: CanvasJournalEntry[]; hidden: number } {
    const max = normalizePositiveCount(limit, CANVAS_JOURNAL_PANEL_LIMIT);
    const ordered = [...entries].sort((left, right) => right.seq - left.seq || right.at - left.at || compareStrings(left.id, right.id));
    return { entries: ordered.slice(0, max), hidden: Math.max(0, ordered.length - max) };
}

// i18n key for the actor badge. Unknown actors fall back to the user label rather than rendering a
// raw kind string.
export function journalActorLabelKey(actor: CanvasJournalActor | undefined): string {
    const kind = actor?.kind;
    if (kind === "agent") return "canvas.journal.actorAgent";
    if (kind === "system") return "canvas.journal.actorSystem";
    return "canvas.journal.actorUser";
}

export type CanvasJournalTargetView = {
    nodeIds: string[];
    edgeIds: string[];
    label: string;
};

// Human label for the object an entry touched: the node's current title when we still have the node,
// else its recorded title, else the raw id (honest fallback for a node that was deleted or renamed
// away), and "from -> to" for edges. `untitled` fills in for entries with no target at all (a
// project rename reads its own parameters).
export function resolveJournalTarget(entry: CanvasJournalEntry, nodeTitles: Record<string, string> = {}, untitled = ""): CanvasJournalTargetView {
    const targets: CanvasJournalTargets = isPlainObject(entry.targets) ? entry.targets : {};
    const nodeIds = Array.isArray(targets.nodeIds) ? [...targets.nodeIds] : [];
    const edgeIds = Array.isArray(targets.edgeIds) ? [...targets.edgeIds] : [];
    const params = isPlainObject(entry.summary?.params) ? entry.summary.params : {};

    if (nodeIds.length > 0) {
        const recordedTitle = nodeIds.length === 1 ? optionalString(params.title) : undefined;
        const labels = nodeIds.map((id) => optionalString(nodeTitles[id]) ?? recordedTitle ?? id);
        return { nodeIds, edgeIds, label: labels.join(", ") };
    }
    if (edgeIds.length > 0) {
        const from = optionalString(params.from);
        const to = optionalString(params.to);
        return { nodeIds, edgeIds, label: from !== undefined && to !== undefined ? `${from} → ${to}` : edgeIds.join(", ") };
    }
    const renamed = optionalString(params.to);
    return { nodeIds, edgeIds, label: renamed ?? untitled };
}

export type CanvasJournalPatchLine = {
    path: string;
    text?: string;
    ref?: { len: number };
};

type PatchWalkConfig = { maxDepth: number; maxLines: number; maxValueLen: number };

function isRefPlaceholder(value: unknown): value is { __ref: true; len?: number } {
    return isPlainObject(value) && value.__ref === true;
}

function refLength(value: { __ref: true; len?: number }): number {
    return typeof value.len === "number" && Number.isFinite(value.len) && value.len >= 0 ? Math.floor(value.len) : 0;
}

// Anything that is clearly one big payload rather than a readable value: the journal's own redaction
// markers already cover the diffed fields, and this keeps a stray blob out of the DOM either way.
function looksLikeBlob(value: string): boolean {
    return value.startsWith("data:") || value.startsWith("blob:");
}

function formatScalar(value: unknown, maxLen: number): { text: string } | { ref: { len: number } } {
    if (typeof value === "string") {
        if (looksLikeBlob(value) || value.length > maxLen) return { ref: { len: value.length } };
        return { text: value };
    }
    if (typeof value === "number" || typeof value === "boolean") return { text: String(value) };
    if (value === null) return { text: "null" };
    if (value === undefined) return { text: "undefined" };
    return { text: "?" };
}

// Walks one patch value, appending a line per leaf. Returns true once the line budget is exhausted so
// the caller can stop early and mark the summary as truncated.
function walkPatch(value: unknown, path: string, depth: number, config: PatchWalkConfig, out: CanvasJournalPatchLine[]): boolean {
    if (out.length >= config.maxLines) return true;
    if (isRefPlaceholder(value)) {
        out.push({ path, ref: { len: refLength(value) } });
        return false;
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            out.push({ path, text: "[]" });
            return false;
        }
        if (depth >= config.maxDepth) {
            out.push({ path, text: "[…]" });
            return false;
        }
        for (let index = 0; index < value.length; index += 1) {
            if (walkPatch(value[index], `${path}[${index}]`, depth + 1, config, out)) return true;
        }
        return false;
    }
    if (isPlainObject(value)) {
        const keys = Object.keys(value);
        if (keys.length === 0) {
            out.push({ path, text: "{}" });
            return false;
        }
        if (depth >= config.maxDepth) {
            out.push({ path, text: "{…}" });
            return false;
        }
        for (const key of keys) {
            if (walkPatch(value[key], path ? `${path}.${key}` : key, depth + 1, config, out)) return true;
        }
        return false;
    }
    const scalar = formatScalar(value, config.maxValueLen);
    out.push("ref" in scalar ? { path, ref: scalar.ref } : { path, text: scalar.text });
    return false;
}

// Flattens a journal patch (typically `{ before, after }`) into renderable path/value lines. Every
// redaction placeholder becomes a `ref` line the UI renders as "large object reference (N chars)" —
// a data URL is never turned into text — and long strings are treated the same way defensively. The
// walk is depth- and line-bounded; `truncated` says whether anything was left out.
export function flattenJournalPatch(patch: unknown, opts: { maxDepth?: number; maxLines?: number; maxValueLen?: number } = {}): { lines: CanvasJournalPatchLine[]; truncated: boolean } {
    const config: PatchWalkConfig = {
        maxDepth: normalizePositiveCount(opts.maxDepth, PATCH_MAX_DEPTH),
        maxLines: normalizePositiveCount(opts.maxLines, CANVAS_JOURNAL_PATCH_LINE_LIMIT),
        maxValueLen: normalizePositiveCount(opts.maxValueLen, PATCH_MAX_VALUE_LEN),
    };
    const lines: CanvasJournalPatchLine[] = [];
    const truncated = walkPatch(patch, "", 0, config, lines);
    return { lines, truncated };
}
