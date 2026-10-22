import type { DeliveryRunRound, VerificationRunStatus } from "@/types/delivery";

/**
 * M4: 运行状态配色单一来源，和 AC 状态色保持同一套语义：
 * 绿=通过，红=失败，橙=出错（不是断言失败，是跑不起来），蓝=进行中，灰=无锚点（判不了）。
 * 侧栏运行列表与画布 Run 节点徽章共用，避免两处颜色漂移。
 */
export const RUN_STATUS_COLOR: Record<VerificationRunStatus, string> = {
    running: "#0ea5e9",
    passed: "#22c55e",
    failed: "#ef4444",
    error: "#f59e0b",
    skipped: "#94a3b8",
};

/**
 * 由轮次推导运行状态。
 * 关键区分：skipped 表示「报告里一条带 @AC 的用例都没有」，是判不了，不是断言失败；
 * 所以它不能把整个运行染成失败——除非这一次运行此前真的失败过（失败不该被后续空报告洗白）。
 * 最近一轮通过则覆盖更早的失败（M4 修复循环语义）。
 */
export function nextRunStatus(rounds: DeliveryRunRound[]): VerificationRunStatus {
    const latest = rounds[rounds.length - 1];
    if (!latest) return "running";
    if (latest.status === "passed") return "passed";
    if (latest.status === "error") return "error";
    if (latest.status === "skipped") {
        return rounds.slice(0, -1).some((round) => round.status === "failed") ? "failed" : "skipped";
    }
    return "failed";
}

export function runStatusLabelKey(status: VerificationRunStatus): string {
    return `canvas.node.delivery.runStatus.${status}`;
}
