import i18n from "@/i18n";
import type { DeliveryAnnotation, DeliveryBug } from "@/types/delivery";

function annotationByBugId(annotations: DeliveryAnnotation[]): Map<string, DeliveryAnnotation> {
    const map = new Map<string, DeliveryAnnotation>();
    for (const annotation of annotations) if (annotation.bugId) map.set(annotation.bugId, annotation);
    return map;
}

/**
 * 问题单 → 证据截图节点。走「问题单 ← 圈注 → 截图节点」这条链，
 * 而不是让用户手动再勾一遍图，批量投喂时才知道该把哪张图发给 Agent。
 */
export function collectEvidenceNodeIds(bugs: DeliveryBug[], annotations: DeliveryAnnotation[]): string[] {
    const byBug = annotationByBugId(annotations);
    const ids = bugs.map((bug) => byBug.get(bug.id)?.nodeId).filter((id): id is string => Boolean(id));
    return ids.filter((id, index) => ids.indexOf(id) === index);
}

/**
 * 批量投喂的提示词：每条问题单带上编号、严重级、违反的 AC 与圈注编号，
 * 让 Agent 不用再问「这是哪个问题单、对应哪条验收标准」。
 */
export function buildBugFeedPrompt(bugs: DeliveryBug[], annotations: DeliveryAnnotation[]): string {
    const byBug = annotationByBugId(annotations);
    const lines = bugs.map((bug) => {
        const annotation = byBug.get(bug.id);
        const parts = [`- ${bug.id} [${bug.severity}] ${bug.title}`];
        if (bug.violates.length > 0) parts.push(`(${i18n.t("canvas.nodeToolbar.feedBugsViolates", { acs: bug.violates.join(", ") })})`);
        if (annotation) parts.push(`#${annotation.label}`);
        return parts.join(" ");
    });
    return [i18n.t("canvas.nodeToolbar.feedBugsHeader", { count: bugs.length }), ...lines, "", i18n.t("canvas.nodeToolbar.feedBugsTail")].join("\n");
}
