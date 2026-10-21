import { describe, expect, test } from "bun:test";

import {
    createOrchestrator,
    decideNextAction,
    failureSignature,
    isTestFile,
    reduceOrchestrator,
    type OrchestratorEvent,
    type OrchestratorState,
} from "@/lib/delivery/orchestrator";
import type { DeliveryRunRound } from "@/types/delivery";

const AT = "2026-10-21T12:00:00.000Z";

function round(index: number, status: DeliveryRunRound["status"], failures: DeliveryRunRound["failures"] = []): DeliveryRunRound {
    const failed = status === "passed" ? 0 : failures.length;
    return { index, startedAt: AT, status, passed: status === "passed" ? 3 : 0, failed, skipped: 0, failures };
}

function run(state: OrchestratorState, ...events: OrchestratorEvent[]): OrchestratorState {
    return events.reduce(reduceOrchestrator, state);
}

describe("验收循环编排器", () => {
    test("第一轮失败进入修复，第二轮通过即结束", () => {
        const state = run(
            createOrchestrator(),
            { type: "start", at: AT },
            { type: "round", at: AT, round: round(1, "failed", [{ acId: "AC-01", message: "boom" }]) },
            { type: "fix", at: AT, changedFiles: ["web/src/app.ts"] },
            { type: "round", at: AT, round: round(2, "passed") },
        );
        expect(state.phase).toBe("passed");
        expect(state.rounds).toHaveLength(2);
        expect(state.fixes).toBe(1);
        expect(state.guardrails).toHaveLength(0);
    });

    test("跑满 5 轮仍未通过则升级，不再继续", () => {
        let state = run(createOrchestrator(5), { type: "start", at: AT });
        for (let index = 1; index <= 5; index += 1) {
            state = reduceOrchestrator(state, { type: "round", at: AT, round: round(index, "failed", [{ acId: `AC-0${index}`, message: `err-${index}` }]) });
        }
        expect(state.phase).toBe("escalated");
        expect(state.guardrails.map((item) => item.code)).toContain("max-rounds");
        expect(decideNextAction(state)).toBe("stop");

        // 升级后再来事件也不改变状态：护栏必须是单向闸门。
        const after = reduceOrchestrator(state, { type: "round", at: AT, round: round(6, "passed") });
        expect(after.rounds).toHaveLength(5);
    });

    test("修复动了测试文件立即升级", () => {
        const state = run(
            createOrchestrator(),
            { type: "start", at: AT },
            { type: "round", at: AT, round: round(1, "failed", [{ acId: "AC-01", message: "boom" }]) },
            { type: "fix", at: AT, changedFiles: ["web/src/foo.ts", "web/tests/foo.test.ts"] },
        );
        expect(state.phase).toBe("escalated");
        expect(state.stopReason).toContain("测试文件");
        expect(state.guardrails[0].code).toBe("test-files-touched");
    });

    test("连续 3 轮失败签名一致判定为原地打转", () => {
        const same = [{ acId: "AC-01", message: "expected 1 to be 2" }];
        const state = run(
            createOrchestrator(10),
            { type: "start", at: AT },
            { type: "round", at: AT, round: round(1, "failed", same) },
            { type: "fix", at: AT, changedFiles: ["web/src/a.ts"] },
            { type: "round", at: AT, round: round(2, "failed", same) },
            { type: "fix", at: AT, changedFiles: ["web/src/a.ts"] },
            { type: "round", at: AT, round: round(3, "failed", same) },
        );
        expect(state.phase).toBe("escalated");
        expect(state.guardrails[0].code).toBe("no-progress");
    });

    test("失败内容每轮不同则不算原地打转", () => {
        const state = run(
            createOrchestrator(10),
            { type: "start", at: AT },
            { type: "round", at: AT, round: round(1, "failed", [{ acId: "AC-01", message: "e1" }]) },
            { type: "fix", at: AT, changedFiles: ["web/src/a.ts"] },
            { type: "round", at: AT, round: round(2, "failed", [{ acId: "AC-02", message: "e2" }]) },
            { type: "fix", at: AT, changedFiles: ["web/src/b.ts"] },
            { type: "round", at: AT, round: round(3, "failed", [{ acId: "AC-03", message: "e3" }]) },
            { type: "fix", at: AT, changedFiles: ["web/src/c.ts"] },
            { type: "round", at: AT, round: round(4, "passed") },
        );
        expect(state.phase).toBe("passed");
    });

    test("测试文件判定覆盖常见路径", () => {
        expect(isTestFile("web/tests/a.test.ts")).toBe(true);
        expect(isTestFile("web/e2e/a.e2e.ts")).toBe(true); // 目录命中即算：e2e 下的文件都是标尺
        expect(isTestFile("web/e2e/a.ts")).toBe(true);
        expect(isTestFile("src/__tests__/x.tsx")).toBe(true);
        expect(isTestFile("src/app/a.spec.jsx")).toBe(true);
        expect(isTestFile("src/app/main.ts")).toBe(false);
    });

    test("失败签名与顺序无关，且能区分不同错误", () => {
        const a = failureSignature({ failures: [{ acId: "AC-01", message: "x" }, { acId: "AC-02", message: "y" }] });
        const b = failureSignature({ failures: [{ acId: "AC-02", message: "y" }, { acId: "AC-01", message: "x" }] });
        const c = failureSignature({ failures: [{ acId: "AC-01", message: "z" }] });
        expect(a).toBe(b);
        expect(a).not.toBe(c);
    });

    test("事件流被记录，便于回放", () => {
        const state = run(
            createOrchestrator(),
            { type: "start", at: AT },
            { type: "round", at: AT, round: round(1, "passed") },
        );
        expect(state.events.map((event) => event.type)).toEqual(["start", "round", "done"]);
    });

    test("决策出口随阶段变化", () => {
        expect(decideNextAction(createOrchestrator())).toBe("start");
        const failing = run(
            createOrchestrator(),
            { type: "start", at: AT },
            { type: "round", at: AT, round: round(1, "failed", [{ message: "x" }]) },
        );
        expect(decideNextAction(failing)).toBe("fix");
        const passed = run(failing, { type: "fix", at: AT, changedFiles: ["src/a.ts"] }, { type: "round", at: AT, round: round(2, "passed") });
        expect(decideNextAction(passed)).toBe("deploy");
    });
});

describe("skipped 不算通过", () => {
    test("一轮里一条 AC 都没判出来（skipped）→ 立即升级为 no-anchors", () => {
        const state = run(
            createOrchestrator(),
            { type: "start", at: AT },
            { type: "round", at: AT, round: round(1, "skipped") },
        );
        expect(state.phase).toBe("escalated");
        expect(state.guardrails.map((item) => item.code)).toContain("no-anchors");
        expect(decideNextAction(state)).toBe("stop");
    });

    test("升级后不再接受新轮次（状态不再变化）", () => {
        const escalated = run(createOrchestrator(), { type: "start", at: AT }, { type: "round", at: AT, round: round(1, "skipped") });
        const after = reduceOrchestrator(escalated, { type: "round", at: AT, round: round(2, "passed") });
        expect(after).toBe(escalated);
    });
});
