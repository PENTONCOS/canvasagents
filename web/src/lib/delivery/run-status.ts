import type { VerificationRunStatus } from "@/types/delivery";

/**
 * M4: 运行状态配色单一来源，和 AC 状态色保持同一套语义：
 * 绿=通过，红=失败，橙=出错（不是断言失败，是跑不起来），蓝=进行中。
 * 侧栏运行列表与画布 Run 节点徽章共用，避免两处颜色漂移。
 */
export const RUN_STATUS_COLOR: Record<VerificationRunStatus, string> = {
    running: "#0ea5e9",
    passed: "#22c55e",
    failed: "#ef4444",
    error: "#f59e0b",
};

export function runStatusLabelKey(status: VerificationRunStatus): string {
    return `canvas.node.delivery.runStatus.${status}`;
}
