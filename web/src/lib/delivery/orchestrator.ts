import type { DeliveryRunRound } from "@/types/delivery";

/**
 * M4: 验收循环编排器（纯函数）。
 *
 * 循环本身只有三步：跑 → 失败就修 → 再跑。真正难的是「什么时候停」：
 * 不设护栏的自动修复会一直烧 token，还会把测试改绿。
 *
 * 三条硬护栏（对应改造方案 M4 验收标准 2）：
 * - 轮次上限：默认 5 轮，到了还没全绿就升级给人。
 * - 触碰测试文件：只要修复改动了测试文件，立即停止——测试是标尺，不能由被考核的一方修改。
 * - 原地打转：连续 3 轮失败签名完全一致，说明修复没打中，继续跑只是重复烧钱。
 *
 * 纯函数：不读 store、不发请求；事件流由调用方灌进来，便于单测与回放。
 */

export const DEFAULT_MAX_ROUNDS = 5;
export const NO_PROGRESS_LIMIT = 3;

/** 测试文件判定：命中任意一条即视为「动了标尺」。 */
const TEST_FILE_PATTERNS = [/\.(test|spec)\.[cm]?[jt]sx?$/, /(^|\/)(tests?|__tests__|e2e)\//];

export function isTestFile(file: string): boolean {
    return TEST_FILE_PATTERNS.some((pattern) => pattern.test(file));
}

/** 失败签名：AC + 用例 + 消息归一化，用来判断两轮是不是同一个错。 */
export function failureSignature(round: Pick<DeliveryRunRound, "failures">): string {
    return round.failures
        .map((failure) => `${failure.acId || "-"}|${failure.testCaseId || "-"}|${(failure.message || "").trim().slice(0, 120)}`)
        .sort()
        .join("\n");
}

export type OrchestratorPhase = "idle" | "running" | "fixing" | "deploying" | "passed" | "escalated";

export type GuardrailCode = "max-rounds" | "test-files-touched" | "no-progress" | "human-stop";

export type Guardrail = { code: GuardrailCode; message: string };

export type OrchestratorEvent =
    | { type: "start"; at: string }
    | { type: "round"; at: string; round: DeliveryRunRound }
    | { type: "fix"; at: string; changedFiles: string[]; note?: string }
    | { type: "deploy"; at: string; ok: boolean; url?: string; version?: string; error?: string }
    | { type: "escalate"; at: string; guardrail: Guardrail }
    | { type: "done"; at: string };

export type OrchestratorState = {
    phase: OrchestratorPhase;
    rounds: DeliveryRunRound[];
    fixes: number;
    maxRounds: number;
    guardrails: Guardrail[];
    events: OrchestratorEvent[];
    stopReason?: string;
};

export function createOrchestrator(maxRounds: number = DEFAULT_MAX_ROUNDS): OrchestratorState {
    return { phase: "idle", rounds: [], fixes: 0, maxRounds, guardrails: [], events: [] };
}

const EVENT_LIMIT = 200;

function pushEvent(state: OrchestratorState, event: OrchestratorEvent): OrchestratorEvent[] {
    const events = [...state.events, event];
    return events.length > EVENT_LIMIT ? events.slice(events.length - EVENT_LIMIT) : events;
}

function escalate(state: OrchestratorState, guardrail: Guardrail, at: string): OrchestratorState {
    // 只记一次，避免每轮重复追加同一护栏。
    const guardrails = state.guardrails.some((item) => item.code === guardrail.code) ? state.guardrails : [...state.guardrails, guardrail];
    return {
        ...state,
        phase: "escalated",
        guardrails,
        stopReason: guardrail.message,
        events: pushEvent(state, { type: "escalate", at, guardrail }),
    };
}

/** 收事件、出状态。所有副作用（发消息、写 store）都在调用方。 */
export function reduceOrchestrator(state: OrchestratorState, event: OrchestratorEvent): OrchestratorState {
    if (state.phase === "escalated") return state;

    switch (event.type) {
        case "start":
            return { ...state, phase: "running", events: pushEvent(state, event) };

        case "round": {
            const rounds = [...state.rounds, event.round];
            const next: OrchestratorState = { ...state, rounds, events: pushEvent(state, event) };

            if (event.round.status === "passed" || event.round.status === "skipped") {
                return { ...next, phase: "passed", events: pushEvent(next, { type: "done", at: event.at }) };
            }

            if (rounds.length >= state.maxRounds) {
                return escalate(next, { code: "max-rounds", message: `已跑满 ${state.maxRounds} 轮仍未全绿，停止并升级` }, event.at);
            }

            // 原地打转：连续 N 轮失败签名一致。
            if (rounds.length >= NO_PROGRESS_LIMIT) {
                const tail = rounds.slice(-NO_PROGRESS_LIMIT).map(failureSignature);
                if (tail.every((signature) => signature === tail[0] && signature !== "")) {
                    return escalate(next, { code: "no-progress", message: `连续 ${NO_PROGRESS_LIMIT} 轮失败签名一致，修复未命中，停止并升级` }, event.at);
                }
            }

            return { ...next, phase: "fixing" };
        }

        case "fix": {
            const next: OrchestratorState = { ...state, fixes: state.fixes + 1, events: pushEvent(state, event) };
            const touched = event.changedFiles.filter(isTestFile);
            if (touched.length > 0) {
                return escalate(next, { code: "test-files-touched", message: `修复动到了测试文件（${touched.join(", ")}），测试是标尺，停止并升级` }, event.at);
            }
            return { ...next, phase: "running" };
        }

        case "deploy": {
            const next: OrchestratorState = { ...state, phase: event.ok ? "passed" : "escalated", events: pushEvent(state, event) };
            if (event.ok) return next;
            return escalate(next, { code: "human-stop", message: event.error || "部署失败，停止并升级" }, event.at);
        }

        case "escalate":
            return escalate(state, event.guardrail, event.at);

        case "done":
            return { ...state, phase: "passed", events: pushEvent(state, event) };

        default:
            return state;
    }
}

export type NextAction = "start" | "run-tests" | "fix" | "deploy" | "stop" | "wait";

/** 当前状态该做什么。UI 只读这一个出口，避免各处自己判断 phase。 */
export function decideNextAction(state: OrchestratorState): NextAction {
    switch (state.phase) {
        case "idle":
            return "start";
        case "running":
            return "run-tests";
        case "fixing":
            return "fix";
        case "passed":
            return "deploy";
        case "escalated":
            return "stop";
        case "deploying":
            return "wait";
        default:
            return "wait";
    }
}
