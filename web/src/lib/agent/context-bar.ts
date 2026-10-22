import { KIND_ORDER, feedKindOf, type FeedKind } from "@/lib/delivery/feed-context";
import type { CanvasNodeData } from "@/types/canvas";
import type { AcceptanceCriterion, DesignVariant } from "@/types/delivery";

/**
 * C2: 上下文条。
 *
 * 与参考产品一致：面板顶部一行，说明「这个画布当前带着哪些上下文」。
 * 数据源是画布快照里的节点，按投喂分类（feed-context 的 KIND_ORDER）聚合，
 * 再叠加交付实体的状态——验收看通过数、设计看选定数。
 *
 * 不订阅画布节点的理由见 agent-context-bar.tsx：拖动时快照每帧变化，
 * 直接订阅会让面板每帧重渲染。
 */
export type ContextSection = {
    kind: FeedKind;
    /** 该分类下的节点数。 */
    count: number;
    /** 前几个标题，给悬浮提示用。 */
    titles: string[];
    /** 绑定到这些节点的验收条目总数（没有绑定实体时不下发）。 */
    total?: number;
    /** 其中已通过的数量。 */
    passing?: number;
    /** 设计节点里已选定的版本数。 */
    selected?: number;
};

const MAX_TITLES = 6;

function boundValues<T extends { nodeId?: string }>(record: Record<string, T> | undefined, nodeIds: Set<string>): T[] {
    if (!record) return [];
    return Object.values(record).filter((item) => (item.nodeId ? nodeIds.has(item.nodeId) : false));
}

export function buildContextSections(input: {
    nodes: readonly CanvasNodeData[];
    acceptance?: Record<string, AcceptanceCriterion>;
    designs?: Record<string, DesignVariant>;
}): ContextSection[] {
    const buckets = new Map<FeedKind, CanvasNodeData[]>();
    for (const node of input.nodes) {
        const kind = feedKindOf(node);
        if (!kind) continue;
        const bucket = buckets.get(kind);
        if (bucket) bucket.push(node);
        else buckets.set(kind, [node]);
    }

    const sections: ContextSection[] = [];
    for (const kind of KIND_ORDER) {
        const bucket = buckets.get(kind);
        if (!bucket || bucket.length === 0) continue;

        const section: ContextSection = {
            kind,
            count: bucket.length,
            titles: bucket
                .map((node) => (node.title || "").trim())
                .filter(Boolean)
                .slice(0, MAX_TITLES),
        };

        const nodeIds = new Set(bucket.map((node) => node.id));
        if (kind === "acceptance") {
            const bound = boundValues(input.acceptance, nodeIds);
            if (bound.length > 0) {
                section.total = bound.length;
                section.passing = bound.filter((ac) => ac.status === "passing").length;
            }
        }
        if (kind === "design") {
            const bound = boundValues(input.designs, nodeIds);
            if (bound.length > 0) section.selected = bound.filter((design) => design.selected).length;
        }

        sections.push(section);
    }
    return sections;
}

/** 用于比较两次聚合是否等价：相等就不触发重渲染。 */
export function contextSignature(sections: readonly ContextSection[]): string {
    return sections
        .map((section) => `${section.kind}:${section.count}:${section.total ?? ""}:${section.passing ?? ""}:${section.selected ?? ""}:${section.titles.join("/")}`)
        .join("|");
}
