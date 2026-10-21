import { describe, expect, test } from "bun:test";

import { canTransitionAc, nextEntityId, transitionAc, type AcStatus } from "@/types/delivery";

describe("AC state machine", () => {
    const legal: [AcStatus, AcStatus][] = [
        ["draft", "ready"],
        ["ready", "failing"],
        ["ready", "blocked"],
        ["failing", "passing"],
        ["failing", "blocked"],
        ["passing", "failing"],
        ["passing", "ready"],
        ["passing", "blocked"],
        ["blocked", "ready"],
        ["blocked", "failing"],
        ["blocked", "passing"],
        ["draft", "draft"], // same-state is a no-op, allowed
        ["passing", "passing"],
    ];
    test.each(legal)("allows %s -> %s", (from, to) => {
        expect(canTransitionAc(from, to)).toBe(true);
        expect(transitionAc(from, to)).toEqual({ ok: true, status: to });
    });

    const illegal: [AcStatus, AcStatus][] = [
        ["draft", "failing"],
        ["draft", "passing"],
        ["draft", "blocked"],
        ["ready", "passing"], // must run (fail first) before passing
        ["failing", "ready"],
        ["blocked", "draft"],
    ];
    test.each(illegal)("rejects %s -> %s", (from, to) => {
        expect(canTransitionAc(from, to)).toBe(false);
        const result = transitionAc(from, to);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("illegal AC transition");
    });
});

describe("nextEntityId", () => {
    test("starts at 01 for empty list", () => {
        expect(nextEntityId([], "AC")).toBe("AC-01");
    });
    test("increments the max numeric suffix", () => {
        expect(nextEntityId(["AC-01", "AC-04", "AC-02"], "AC")).toBe("AC-05");
    });
    test("pads to two digits", () => {
        expect(nextEntityId(["BUG-09"], "BUG")).toBe("BUG-10");
        expect(nextEntityId(["BUG-99"], "BUG")).toBe("BUG-100");
    });
    test("ignores other prefixes and malformed ids", () => {
        expect(nextEntityId(["AC-x", "BUG-07", "AC-"], "AC")).toBe("AC-01");
    });
});
