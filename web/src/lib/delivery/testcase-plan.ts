// WO-03: 验收标准 → 测试用例的结构化落地。
// 参考产品的第 4 幕是「8 条验收标准 / 21 个用例」，用例必须成为可统计、可回填的实体，
// 而不是聊天里一段文字。这里做两件事：
//   1) 按规则给一条 AC 规划分层用例（连不上 Agent 时也能得到可执行结构）；
//   2) 解析 Agent 回复里的用例清单（JSON 块或带 @AC-xx 锚点的列表），交给 store 落库。
import { acAnchor, createTestCaseDraft } from "@/lib/delivery/ac-testcase";
import type { AcTestLayer, AcceptanceCriterion, DeliveryTestCase } from "@/types/delivery";

export type ParsedTestCase = {
    acId: string;
    title: string;
    layer?: AcTestLayer;
    file?: string;
};

const LAYERS: AcTestLayer[] = ["unit", "component", "daemon", "e2e", "manual"];

function asLayer(value: unknown): AcTestLayer | undefined {
    return typeof value === "string" && (LAYERS as string[]).includes(value) ? (value as AcTestLayer) : undefined;
}

/** 规则模板：一层一条，覆盖「便宜的先跑」到「最接近真实用户」。 */
const TEMPLATES: { layer: AcTestLayer; suffix: string }[] = [
    { layer: "unit", suffix: "规则与数据校验" },
    { layer: "component", suffix: "界面交互与状态" },
    { layer: "e2e", suffix: "端到端主路径" },
];

/**
 * 给一条 AC 规划三条用例（unit / component / e2e）。
 * 已存在同层同名的用例就跳过，重复点不会堆出一堆一样的记录。
 */
export function planCasesForAc(ac: AcceptanceCriterion, existing: DeliveryTestCase[]): DeliveryTestCase[] {
    const statement = (ac.statement || "").trim();
    const base = statement || ac.id;
    const existingIds = existing.map((item) => item.id);
    const made: DeliveryTestCase[] = [];
    for (const template of TEMPLATES) {
        const title = `${base} · ${template.suffix}`;
        const duplicate = existing.some((item) => item.acId === ac.id && item.title === title);
        if (duplicate) continue;
        const draft = createTestCaseDraft({
            acId: ac.id,
            title,
            existingIds: [...existingIds, ...made.map((item) => item.id)],
            layer: template.layer,
        });
        if (draft.title) made.push(draft);
    }
    return made;
}

/** 从 Agent 回复里抓取用例：优先 ```json 块，其次带 @AC-xx 锚点的列表行。 */
export function parseTestCaseReply(text: string, validAcIds?: Set<string>): ParsedTestCase[] {
    if (!text || typeof text !== "string") return [];
    const out: ParsedTestCase[] = [];
    const push = (item: ParsedTestCase) => {
        if (!item.acId || !item.title) return;
        if (validAcIds && validAcIds.size > 0 && !validAcIds.has(item.acId)) return;
        if (out.some((existing) => existing.acId === item.acId && existing.title === item.title)) return;
        out.push(item);
    };

    for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
        const body = match[1]?.trim();
        if (!body || !body.startsWith("{")) continue;
        try {
            const parsed = JSON.parse(body) as { testCases?: unknown };
            const list = Array.isArray(parsed?.testCases) ? parsed.testCases : [];
            for (const raw of list) {
                const item = raw as Record<string, unknown>;
                const acId = typeof item.acId === "string" ? item.acId.trim() : "";
                const title = typeof item.title === "string" ? item.title.trim() : "";
                push({ acId, title, layer: asLayer(item.layer), file: typeof item.file === "string" ? item.file : undefined });
            }
        } catch {
            // 不是合法 JSON 就继续看下一种格式，不因为一段坏数据丢掉整条回复。
        }
    }

    if (out.length === 0) {
        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.replace(/^[\s>*\-•\d.、]+/, "").trim();
            const anchor = /@([A-Za-z]+-\d+)/.exec(trimmed);
            if (!anchor) continue;
            const layerMatch = /\[(unit|component|daemon|e2e|manual)\]/i.exec(trimmed);
            const title = trimmed
                .replace(/```.*$/g, "")
                .replace(/\[(unit|component|daemon|e2e|manual)\]/gi, "")
                .replace(/\s*[（(]?\s*@[A-Za-z]+-\d+\s*[)）]?\s*/g, " ")
                .trim();
            push({
                acId: anchor[1].toUpperCase().replace(/^([A-Za-z]+)-(\d+)$/, (_all, prefix: string, num: string) => `${prefix.toUpperCase()}-${num.padStart(2, "0")}`),
                title,
                layer: asLayer(layerMatch?.[1]?.toLowerCase()),
            });
        }
    }
    return out;
}

/** 落库入口：把解析结果合并进已有用例（同 AC + 同标题视为重复），返回实际新增数。 */
export function mergeParsedCases(
    parsed: ParsedTestCase[],
    state: { acceptance: Record<string, AcceptanceCriterion>; testCases: Record<string, DeliveryTestCase> },
    upsert: (testCase: DeliveryTestCase) => void,
): number {
    if (parsed.length === 0) return 0;
    const ids = Object.keys(state.testCases);
    const existing = Object.values(state.testCases);
    let added = 0;
    for (const item of parsed) {
        if (!state.acceptance[item.acId]) continue;
        if (existing.some((testCase) => testCase.acId === item.acId && testCase.title === item.title)) continue;
        const draft = createTestCaseDraft({ acId: item.acId, title: item.title, existingIds: ids, layer: item.layer, file: item.file });
        if (!draft.title) continue;
        ids.push(draft.id);
        existing.push(draft);
        upsert(draft);
        added += 1;
    }
    return added;
}

/** 锚点展示用：侧栏每张 AC 卡片上要能直接看到回填依据。 */
export function anchorForAc(acId: string) {
    return acAnchor(acId);
}
