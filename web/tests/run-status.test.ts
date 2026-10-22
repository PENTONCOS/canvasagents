import { describe, expect, test } from "bun:test";

import { nextRunStatus, RUN_STATUS_COLOR } from "@/lib/delivery/run-status";
import type { DeliveryRunRound } from "@/types/delivery";

function round(index: number, status: DeliveryRunRound["status"], overrides: Partial<DeliveryRunRound> = {}): DeliveryRunRound {
    return {
        index,
        startedAt: "2026-10-22T00:00:00.000Z",
        status,
        passed: status === "passed" ? 1 : 0,
        failed: status === "failed" ? 1 : 0,
        skipped: status === "skipped" ? 1 : 0,
        failures: [],
        ...overrides,
    };
}

describe("nextRunStatus", () => {
    test("没有轮次时是进行中", () => {
        expect(nextRunStatus([])).toBe("running");
    });

    test("最近一轮通过 → passed，并覆盖更早的失败", () => {
        expect(nextRunStatus([round(1, "failed"), round(2, "passed")])).toBe("passed");
    });

    test("最近一轮失败 → failed", () => {
        expect(nextRunStatus([round(1, "passed"), round(2, "failed")])).toBe("failed");
    });

    test("跑不起来 → error", () => {
        expect(nextRunStatus([round(1, "error")])).toBe("error");
    });

    test("只有无锚点轮次 → skipped，不冒充失败", () => {
        expect(nextRunStatus([round(1, "skipped", { skipped: 3 })])).toBe("skipped");
    });

    test("先真失败再出无锚点报告 → 仍是 failed，不被空报告洗白", () => {
        expect(nextRunStatus([round(1, "failed"), round(2, "skipped")])).toBe("failed");
    });

    test("skipped 有独立配色，不与被当成失败的红色共用", () => {
        expect(RUN_STATUS_COLOR.skipped).not.toBe(RUN_STATUS_COLOR.failed);
        expect(RUN_STATUS_COLOR.skipped).toBe("#94a3b8");
    });
});
