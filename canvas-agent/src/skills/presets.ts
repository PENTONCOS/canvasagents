/**
 * WO-08: 三套流程 Skill。
 * 参考产品的课程把交付拆成三种强度：0→1 大功能、1→N 迭代、Bug 修复。
 * 这里把三套固化成可直接下发给编码 Agent 的指令文本，并统一挂在「质量三角」上：
 * 定义正确（要做什么写清楚）/ 验证正确（拿什么证明）/ 失败可恢复（坏了怎么退）。
 *
 * 只定义内容，不碰存储：写入仍走 skills/store 的托管技能接口，
 * 这样预设与用户自建技能共用同一套校验、版本与回滚。
 */

export type SkillPresetId = "feature" | "develop" | "bug";

export type SkillPreset = {
    id: SkillPresetId;
    name: string;
    displayName: string;
    /** 30-64 字：技能面板一行就能读完 */
    shortDescription: string;
    description: string;
    defaultPrompt: string;
    instructions: string;
};

const QUALITY_TRIANGLE = `质量三角（每一步都要显式回答）：
1) 定义正确：验收标准写成了可判定的句子吗？边界、失败路径写了吗？
2) 验证正确：每条标准对应的用例具体在哪一层（unit / component / e2e / manual）？锚点是什么？
3) 失败可恢复：这次改动出问题怎么退？回滚点、开关、数据兼容说清楚。`;

export const SKILL_PRESETS: SkillPreset[] = [
    {
        id: "feature",
        name: "canvas-feature-0to1",
        displayName: "0→1 新功能",
        shortDescription: "从一句需求到可验收的完整功能：先定标准，再写代码，最后留回滚点。",
        description: "适合全新功能：需求还模糊、没有现成实现可参考时使用。产出需求拆解 + 验收标准 + 实现 + 用例。",
        defaultPrompt: "用 0→1 流程把这个需求做成可验收的功能",
        instructions: `你是这条功能的负责人。按顺序做，每步都留下可检查的产物：

1. 需求澄清：把模糊说法变成 3-5 条用户故事；不确定的地方直接问，不要猜。
2. 验收标准：每条故事写 2-3 条可判定的 AC（含失败与边界），编号 AC-01 起。
3. 设计：给 2-3 个方案并说明取舍；只做最小可验证的实现，不做顺手重构。
4. 实现：按步骤提交，每步都能单独回滚；新增代码要有对应测试。
5. 验证：跑测试并把失败按 @AC-xx 锚点归位；测试通过前不要说完成。

${QUALITY_TRIANGLE}

禁止：编造测试结果、跳过失败用例、用 as any / @ts-ignore 压错误。`,
    },
    {
        id: "develop",
        name: "canvas-develop-1toN",
        displayName: "1→N 迭代",
        shortDescription: "在已有实现上加功能：先摸清现状与影响面，再小步改，保持兼容。",
        description: "适合已有模块上迭代：有现成实现、有用户数据、不能推倒重来。",
        defaultPrompt: "用 1→N 流程在这个已有模块上做迭代",
        instructions: `你要在既有实现上迭代，默认前提是「有人在用、有数据、不能砸」。

1. 现状：先读相关代码与数据流，写出这次改动会碰到的文件与调用方（找不到就说不确定）。
2. 兼容：列出会受影响的旧行为/旧数据；需要迁移就写迁移与回滚脚本。
3. 小步：拆成可独立上线的若干改动，每步保持测试全绿。
4. 回归：跑全量测试，新增用例覆盖旧路径，不只是新功能。

${QUALITY_TRIANGLE}

禁止：顺手重构无关代码、悄悄改接口语义、删除失败测试。`,
    },
    {
        id: "bug",
        name: "canvas-bug-fix",
        displayName: "Bug 修复",
        shortDescription: "只修坏掉的那一处：先复现，再最小改动，最后补一条不会复发的用例。",
        description: "适合缺陷修复：现象明确、根因未知、要求最小改动与防复发。",
        defaultPrompt: "按缺陷流程修复这个问题，先复现再改",
        instructions: `你修的是缺陷，不是重写。

1. 复现：写清最小复现步骤（输入、环境、期望、实际）；复现不了就回报，不要盲改。
2. 根因：定位到具体文件与行为，说明为什么现在才暴露；猜测必须标注为猜测。
3. 最小改动：只改必要处，不做风格整理；改动范围写进汇报。
4. 防复发：补一条会因这个 bug 失败的用例，并在修复前确认它确实红过。
5. 回归：跑相关与全量测试；把失败按 @AC-xx 回指。

${QUALITY_TRIANGLE}

禁止：用 catch 吞错、关闭检查绕过失败、把问题归结为「环境问题」而不给证据。`,
    },
];

export function getSkillPreset(id: SkillPresetId): SkillPreset | undefined {
    return SKILL_PRESETS.find((preset) => preset.id === id);
}
