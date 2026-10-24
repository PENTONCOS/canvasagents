/**
 * 项目层（I1）：画布之上再加一层「项目」，一个项目下可以有多个画布。
 *
 * 这一层只做分组与迁移，不碰画布里的节点/消息——把画布搬去别的项目，
 * 会话与内容必须原样跟着走，否则「切换项目不丢会话」就是假的。
 * 因此这里的函数只读 `id` 与 `groupId` 两个字段，返回的新对象也只改 `groupId`。
 */

export type CanvasProjectGroup = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
};

/** 能归组的画布只需要这两个字段，避免 lib 反向依赖 store 类型。 */
export type GroupableCanvas = { id: string; groupId?: string };

export type CanvasGroupBucket<T extends GroupableCanvas> = {
    group: CanvasProjectGroup;
    canvases: T[];
};

export type ProjectGroupPlan<T extends GroupableCanvas> = {
    groups: CanvasProjectGroup[];
    canvases: T[];
    /** 本次迁移新建的默认项目 id；没有新建则为 null。 */
    createdGroupId: string | null;
};

/**
 * 把画布与项目对齐到一份自洽的数据：
 * - 项目 id 去重（保留第一个）、空 id 丢弃、缺标题用默认标题补齐；
 * - 画布 `groupId` 缺失或指向不存在的项目时，归入第一个项目；
 * - 一个项目都没有时不凭空造组，除非确实有画布需要归入（此时新建默认项目）。
 *
 * 全都合法时原样返回 `canvases` 引用，不做无意义的整表重写。
 */
export function planProjectGroups<T extends GroupableCanvas>(
    canvases: T[],
    groups: CanvasProjectGroup[],
    options: { now: string; defaultTitle: string; newId: () => string },
): ProjectGroupPlan<T> {
    const seen = new Set<string>();
    const kept: CanvasProjectGroup[] = [];
    for (const group of groups) {
        const id = typeof group.id === "string" ? group.id.trim() : "";
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const title = typeof group.title === "string" ? group.title.trim() : "";
        kept.push({
            id,
            title: title || options.defaultTitle,
            createdAt: group.createdAt || options.now,
            updatedAt: group.updatedAt || options.now,
        });
    }

    const validIds = new Set(kept.map((group) => group.id));
    const orphans = canvases.filter((canvas) => !canvas.groupId || !validIds.has(canvas.groupId));
    if (!orphans.length) return { groups: kept, canvases, createdGroupId: null };

    let createdGroupId: string | null = null;
    let targetGroupId: string;
    if (kept.length) {
        targetGroupId = kept[0].id;
    } else {
        createdGroupId = options.newId();
        kept.push({ id: createdGroupId, title: options.defaultTitle, createdAt: options.now, updatedAt: options.now });
        targetGroupId = createdGroupId;
    }

    const orphanSet = new Set(orphans);
    return {
        groups: kept,
        canvases: canvases.map((canvas) => (orphanSet.has(canvas) ? { ...canvas, groupId: targetGroupId } : canvas)),
        createdGroupId,
    };
}

/** 按项目顺序分桶；没有任何画布的项目也保留（空项目是合法的）。 */
export function groupCanvases<T extends GroupableCanvas>(canvases: T[], groups: CanvasProjectGroup[]): { buckets: CanvasGroupBucket<T>[]; orphans: T[] } {
    const byGroup = new Map<string, T[]>();
    for (const group of groups) byGroup.set(group.id, []);
    const orphans: T[] = [];
    for (const canvas of canvases) {
        const bucket = canvas.groupId ? byGroup.get(canvas.groupId) : undefined;
        if (bucket) bucket.push(canvas);
        else orphans.push(canvas);
    }
    return { buckets: groups.map((group) => ({ group, canvases: byGroup.get(group.id) || [] })), orphans };
}

/** 只有空项目能删：非空时删项目等于连画布一起删，那必须是显式的画布删除动作。 */
export function canDeleteGroup(canvases: GroupableCanvas[], groupId: string): boolean {
    return !canvases.some((canvas) => canvas.groupId === groupId);
}

/**
 * 列表页当前展示哪个项目：优先用户选中的，其次当前画布所属项目，最后第一个。
 * 选中的项目被删后不能停在空列表上，所以要回退。
 */
export function resolveActiveGroupId(groups: CanvasProjectGroup[], preferred: string | null, currentCanvasGroupId: string | null): string | null {
    const ids = new Set(groups.map((group) => group.id));
    if (preferred && ids.has(preferred)) return preferred;
    if (currentCanvasGroupId && ids.has(currentCanvasGroupId)) return currentCanvasGroupId;
    return groups[0]?.id ?? null;
}
