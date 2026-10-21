import { canTransitionAc, type AcStatus, type AcceptanceCriterion } from "@/types/delivery";

/**
 * M2: 测试结果 → AC 状态回填。
 *
 * 规则：
 * - fail  → failing；pass → passing；skip 不改（没跑就不算数）。
 * - draft 的 AC 被结果命中时，先自动推进到 ready，再落到结果状态：
 *   测试都跑起来了还说「草稿」，只会让人误判。
 * - 非法迁移不硬改，记进 rejected 里，由调用方决定要不要提示。
 *
 * 纯函数：不读 store、不发请求，便于单测与复用（画布侧和 CLI 侧同一套规则）。
 */

export type AcResultInput = { acId: string; result: "pass" | "fail" | "skip" };

export type AcStatusPlan = { acId: string; from: AcStatus; to: AcStatus; steps: AcStatus[] };

export type AcStatusPlanResult = {
    plans: AcStatusPlan[];
    rejected: { acId: string; from: AcStatus; to: AcStatus; reason: string }[];
};

const TARGET: Record<"pass" | "fail", AcStatus> = { pass: "passing", fail: "failing" };

export function planAcStatusUpdates(acceptance: Record<string, AcceptanceCriterion>, results: AcResultInput[]): AcStatusPlanResult {
    const plans: AcStatusPlan[] = [];
    const rejected: AcStatusPlanResult["rejected"] = [];

    for (const input of results) {
        if (input.result === "skip") continue;
        const ac = acceptance[input.acId];
        if (!ac) {
            rejected.push({ acId: input.acId, from: "draft", to: TARGET[input.result], reason: "unknown AC" });
            continue;
        }
        const target = TARGET[input.result];
        // 同一 AC 多条用例时，失败优先：已经计划成 failing 就不再被后面的 pass 覆盖。
        if (plans.some((plan) => plan.acId === input.acId && plan.to === "failing")) continue;

        const steps = resolveSteps(ac.status, target);
        if (!steps) {
            rejected.push({ acId: input.acId, from: ac.status, to: target, reason: `illegal transition ${ac.status} -> ${target}` });
            continue;
        }
        const existing = plans.find((plan) => plan.acId === input.acId);
        if (existing) {
            existing.to = target;
            existing.steps = steps;
        } else {
            plans.push({ acId: input.acId, from: ac.status, to: target, steps });
        }
    }

    return { plans, rejected };
}

/** 返回从 from 走到 to 的中间状态序列（含终点）；走不通返回 null。 */
function resolveSteps(from: AcStatus, to: AcStatus): AcStatus[] | null {
    if (from === to) return [];
    if (canTransitionAc(from, to)) return [to];
    // draft 未就绪就被测试命中：先 ready。
    if (from === "draft" && canTransitionAc("ready", to)) return ["ready", to];
    // passing 收到失败之外的回落（例如回到 ready）允许；其余不猜。
    return null;
}
