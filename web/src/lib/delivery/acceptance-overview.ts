import {
    AC_LAYER_ORDER,
    type AcceptanceCriterion,
    type AcStatus,
    type AcTestLayer,
    type DeliveryBug,
    type DeliveryTestCase,
    type Journey,
    type JourneyStep,
} from "@/types/delivery";

/**
 * F1: 验收一览（对齐参考产品的「用户故事 → 验收标准 → 怎么验」三列矩阵）。
 *
 * 左边是用户想要什么（旅程步骤），中间是判断（不）通过的标准（AC），
 * 右边是拿什么证明（按测试层级归类的用例）。缺口要显式标出来：
 * 一条 AC 没有任何用例，就是「无法证明」，不能因为列表里看着有它就当它过了。
 */
export type OverviewAc = {
    id: string;
    statement: string;
    status: AcStatus;
    /** 各层级下的用例标题；空数组表示这一层没有覆盖。 */
    layers: Record<AcTestLayer, string[]>;
    /** 一条用例都没有 —— 当前无法证明这条 AC。 */
    unproven: boolean;
    /** 违反这条 AC 的问题单编号。 */
    bugs: string[];
    nodeId?: string;
};

export type OverviewRow = {
    /** 步骤 id / 旅程 id / "unassigned"。 */
    key: string;
    storyId?: string;
    storyTitle: string;
    journeyTitle?: string;
    acs: OverviewAc[];
};

export type AcceptanceOverview = {
    rows: OverviewRow[];
    totalAcs: number;
    /** 没有任何用例兜底的 AC 数。 */
    unprovenAcs: number;
    failingAcs: number;
    /** 各层级有多少条用例（顶部 chips 用）。 */
    layerCounts: Record<AcTestLayer, number>;
};

const EMPTY_LAYERS = (): Record<AcTestLayer, string[]> => ({ unit: [], component: [], daemon: [], e2e: [], manual: [] });

/**
 * 用例没写 layer 时按路径/选择器推断。宁可按最保守的层算，也不要瞎标成「真实页面」。
 * 判定顺序：e2e 锚点 > storybook > 桥端目录 > 默认纯函数。
 */
export function inferTestLayer(testCase: DeliveryTestCase): AcTestLayer {
    if (testCase.layer) return testCase.layer;
    const file = testCase.file || "";
    const selector = testCase.selector || "";
    if (/\.e2e\.|\/e2e\//i.test(file) || /^@BOT/i.test(selector)) return "e2e";
    if (/\.stories?\.|storybook/i.test(file)) return "component";
    if (/canvas-agent\/|daemon/i.test(file)) return "daemon";
    return "unit";
}

function toOverviewAc(ac: AcceptanceCriterion, testCases: DeliveryTestCase[], bugs: DeliveryBug[]): OverviewAc {
    const layers = EMPTY_LAYERS();
    let count = 0;
    for (const testCase of testCases) {
        if (testCase.acId !== ac.id) continue;
        layers[inferTestLayer(testCase)].push(testCase.title || testCase.id);
        count += 1;
    }
    return {
        id: ac.id,
        statement: ac.statement,
        status: ac.status,
        layers,
        unproven: count === 0,
        bugs: bugs.filter((bug) => bug.violates.includes(ac.id)).map((bug) => bug.id),
        nodeId: ac.nodeId,
    };
}

export function buildAcceptanceOverview(input: {
    journeys?: Record<string, Journey>;
    steps?: Record<string, JourneyStep>;
    acceptance?: Record<string, AcceptanceCriterion>;
    testCases?: Record<string, DeliveryTestCase>;
    bugs?: Record<string, DeliveryBug>;
}): AcceptanceOverview {
    const acceptance = input.acceptance ?? {};
    const journeys = input.journeys ?? {};
    const testCases = Object.values(input.testCases ?? {});
    const bugs = Object.values(input.bugs ?? {});

    const steps = Object.values(input.steps ?? {}).sort(
        (a, b) => a.journeyId.localeCompare(b.journeyId) || a.order - b.order,
    );

    const claimed = new Set<string>();
    const rows: OverviewRow[] = [];

    const takeAcs = (matches: (ac: AcceptanceCriterion) => boolean): OverviewAc[] =>
        Object.values(acceptance)
            .filter((ac) => !claimed.has(ac.id) && matches(ac))
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((ac) => {
                claimed.add(ac.id);
                return toOverviewAc(ac, testCases, bugs);
            });

    // 1) 旅程步骤 = 用户故事。没有 AC 的步骤不占行，避免刷屏。
    for (const step of steps) {
        const acs = takeAcs((ac) => ac.stepIds.includes(step.id));
        if (acs.length === 0) continue;
        rows.push({
            key: step.id,
            storyId: step.id,
            storyTitle: step.title,
            journeyTitle: journeys[step.journeyId]?.title,
            acs,
        });
    }

    // 2) 挂在旅程上、但没细到步骤的 AC。
    for (const journey of Object.values(journeys)) {
        const acs = takeAcs((ac) => ac.journeyIds.includes(journey.id));
        if (acs.length === 0) continue;
        rows.push({
            key: journey.id,
            storyId: journey.id,
            storyTitle: journey.title,
            journeyTitle: journey.title,
            acs,
        });
    }

    // 3) 没挂到任何故事上的 AC 必须出现，不能静默丢。
    const rest = takeAcs(() => true);
    if (rest.length > 0) rows.push({ key: "unassigned", storyTitle: "", acs: rest });

    const layerCounts = EMPTY_LAYERS() as unknown as Record<AcTestLayer, number>;
    for (const layer of AC_LAYER_ORDER) layerCounts[layer] = testCases.filter((testCase) => inferTestLayer(testCase) === layer).length;

    const allAcs = rows.flatMap((row) => row.acs);
    return {
        rows,
        totalAcs: allAcs.length,
        unprovenAcs: allAcs.filter((ac) => ac.unproven).length,
        failingAcs: allAcs.filter((ac) => ac.status === "failing").length,
        layerCounts,
    };
}
