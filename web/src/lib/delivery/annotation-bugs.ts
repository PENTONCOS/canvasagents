import { annotationBugTitle, nextEntityId, type DeliveryAnnotation, type DeliveryBug } from "@/types/delivery";

export type PlannedBug = {
    annotationId: string;
    bug: DeliveryBug;
};

/**
 * 圈注 → 问题单的纯规划：一条圈注出一个 BUG-xx，编号在毫秒内连续分配不会撞号。
 * 已经有 bugId 的圈注跳过，避免同一处截图问题被重复提两次。
 */
export function planBugsFromAnnotations(annotations: DeliveryAnnotation[], existingBugIds: string[]): PlannedBug[] {
    const ids = [...existingBugIds];
    const planned: PlannedBug[] = [];
    for (const annotation of annotations) {
        if (annotation.bugId) continue;
        const id = nextEntityId(ids, "BUG");
        ids.push(id);
        planned.push({
            annotationId: annotation.id,
            bug: {
                id,
                title: annotationBugTitle(annotation),
                severity: "P2",
                violates: annotation.acId ? [annotation.acId] : [],
                status: "open",
                fixRunIds: [],
            },
        });
    }
    return planned;
}
