import { expect, test } from "bun:test";

import { appendJournalEntry, normalizeJournalEntry } from "../src/lib/canvas/canvas-journal";
import {
    agentEntryText,
    buildAgentJournalEntry,
    buildAgentToolEntry,
    buildAgentTurnEntry,
    CANVAS_JOURNAL_AGENT_ATTRIBUTION_WINDOW_MS,
    CANVAS_JOURNAL_AGENT_TEXT_MAX,
    collectAgentJournalEntries,
    isAgentToolCallItem,
    isAgentTurnItem,
    resolveJournalActor,
    type CanvasAgentJournalStamp,
} from "../src/lib/canvas/canvas-journal-agent";
import enUS from "../src/i18n/locales/en-US";
import zhCN from "../src/i18n/locales/zh-CN";
import type { AgentChatItem } from "../src/stores/use-agent-store";
import type { CanvasJournalEntry } from "../src/types/canvas";

const assistant = (id: string, text: string, extra: Partial<AgentChatItem> = {}): AgentChatItem => ({ id, role: "assistant", text, ...extra });
const tool = (id: string, text: string, extra: Partial<AgentChatItem> = {}): AgentChatItem => ({ id, role: "tool", text, ...extra });

// Fresh deterministic id source per stamp, so entry ids are predictable without touching nanoid.
const stamp = (over: Partial<CanvasAgentJournalStamp> = {}): CanvasAgentJournalStamp => {
    let counter = 0;
    return { at: 1000, seq: 7, makeId: () => `a-${counter++}`, ...over };
};

// --- actor attribution (inside / outside the window) ------------------------------------------

test("resolveJournalActor credits the assistant for a stamp inside the window", () => {
    expect(resolveJournalActor(1000, 1000, 500)).toEqual({ kind: "agent" });
    expect(resolveJournalActor(1000, 1400, 500)).toEqual({ kind: "agent" });
});

test("resolveJournalActor credits the assistant exactly at the window boundary", () => {
    expect(resolveJournalActor(1000, 1500, 500)).toEqual({ kind: "agent" });
});

test("resolveJournalActor falls back to the user just past the window", () => {
    expect(resolveJournalActor(1000, 1501, 500)).toEqual({ kind: "user" });
    expect(resolveJournalActor(1000, 9999, 500)).toEqual({ kind: "user" });
});

test("resolveJournalActor falls back to the user without a usable stamp", () => {
    expect(resolveJournalActor(0, 1000, 500)).toEqual({ kind: "user" });
    expect(resolveJournalActor(Number.NaN, 1000, 500)).toEqual({ kind: "user" });
    expect(resolveJournalActor(2000, 1000, 500)).toEqual({ kind: "user" });
    expect(resolveJournalActor(1000, 1000, Number.NaN)).toEqual({ kind: "user" });
});

test("the attribution window is larger than the 180ms commit debounce", () => {
    expect(CANVAS_JOURNAL_AGENT_ATTRIBUTION_WINDOW_MS).toBeGreaterThan(180);
});

// --- text safety ------------------------------------------------------------------------------

test("agentEntryText collapses whitespace and trims", () => {
    expect(agentEntryText("  hello\n\nworld  ")).toBe("hello world");
});

test("agentEntryText returns an empty string for empty/blank input", () => {
    expect(agentEntryText("")).toBe("");
    expect(agentEntryText("   \n  ")).toBe("");
    expect(agentEntryText(undefined)).toBe("");
    expect(agentEntryText(42)).toBe("");
});

test("agentEntryText truncates past the budget and never inlines a data URL", () => {
    const long = "x".repeat(CANVAS_JOURNAL_AGENT_TEXT_MAX + 50);
    const clipped = agentEntryText(long);
    expect(clipped.length).toBeLessThanOrEqual(CANVAS_JOURNAL_AGENT_TEXT_MAX + 1);
    expect(clipped.endsWith("…")).toBe(true);
    expect(agentEntryText("data:image/png;base64,AAAABBBBCCCC")).toBe("[binary]");
    expect(agentEntryText("blob:http://localhost/0000-1111")).toBe("[binary]");
    expect(agentEntryText(`data:${"y".repeat(500)}`)).toBe("[binary]");
});

test("agentEntryText keeps short plain text as-is", () => {
    expect(agentEntryText("canvas updated")).toBe("canvas updated");
    expect(agentEntryText("created 3 nodes")).toBe("created 3 nodes");
});

// --- classification ---------------------------------------------------------------------------

test("isAgentTurnItem accepts only finished, non-empty assistant replies", () => {
    expect(isAgentTurnItem(assistant("m1", "done"))).toBe(true);
    expect(isAgentTurnItem(assistant("m1", "done", { streamId: "m1" }))).toBe(false);
    expect(isAgentTurnItem(assistant("m1", "   "))).toBe(false);
    expect(isAgentTurnItem(tool("m1", "ran"))).toBe(false);
});

test("isAgentToolCallItem accepts tool invocations but not reasoning/plan activity", () => {
    expect(isAgentToolCallItem(tool("t1", "ls -la", { detail: { kind: "command" } }))).toBe(true);
    expect(isAgentToolCallItem(tool("t2", "searching", { detail: { kind: "search" } }))).toBe(true);
    expect(isAgentToolCallItem(tool("t3", "tool call", { detail: { kind: "tool" } }))).toBe(true);
    expect(isAgentToolCallItem(tool("t4", "thinking", { detail: { kind: "reasoning" } }))).toBe(false);
    expect(isAgentToolCallItem(tool("t5", "planning", { detail: { kind: "todo" } }))).toBe(false);
    expect(isAgentToolCallItem(assistant("a1", "hi"))).toBe(false);
});

// --- entry construction -----------------------------------------------------------------------

test("buildAgentTurnEntry builds an assistant-attributed agent.turn entry", () => {
    const entry = buildAgentTurnEntry(assistant("m1", "  moved   two nodes "), stamp({ seq: 12, at: 555 }));
    expect(entry).toEqual({
        seq: 12,
        id: "a-0",
        at: 555,
        actor: { kind: "agent" },
        kind: "agent.turn",
        targets: {},
        summary: { key: "canvas.journal.agentTurn", params: { text: "moved two nodes" } },
        meta: { messageId: "m1" },
    });
});

test("buildAgentTurnEntry rejects streaming and non-assistant items", () => {
    expect(buildAgentTurnEntry(assistant("m1", "partial", { streamId: "m1" }), stamp())).toBeNull();
    expect(buildAgentTurnEntry(assistant("m1", "   "), stamp())).toBeNull();
    expect(buildAgentTurnEntry(tool("t1", "ran", { detail: { kind: "command" } }), stamp())).toBeNull();
});

test("buildAgentToolEntry builds an assistant-attributed agent.tool entry", () => {
    const entry = buildAgentToolEntry(tool("t1", "canvas_apply_ops", { detail: { kind: "tool" } }), stamp());
    expect(entry?.kind).toBe("agent.tool");
    expect(entry?.actor).toEqual({ kind: "agent" });
    expect(entry?.summary).toEqual({ key: "canvas.journal.agentTool", params: { text: "canvas_apply_ops" } });
    expect(entry?.meta).toEqual({ messageId: "t1" });
});

test("buildAgentToolEntry rejects reasoning/plan activity", () => {
    expect(buildAgentToolEntry(tool("t1", "thinking", { detail: { kind: "reasoning" } }), stamp())).toBeNull();
    expect(buildAgentToolEntry(tool("t2", "planning", { detail: { kind: "todo" } }), stamp())).toBeNull();
});

test("buildAgentJournalEntry dispatches by role and ignores id-less items", () => {
    expect(buildAgentJournalEntry(assistant("m1", "hi"), stamp())?.kind).toBe("agent.turn");
    expect(buildAgentJournalEntry(tool("t1", "run", { detail: { kind: "command" } }), stamp())?.kind).toBe("agent.tool");
    expect(buildAgentJournalEntry({ id: "", role: "assistant", text: "hi" } as AgentChatItem, stamp())).toBeNull();
    const user: AgentChatItem = { id: "u1", role: "user", text: "do it" };
    expect(buildAgentJournalEntry(user, stamp())).toBeNull();
});

// --- collection / dedupe ----------------------------------------------------------------------

test("collectAgentJournalEntries emits one entry per finished message with increasing seq", () => {
    const messages: AgentChatItem[] = [assistant("m1", "first"), tool("t1", "cmd", { detail: { kind: "command" } }), assistant("m2", "second")];
    const result = collectAgentJournalEntries(messages, new Set<string>(), {
        now: () => 1000,
        makeId: (() => {
            let n = 0;
            return () => `e-${n++}`;
        })(),
        seqStart: 5,
    });
    expect(result.entries.map((entry) => entry.seq)).toEqual([5, 6, 7]);
    expect(result.entries.map((entry) => entry.kind)).toEqual(["agent.turn", "agent.tool", "agent.turn"]);
    expect(result.entries.map((entry) => entry.id)).toEqual(["e-0", "e-1", "e-2"]);
});

test("collectAgentJournalEntries is idempotent when fed back its own seen set", () => {
    const messages: AgentChatItem[] = [assistant("m1", "first"), tool("t1", "cmd", { detail: { kind: "command" } })];
    const first = collectAgentJournalEntries(messages, new Set<string>(), { now: () => 1000 });
    expect(first.entries).toHaveLength(2);
    const second = collectAgentJournalEntries(messages, first.seen, { now: () => 1000 });
    expect(second.entries).toHaveLength(0);
    expect([...second.seen].sort()).toEqual(["m1", "t1"]);
});

test("collectAgentJournalEntries does not mark ineligible or streaming items as seen", () => {
    const streaming = assistant("m1", "partial", { streamId: "m1" });
    const user: AgentChatItem = { id: "u1", role: "user", text: "go" };
    const first = collectAgentJournalEntries([streaming, user], new Set<string>(), { now: () => 1000 });
    expect(first.entries).toHaveLength(0);
    expect(first.seen.size).toBe(0);
    // Once the turn finishes, the same id becomes eligible and is recorded exactly once.
    const finished = assistant("m1", "complete");
    const second = collectAgentJournalEntries([finished, user], first.seen, { now: () => 1000 });
    expect(second.entries.map((entry) => entry.kind)).toEqual(["agent.turn"]);
    const third = collectAgentJournalEntries([finished, user], second.seen, { now: () => 1000 });
    expect(third.entries).toHaveLength(0);
});

// --- data URL never enters the journal --------------------------------------------------------

test("a data URL text becomes a placeholder and never reaches a normalized journal entry", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(4000)}`;
    const result = collectAgentJournalEntries([tool("t1", dataUrl, { detail: { kind: "image" } })], new Set<string>(), { now: () => 1000, makeId: () => "entry-1" });
    expect(result.entries).toHaveLength(1);
    const appended = appendJournalEntry([], result.entries[0]);
    const stored = appended.entries[0];
    expect(stored.summary.params?.text).toBe("[binary]");
    expect(JSON.stringify(stored)).not.toContain("data:image");
    expect(normalizeJournalEntry(stored)).not.toBeNull();
});

test("a long HTML body is truncated, never stored whole", () => {
    const html = `<div>${"<span>hello</span>".repeat(200)}</div>`;
    const result = collectAgentJournalEntries([assistant("m1", html)], new Set<string>(), { now: () => 1000, makeId: () => "entry-1" });
    const text = String(result.entries[0]?.summary.params?.text ?? "");
    expect(text.length).toBeLessThanOrEqual(CANVAS_JOURNAL_AGENT_TEXT_MAX + 1);
    expect(text).not.toBe(html);
});

// --- i18n keys --------------------------------------------------------------------------------

test("agent journal keys exist in both locales and carry a {{text}} placeholder", () => {
    const zh = (zhCN as { canvas: { journal: Record<string, string> } }).canvas.journal;
    const en = (enUS as { canvas: { journal: Record<string, string> } }).canvas.journal;
    for (const key of ["agentTurn", "agentTool"]) {
        expect(typeof zh[key]).toBe("string");
        expect(typeof en[key]).toBe("string");
        expect(zh[key]).toContain("{{text}}");
        expect(en[key]).toContain("{{text}}");
    }
});

test("built agent entries always normalize to a renderable entry", () => {
    const entries: CanvasJournalEntry[] = collectAgentJournalEntries([assistant("m1", "hello"), tool("t1", "cmd", { detail: { kind: "command" } })], new Set<string>(), { now: () => 1000 }).entries;
    for (const entry of entries) expect(normalizeJournalEntry(entry)).not.toBeNull();
});
