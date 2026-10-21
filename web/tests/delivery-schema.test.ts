import { describe, expect, test } from "bun:test";

import { canTransitionAc, nextEntityId, nextStepId, nextVariantId, transitionAc, type AcStatus } from "@/types/delivery";

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

describe("M1 实体 id 分配", () => {
    test("nextStepId 按已有步骤顺延", () => {
        expect(nextStepId("J-01", [])).toBe("J-01-S1");
        expect(nextStepId("J-01", ["J-01-S1", "J-01-S2"])).toBe("J-01-S3");
        // 其他旅程的步骤不参与编号。
        expect(nextStepId("J-02", ["J-01-S7"])).toBe("J-02-S1");
    });

    test("nextVariantId 从未占用的字母开始", () => {
        expect(nextVariantId([])).toBe("D-01-A");
        expect(nextVariantId(["D-01-A", "D-01-B"])).toBe("D-01-C");
        expect(nextVariantId(["D-01-A", "D-01-C"])).toBe("D-01-B");
    });
});
