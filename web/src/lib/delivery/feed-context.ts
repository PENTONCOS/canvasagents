import i18n from "@/i18n";
import { readSketchShapes } from "@/lib/canvas/sketch-node-utils";
import type { CanvasNodeData } from "@/types/canvas";
import { CanvasNodeType } from "@/types/canvas";
import type {
    AcceptanceCriterion,
    DeliveryAnnotation,
    DeliveryBug,
    DeliveryEnvironment,
    DesignVariant,
    Journey,
} from "@/types/delivery";

/**
 * P0-1: 框选任意节点 → 结构化投喂。
 *
 * 参考产品的做法是「上下文以画布为中介」：换 agent 时不重讲需求，框选一遍再投喂。
 * 所以投喂不能只认问题单，任何画布内容都要能交给 Agent——提示词按内容类型分组，
 * 让 Agent 知道每一段是什么，而不是收到一坨没有结构的文本。
 */

export type FeedLookup = {
    bugs: Record<string, DeliveryBug>;
    annotations: Record<string, DeliveryAnnotation>;
    acceptance: Record<string, AcceptanceCriterion>;
    journeys: Record<string, Journey>;
    designs: Record<string, DesignVariant>;
    environments: Record<string, DeliveryEnvironment>;
};

export type FeedKind = "requirement" | "journey" | "acceptance" | "design" | "bug" | "environment" | "image" | "markdown" | "preview" | "sketch" | "text" | "media" | "other";

/** 分组顺序固定：先交付语义，再素材。 */
export const KIND_ORDER: FeedKind[] = ["requirement", "journey", "acceptance", "design", "bug", "environment", "image", "markdown", "preview", "sketch", "text", "media", "other"];

const SECTION_KEY: Record<FeedKind, string> = {
    requirement: "canvas.nodeToolbar.feedSectionRequirement",
    journey: "canvas.nodeToolbar.feedSectionJourney",
    acceptance: "canvas.nodeToolbar.feedSectionAcceptance",
    design: "canvas.nodeToolbar.feedSectionDesign",
    bug: "canvas.nodeToolbar.feedSectionBug",
    environment: "canvas.nodeToolbar.feedSectionEnvironment",
    image: "canvas.nodeToolbar.feedSectionImage",
    markdown: "canvas.nodeToolbar.feedSectionMarkdown",
    preview: "canvas.nodeToolbar.feedSectionPreview",
    sketch: "canvas.nodeToolbar.feedSectionSketch",
    text: "canvas.nodeToolbar.feedSectionText",
    media: "canvas.nodeToolbar.feedSectionMedia",
    other: "canvas.nodeToolbar.feedSectionOther",
};

const EXCERPT_LIMIT = 80;

/** 节点 → 投喂分类；返回 null 表示这类节点不参与投喂（配置节点、分组框）。 */
export function feedKindOf(node: CanvasNodeData): FeedKind | null {
    switch (node.type) {
        case CanvasNodeType.Requirement:
            return "requirement";
        case CanvasNodeType.Journey:
        case CanvasNodeType.JourneyStep:
            return "journey";
        case CanvasNodeType.Acceptance:
        case CanvasNodeType.TestCase:
            return "acceptance";
        case CanvasNodeType.Design:
            return "design";
        case CanvasNodeType.Bug:
            return "bug";
        case CanvasNodeType.Environment:
            return "environment";
        case CanvasNodeType.Image:
            return "image";
        // A1/A2/A3：三类内容节点同样要能交接给 Agent，否则「框选任意画布内容」在这三种上会静默丢内容。
        case "markdown":
            return "markdown";
        case "preview":
            return "preview";
        case "sketch":
            return "sketch";
        case CanvasNodeType.Text:
            return "text";
        case CanvasNodeType.Video:
        case CanvasNodeType.Audio:
            return "media";
        case CanvasNodeType.Run:
            return "other";
        default:
            return null;
    }
}

export function isFeedableNode(node: CanvasNodeData): boolean {
    return feedKindOf(node) !== null;
}

/** 可投喂的节点（按选中顺序，去掉配置节点这类不该进提示词的类型）。 */
export function feedableNodes(nodes: CanvasNodeData[]): CanvasNodeData[] {
    return nodes.filter(isFeedableNode);
}

function excerpt(value?: string): string {
    const text = (value || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT)}…` : text;
}

function annotationByBugId(annotations: Record<string, DeliveryAnnotation>): Map<string, DeliveryAnnotation> {
    const map = new Map<string, DeliveryAnnotation>();
    for (const annotation of Object.values(annotations)) if (annotation.bugId) map.set(annotation.bugId, annotation);
    return map;
}

/**
 * 同一张问题单可能被圈了多处（每个问题一张图不够用时很常见）。
 * 这里保留全部证据节点，不能因为用了 Map 就把前面的覆盖掉。
 */
function evidenceNodeIdsByBug(annotations: Record<string, DeliveryAnnotation>): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const annotation of Object.values(annotations)) {
        if (!annotation.bugId || !annotation.nodeId) continue;
        const bucket = map.get(annotation.bugId);
        if (bucket) bucket.push(annotation.nodeId);
        else map.set(annotation.bugId, [annotation.nodeId]);
    }
    return map;
}

/**
 * 问题单 → 证据截图节点。走「问题单 ← 圈注 → 截图节点」这条链，
 * 而不是让用户手动再勾一遍图，批量投喂时才知道该把哪张图发给 Agent。
 */
export function collectEvidenceNodeIds(nodes: CanvasNodeData[], lookup: Pick<FeedLookup, "bugs" | "annotations">): string[] {
    const byBug = evidenceNodeIdsByBug(lookup.annotations);
    const ids = nodes
        .filter((node) => node.type === CanvasNodeType.Bug)
        .flatMap((node) => (node.metadata?.bugId ? byBug.get(node.metadata.bugId) || [] : []));
    const unique = ids.filter((id, index) => ids.indexOf(id) === index);
    // 已经选中了的截图不重复引用。
    const selected = new Set(nodes.map((node) => node.id));
    return unique.filter((id) => !selected.has(id));
}

function lineForNode(node: CanvasNodeData, kind: FeedKind, lookup: FeedLookup): string {
    const metadata = node.metadata;
    switch (kind) {
        case "bug": {
            const bug = metadata?.bugId ? lookup.bugs[metadata.bugId] : undefined;
            if (!bug) return `- ${node.title}`;
            const parts = [`- ${bug.id} [${bug.severity}] ${bug.title}`];
            if (bug.violates.length > 0) parts.push(`(${i18n.t("canvas.nodeToolbar.feedBugsViolates", { acs: bug.violates.join(", ") })})`);
            const annotation = annotationByBugId(lookup.annotations).get(bug.id);
            if (annotation) parts.push(`#${annotation.label}`);
            return parts.join(" ");
        }
        case "acceptance": {
            const ac = metadata?.acId ? lookup.acceptance[metadata.acId] : undefined;
            if (!ac) return `- ${node.title}`;
            return `- ${ac.id} ${ac.statement || node.title}`;
        }
        case "journey": {
            const journey = Object.values(lookup.journeys).find((item) => item.nodeId === node.id);
            if (journey) return `- ${journey.id} ${journey.title || node.title}`;
            return `- ${node.title}`;
        }
        case "design": {
            const label = metadata?.variantLabel || node.title;
            const design = Object.values(lookup.designs).find((item) => item.nodeId === node.id);
            const state = design?.selected
                ? i18n.t("canvas.nodeToolbar.feedDesignSelected")
                : i18n.t("canvas.nodeToolbar.feedDesignUnselected");
            // WO-01: 只有选中的那版才带设计内容 —— 投喂给编码 Agent 的就是要实现的稿。
            // 未选中的版本只报标签与状态，避免把三版都塞进上下文。
            const html = design?.selected && typeof design.html === "string" ? design.html.trim() : "";
            if (!html) return `- ${label}（${state}）`;
            const capped = html.length > 4000 ? `${html.slice(0, 4000)}\n<!-- 设计稿 HTML 已截断 -->` : html;
            return `- ${label}（${state}）\n\`\`\`html\n${capped}\n\`\`\``;
        }
        case "environment": {
            const env = metadata?.envId ? lookup.environments[metadata.envId] : undefined;
            if (!env) return `- ${node.title}`;
            return `- ${env.id} ${env.name}${env.url ? ` ${env.url}` : ""}${env.version ? ` · ${env.version}` : ""}`;
        }
        case "image":
            return `- ${node.title}（${i18n.t("canvas.nodeToolbar.feedImageTag")}）`;
        case "requirement": {
            // A4: 一句话需求便签；多条并列时靠正文本身区分，摘要行直接带需求内容。
            const body = excerpt(metadata?.content || metadata?.statement);
            return body ? `- ${node.title}：${body}` : `- ${node.title}`;
        }
        case "markdown": {
            // 只带摘要：整篇 Markdown 可能很长，Agent 需要全文时按标题回画布取。
            const body = excerpt(metadata?.content);
            return body ? `- ${node.title}：${body}` : `- ${node.title}`;
        }
        case "preview": {
            // 预览节点的地址存在 metadata.preview.url（M4 起就是嵌套结构），
            // 兼容早期直接写 metadata.url 的旧节点。
            const url = metadata?.preview?.url || metadata?.url || "";
            return url ? `- ${node.title}：${url}` : `- ${node.title}`;
        }
        case "sketch": {
            const count = readSketchShapes(metadata?.sketch).length;
            return `- ${node.title}（${i18n.t("canvas.nodeToolbar.feedSketchShapes", { count })}）`;
        }
        default: {
            const body = excerpt(metadata?.statement || metadata?.content || metadata?.prompt || metadata?.composerContent);
            return body ? `- ${node.title}：${body}` : `- ${node.title}`;
        }
    }
}

/**
 * C4: 多张截图合成一张后，图片分组不再逐条列出，只留一行摘要。
 * 摘要必须带「几张、几列几行、实际像素」——Agent 靠这三个数判断该看哪块区域，
 * 只给它一张大图而不说布局，它没法定位。
 */
export type FeedPromptOptions = {
    imageGroup?: { count: number; summary: string };
};

/** 结构化投喂提示词：按类型分组，同组内逐条列出；空选择返回空串（调用方据此不发）。 */
export function buildFeedPrompt(nodes: CanvasNodeData[], lookup: FeedLookup, options: FeedPromptOptions = {}): string {
    const groups = new Map<FeedKind, CanvasNodeData[]>();
    for (const node of nodes) {
        const kind = feedKindOf(node);
        if (!kind) continue;
        const bucket = groups.get(kind);
        if (bucket) bucket.push(node);
        else groups.set(kind, [node]);
    }
    const total = Array.from(groups.values()).reduce((sum, bucket) => sum + bucket.length, 0);
    if (total === 0) return "";

    const lines: string[] = [i18n.t("canvas.nodeToolbar.feedHeader", { count: total })];
    for (const kind of KIND_ORDER) {
        const bucket = groups.get(kind);
        if (!bucket || bucket.length === 0) continue;
        lines.push("");
        lines.push(i18n.t(SECTION_KEY[kind]));
        if (kind === "image" && options.imageGroup) {
            lines.push(`- ${options.imageGroup.summary}`);
            continue;
        }
        for (const node of bucket) lines.push(lineForNode(node, kind, lookup));
    }
    lines.push("");
    lines.push(i18n.t("canvas.nodeToolbar.feedTail"));
    return lines.join("\n");
}
