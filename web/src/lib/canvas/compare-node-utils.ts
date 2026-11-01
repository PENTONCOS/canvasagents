export const COMPARE_NODE_TYPE = "compare";

/**
 * F3: 对照块（对齐参考产品的「现在的问题 ↔ 方案」红绿并排块）。
 *
 * 一列写做不到/不对的地方，另一列写对应怎么改。行为约定：
 * ・按行拆条，空行不算一条（避免空行把计数顶起来）；
 * ・每条前面的 `-` / `*` / `1.` 编号都剥掉，用户习惯从文档里粘过来；
 * ・两侧条数不一致就是「没对齐」，界面要显式提示，而不是装作配平了。
 */
export function splitCompareItems(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .map((line) => line.replace(/^(?:[-*•]|\d+[.)])\s*/, "").trim())
        .filter(Boolean);
}

export type CompareStats = { problems: number; solutions: number; balanced: boolean; score: number };

/** score = 配平度（0–1）：两侧都空算 0，一侧为空算 0，否则取少的那边 / 多的那边。 */
export function compareStats(problems: string, solutions: string): CompareStats {
    const problemCount = splitCompareItems(problems).length;
    const solutionCount = splitCompareItems(solutions).length;
    const balanced = problemCount === solutionCount;
    const score = !problemCount || !solutionCount ? 0 : Math.min(problemCount, solutionCount) / Math.max(problemCount, solutionCount);
    return { problems: problemCount, solutions: solutionCount, balanced, score };
}
