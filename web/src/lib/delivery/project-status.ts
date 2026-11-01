import type { CanvasNodeData } from "@/types/canvas";
import type { AcceptanceCriterion, AcStatus } from "@/types/delivery";

/**
 * F2: 项目状态计数（对齐参考产品左侧「待办 / 项目」树上的 已完成 · 进行中 · 待办）。
 *
 * 口径只有一条：**按画布里真实挂着的验收标准算**，不按节点数量算。
 * 一个 AC 挂着两张卡片仍然只算一件事；节点引用了不存在的 AC 实体时算「待办」，
 * 不能静默丢掉——丢掉的都是没做完的活。
 */
export type ProjectTaskCounts = {
    /** passing */
    done: number;
    /** failing / blocked —— 验证过但没过 */
    doing: number;
    /** draft / ready，以及引用了不存在的 AC */
    todo: number;
    total: number;
};

const DONE_STATUSES: AcStatus[] = ["passing"];
const DOING_STATUSES: AcStatus[] = ["failing", "blocked"];

export function summarizeProjectTasks(nodes: CanvasNodeData[], acceptance: Record<string, AcceptanceCriterion>): ProjectTaskCounts {
    const acIds = new Set<string>();
    for (const node of nodes) {
        const acId = node.metadata?.acId;
        if (acId) acIds.add(acId);
    }

    let done = 0;
    let doing = 0;
    let todo = 0;
    for (const acId of acIds) {
        const ac = acceptance[acId];
        if (!ac) {
            todo += 1;
            continue;
        }
        if (DONE_STATUSES.includes(ac.status)) done += 1;
        else if (DOING_STATUSES.includes(ac.status)) doing += 1;
        else todo += 1;
    }

    return { done, doing, todo, total: acIds.size };
}

export function addCounts(a: ProjectTaskCounts, b: ProjectTaskCounts): ProjectTaskCounts {
    return { done: a.done + b.done, doing: a.doing + b.doing, todo: a.todo + b.todo, total: a.total + b.total };
}
