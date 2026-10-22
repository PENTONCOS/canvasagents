// A4: 需求便签。一句话需求独立成节点，可以并排摆多条。
// 正文只存在 metadata.content（与 Text/Markdown 一致），所以每条便签靠节点 id 各自持久化，
// 更新一条不会碰到兄弟节点；刷新后随画布整体恢复。
// 这个模块只放纯函数，方便单测覆盖「多条并列」与「改一条不影响另一条」。
import type { CanvasNodeData } from "@/types/canvas";

export const REQUIREMENT_NODE_TYPE = "requirement";

/** 需求正文取 content，兼容早期 Agent 写入的 statement 字段。 */
export function requirementContent(node: CanvasNodeData | null | undefined): string {
    const metadata = node?.metadata;
    const content = typeof metadata?.content === "string" ? metadata.content : "";
    if (content.trim()) return content;
    const statement = typeof metadata?.statement === "string" ? metadata.statement : "";
    return statement;
}

/** 一句话需求：换行/连续空白折成单个空格，首尾不留空。 */
export function normalizeRequirementDraft(value: string | undefined | null): string {
    return String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * 便签序号：按画布上的出现顺序（节点数组顺序，也就是创建顺序）编号。
 * 只数需求便签，其它类型不占号；刷新后顺序不变，编号也就稳定。
 * 找不到节点时返回 0，调用方据此不渲染序号。
 */
export function requirementOrdinal(nodes: CanvasNodeData[], nodeId: string): number {
    const requirements = nodes.filter((node) => node.type === REQUIREMENT_NODE_TYPE);
    const index = requirements.findIndex((node) => node.id === nodeId);
    return index >= 0 ? index + 1 : 0;
}
