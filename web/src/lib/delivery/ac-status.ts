import type { AcStatus } from "@/types/delivery";

/**
 * M2: AC 状态配色单一来源。
 *
 * 画布节点徽章、侧栏验收列表、以及后续的 Bug 单都从这里取色，
 * 避免「同一个状态两处颜色不一样」——这种不一致单测抓不到，只能靠人眼。
 * 颜色同时满足：绿=通过、红=未通过、橙=阻塞、蓝=待验、灰=草稿。
 */
export const AC_STATUS_COLOR: Record<AcStatus, string> = {
    draft: "#94a3b8",
    ready: "#0ea5e9",
    failing: "#ef4444",
    passing: "#22c55e",
    blocked: "#f59e0b",
};

export const AC_STATUS_ORDER: AcStatus[] = ["draft", "ready", "failing", "passing", "blocked"];

/** i18n key 也一并在里，避免各处手写 `canvas.node.delivery.acStatus.*`。 */
export function acStatusLabelKey(status: AcStatus): string {
    return `canvas.node.delivery.acStatus.${status}`;
}

/** 运营视角的汇总计数，侧栏顶部用它显示「8 条 / 2 条未通过」。 */
export function countAcByStatus(statuses: AcStatus[]): Record<AcStatus, number> {
    const counts: Record<AcStatus, number> = { draft: 0, ready: 0, failing: 0, passing: 0, blocked: 0 };
    for (const status of statuses) counts[status] += 1;
    return counts;
}
