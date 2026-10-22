import i18n from "@/i18n";
import {
    nextEntityId,
    type AcTestLayer,
    type AcceptanceCriterion,
    type DeliveryTestCase,
    type Journey,
    type JourneyStep,
} from "@/types/delivery";

/**
 * D3: AC → 测试用例。
 *
 * 关系选型：一条用例只验一条 AC（用例实体上保留唯一的 `acId`），AC 侧的
 * `testCaseIds` 是派生索引。理由：
 * - 报告解析（E2/E3）按 `@AC-xx` 回填，一条用例在多条 AC 下重复出现时，
 *   同一次失败会被记到多条 AC 上，回填会失真；
 * - 现有 `removeAc` 的级联删除、`acceptance-overview` 的分层统计都建立在
 *   「testCase.acId === ac.id」这个单值判断上，改成多对多要重写这些语义；
 * - 一条用例要覆盖多条 AC 时，正确做法是拆成多条用例（每条一个锚点），
 *   这样报告里也能看出是哪条断言红了。
 *
 * 锚点只能由 `acAnchor` 生成：报告回填的唯一依据，不能靠人手写。
 */

/** 报告锚点：AC-01 → @AC-01；AC-1 归一到两位，避免 @AC-1 / @AC-01 两种写法各记一套。 */
export function acAnchor(acId: string): string {
    const trimmed = acId.trim();
    const match = /^([A-Za-z]+)-(\d+)$/.exec(trimmed);
    if (!match) return `@${trimmed}`;
    return `@${match[1].toUpperCase()}-${match[2].padStart(2, "0")}`;
}

/** 用例编号：TC-01、TC-02…（与 AC/BUG 同一套 nextEntityId 规则，项目内不重复）。 */
export function nextTestCaseId(existing: string[]): string {
    return nextEntityId(existing, "TC");
}

/** 新建用例草稿：锚点与 acId 同时写死，之后改标题也不会丢回指。 */
export function createTestCaseDraft(input: {
    acId: string;
    title: string;
    existingIds: string[];
    file?: string;
    layer?: AcTestLayer;
}): DeliveryTestCase {
    const id = nextTestCaseId(input.existingIds);
    return {
        id,
        acId: input.acId,
        title: input.title.trim(),
        selector: acAnchor(input.acId),
        ...(input.file ? { file: input.file } : {}),
        ...(input.layer ? { layer: input.layer } : {}),
    };
}

/**
 * 「让 Agent 生成用例」的提示词。
 *
 * 必须自包含：Agent 拿到这段文字就要知道验哪条 AC、它在旅程的哪一步、
 * 已有哪几条用例（避免重复生成），以及每条用例必须带锚点——否则报告里
 * 没有 `@AC-xx`，这一轮只会记 skipped，等于白跑。
 */
export function buildAcTestCasePrompt(input: {
    ac: AcceptanceCriterion;
    journey?: Journey;
    steps?: JourneyStep[];
    existing?: DeliveryTestCase[];
}): string {
    const anchor = acAnchor(input.ac.id);
    const steps = (input.steps || []).slice().sort((a, b) => a.order - b.order);
    const existing = input.existing || [];
    const lines: string[] = [];

    lines.push(i18n.t("canvas.acTestCase.promptHeader", { anchor }));
    lines.push("");
    lines.push(`【${i18n.t("canvas.acTestCase.promptAc")}】${input.ac.id}${input.ac.statement ? `：${input.ac.statement}` : ""}`);
    if (input.journey) {
        lines.push(`【${i18n.t("canvas.acTestCase.promptJourney")}】${input.journey.id} ${input.journey.title}`.trim());
    }
    if (steps.length > 0) {
        lines.push(`【${i18n.t("canvas.acTestCase.promptSteps")}】`);
        for (const step of steps) lines.push(`- ${step.id} ${step.title}`.trim());
    }
    lines.push(
        `【${i18n.t("canvas.acTestCase.promptExisting")}】${
            existing.length > 0 ? existing.map((item) => `${item.id} ${item.title}`.trim()).join("；") : i18n.t("canvas.acTestCase.promptExistingNone")
        }`,
    );
    lines.push("");
    lines.push(`【${i18n.t("canvas.acTestCase.promptRules")}】`);
    lines.push(i18n.t("canvas.acTestCase.promptRuleAnchor", { anchor }));
    lines.push(i18n.t("canvas.acTestCase.promptRuleSingle", { anchor }));
    lines.push(i18n.t("canvas.acTestCase.promptRuleScope"));
    return lines.join("\n");
}

/** 旧数据兼容：缺字段的 AC 按空数组读，别让 `.includes` 在 hydrate 后的旧记录上炸掉。 */
export function withAcRelations(ac: AcceptanceCriterion): AcceptanceCriterion {
    return {
        ...ac,
        journeyIds: Array.isArray(ac.journeyIds) ? ac.journeyIds : [],
        stepIds: Array.isArray(ac.stepIds) ? ac.stepIds : [],
        testCaseIds: Array.isArray(ac.testCaseIds) ? ac.testCaseIds : [],
    };
}
