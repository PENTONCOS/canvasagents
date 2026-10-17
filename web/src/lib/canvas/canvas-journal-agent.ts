// Canvas Journal, assistant side: the pure half of "assistant turns and tool calls flow into the same
// operations stream as canvas edits". pages/canvas/project.tsx owns the React subscription to the
// agent store (id de-duplication lives there as a ref) and the store write; every decision that needs
// no React lives here so bun:test can exercise it — when a commit is attributed to the assistant
// rather than the user, when an AgentChatItem is worth recording at all, and how its text is made
// safe for the journal (truncated, never a data URL / blob).
//
// Framework-free: no React, no DOM, no store access (the agent-store import is type-only, so nothing
// is pulled in at runtime). Nothing here is mutated; the caller keeps the returned `seen` set.

import { nanoid } from "nanoid";

import { redactLargeValues } from "@/lib/canvas/canvas-journal";
import type { AgentChatItem } from "@/stores/use-agent-store";
import type { CanvasJournalActor, CanvasJournalEntry } from "@/types/canvas";

// Attribution window: how long after an assistant/plugin canvas operation a resulting history commit
// is still credited to the assistant. It MUST be comfortably larger than the 180ms commit debounce
// in project.tsx: a setNodes from applyAgentOps starts that debounce, and only ~180ms later (plus
// React's scheduling latency) does recordJournalCommit read the timestamp. A window equal to the
// debounce would race and lose the stamp, so this is a superset of the debounce with headroom.
//
// Honesty note: this is a time-window heuristic, not a real provenance signal. The canvas state is
// written through the same setNodes/setConnections from both human handlers and the assistant bridge,
// and nothing tags an individual state change with its source. So a commit produced by a human edit
// that lands within this window of an assistant operation is mis-attributed to the assistant, and a
// human/assistant mix inside one window is credited to the assistant. This is the most honest
// attribution available without a per-change source marker on every setter; it is deliberately kept
// narrow so the error window is small.
export const CANVAS_JOURNAL_AGENT_ATTRIBUTION_WINDOW_MS = 500;

// How much of an assistant turn / tool text is kept in `summary.params.text`. Long bodies are cut
// here (and the journal never inlines a binary payload); the panel renders this single line.
export const CANVAS_JOURNAL_AGENT_TEXT_MAX = 120;

// Stand-in used when the source text is a binary payload (data:/blob:) that must never be inlined.
// English-only by design: journal params are data, not UI copy, and non-locale files must not carry
// translated strings.
const BINARY_TEXT_PLACEHOLDER = "[binary]";

const TURN_SUMMARY_KEY = "canvas.journal.agentTurn";
const TOOL_SUMMARY_KEY = "canvas.journal.agentTool";

// role === "tool" rows that are assistant activity rather than a tool invocation: reasoning / todo
// (plan) items share the "tool" role in the agent store but are not tool calls.
const NON_TOOL_ACTIVITY_KINDS: ReadonlySet<string> = new Set<string>(["reasoning", "todo"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- attribution ------------------------------------------------------------------------------

// Resolves who a canvas commit belongs to, given the timestamp of the last assistant/plugin canvas
// operation and "now". Returns the assistant when the stamp is inside the window (and not in the
// future), otherwise the user. A missing/zero/NaN stamp (no assistant op yet) is always the user.
export function resolveJournalActor(agentOpAt: number, now: number, windowMs: number = CANVAS_JOURNAL_AGENT_ATTRIBUTION_WINDOW_MS): CanvasJournalActor {
    if (typeof windowMs !== "number" || !Number.isFinite(windowMs) || windowMs < 0) return { kind: "user" };
    if (typeof agentOpAt !== "number" || !Number.isFinite(agentOpAt) || agentOpAt <= 0) return { kind: "user" };
    if (typeof now !== "number" || !Number.isFinite(now)) return { kind: "user" };
    const delta = now - agentOpAt;
    if (delta < 0 || delta > windowMs) return { kind: "user" };
    return { kind: "agent" };
}

// --- text safety ------------------------------------------------------------------------------

function isBinaryLike(value: string): boolean {
    return value.startsWith("data:") || value.startsWith("blob:");
}

// Turns arbitrary assistant/tool text into a journal-safe single line: whitespace is collapsed, an
// empty result stays empty (the caller then records nothing), a data URL / blob is replaced by a
// short placeholder instead of being inlined, and anything past the text budget is truncated. The
// kernel's `redactLargeValues` is used as the single definition of "too long", so the two agree.
export function agentEntryText(value: unknown, maxLen: number = CANVAS_JOURNAL_AGENT_TEXT_MAX): string {
    const budget = typeof maxLen === "number" && Number.isFinite(maxLen) && maxLen > 0 ? Math.floor(maxLen) : CANVAS_JOURNAL_AGENT_TEXT_MAX;
    const raw = typeof value === "string" ? value : "";
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) return "";
    if (isBinaryLike(text)) return BINARY_TEXT_PLACEHOLDER;
    const redacted = redactLargeValues(text, budget);
    if (typeof redacted !== "string") return `${text.slice(0, budget)}…`;
    return redacted;
}

// --- classification ---------------------------------------------------------------------------

// The activity kind carried by an AgentChatItem's detail (see agent-event-formatters), or "".
function activityKindOf(item: AgentChatItem): string {
    const kind = isPlainObject(item.detail) ? item.detail.kind : undefined;
    return typeof kind === "string" ? kind : "";
}

// A finished assistant reply: role "assistant", not still streaming (no streamId), with text.
export function isAgentTurnItem(item: AgentChatItem): boolean {
    return item?.role === "assistant" && !item.streamId && typeof item.text === "string" && item.text.trim() !== "";
}

// A genuine tool invocation: role "tool", excluding assistant thinking/plan activity that shares that
// role. Connection/sync/approval noise never reaches here — it lives in eventLogs, not messages.
export function isAgentToolCallItem(item: AgentChatItem): boolean {
    return item?.role === "tool" && !NON_TOOL_ACTIVITY_KINDS.has(activityKindOf(item));
}

// --- entry construction -----------------------------------------------------------------------

export type CanvasAgentJournalStamp = {
    at: number; // epoch ms shared by a batch
    seq: number; // seq of the entry (callers keep it monotonic across the journal)
    makeId: () => string; // entry id source; only called when an entry is actually built
    maxTextLen?: number;
};

function buildEntry(kind: "agent.turn" | "agent.tool", summaryKey: string, item: AgentChatItem, text: string, stamp: CanvasAgentJournalStamp): CanvasJournalEntry {
    return {
        seq: stamp.seq,
        id: stamp.makeId(),
        at: stamp.at,
        actor: { kind: "agent" },
        kind,
        targets: {},
        summary: { key: summaryKey, params: { text } },
        meta: { messageId: item.id },
    };
}

// One assistant reply -> one agent.turn entry, or null when the item is not a finished reply or has
// no safe text to show.
export function buildAgentTurnEntry(item: AgentChatItem, stamp: CanvasAgentJournalStamp): CanvasJournalEntry | null {
    if (!isAgentTurnItem(item)) return null;
    const text = agentEntryText(item.text, stamp.maxTextLen);
    if (!text) return null;
    return buildEntry("agent.turn", TURN_SUMMARY_KEY, item, text, stamp);
}

// One tool invocation -> one agent.tool entry, or null when the item is not a tool call or has no
// safe text to show. A binary payload text yields the placeholder rather than an entry with no text.
export function buildAgentToolEntry(item: AgentChatItem, stamp: CanvasAgentJournalStamp): CanvasJournalEntry | null {
    if (!isAgentToolCallItem(item)) return null;
    const text = agentEntryText(item.text, stamp.maxTextLen);
    if (!text) return null;
    return buildEntry("agent.tool", TOOL_SUMMARY_KEY, item, text, stamp);
}

// Dispatches on role: assistant -> turn, tool -> tool call, anything else (user/system/error) -> null.
export function buildAgentJournalEntry(item: AgentChatItem, stamp: CanvasAgentJournalStamp): CanvasJournalEntry | null {
    if (!item || typeof item.id !== "string" || !item.id) return null;
    return buildAgentTurnEntry(item, stamp) ?? buildAgentToolEntry(item, stamp);
}

export type CanvasAgentJournalCollectOptions = {
    now?: () => number; // epoch ms source; one timestamp is used for the whole batch
    makeId?: () => string; // entry id source
    seqStart?: number; // seq of the first emitted entry (default 0)
    maxTextLen?: number;
};

export type CanvasAgentJournalCollectResult = {
    entries: CanvasJournalEntry[]; // new entries, oldest first
    seen: Set<string>; // the input `seen` plus the ids that produced an entry
};

// Maps a message list to the journal entries it has not produced yet. `seen` holds the ids of
// messages already recorded; only an id that actually yields an entry is added, so a message that is
// still streaming (not yet eligible) or has no safe text is re-examined next time instead of being
// permanently skipped. This is what makes a repeated call idempotent — feeding the same messages and
// the returned `seen` back in produces no further entries — which is what React 18/19 strict mode's
// double-invoked effects need.
export function collectAgentJournalEntries(messages: readonly AgentChatItem[] | null | undefined, seen: ReadonlySet<string> = new Set<string>(), opts: CanvasAgentJournalCollectOptions = {}): CanvasAgentJournalCollectResult {
    const now = typeof opts.now === "function" ? opts.now : () => Date.now();
    const makeId = typeof opts.makeId === "function" ? opts.makeId : () => nanoid();
    const maxTextLen = typeof opts.maxTextLen === "number" && Number.isFinite(opts.maxTextLen) && opts.maxTextLen > 0 ? Math.floor(opts.maxTextLen) : CANVAS_JOURNAL_AGENT_TEXT_MAX;
    const seqStart = typeof opts.seqStart === "number" && Number.isFinite(opts.seqStart) ? Math.floor(opts.seqStart) : 0;

    const seenNext = new Set<string>(seen);
    const entries: CanvasJournalEntry[] = [];
    const list = Array.isArray(messages) ? messages : [];
    const at = now();
    let seq = seqStart;
    for (const item of list) {
        if (!item || typeof item.id !== "string" || !item.id) continue;
        if (seenNext.has(item.id)) continue;
        const entry = buildAgentJournalEntry(item, { at, seq, makeId, maxTextLen });
        if (!entry) continue;
        seenNext.add(item.id);
        entries.push(entry);
        seq += 1;
    }
    return { entries, seen: seenNext };
}
