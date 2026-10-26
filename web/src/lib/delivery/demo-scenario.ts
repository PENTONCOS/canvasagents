// WO-04: 内置七幕示例。
// 参考产品打开就是一整套可操作的交付现场（需求 → 旅程 → 设计 → AC/用例 → 运行 → 问题 → 环境）。
// 这里把「门店预约」这个场景一次性铺到画布上，实体和节点一起写，
// 不连本地 Agent 也能把七幕走一遍；连上 Agent 后所有数据都可继续被真实流程覆盖。
import { nanoid } from "nanoid";

import { createCanvasNode } from "@/lib/canvas/canvas-node-factory";
import { generateDesignVariants } from "@/lib/delivery/design-generator";
import { planJourneys, stepScreenHtml } from "@/lib/delivery/journey-planner";
import { acAnchor } from "@/lib/delivery/ac-testcase";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import type { AcceptanceCriterion, DeliveryBug, DeliveryEnvironment, DeliveryRun, DeliveryTestCase, DesignVariant, Journey, JourneyStep } from "@/types/delivery";

export const DEMO_TITLE = "门店预约 · 示例项目";

const BRIEF = {
    title: "门店预约",
    statement:
        "顾客选择门店与时间段完成预约，支持改期和取消。店员在后台查看当日预约并核销。超时未到自动释放时段，重复提交要拦截。店长查看统计报表并导出。",
    journeyTitle: "门店预约小程序",
};

type DemoEntities = {
    journeys: Journey[];
    steps: JourneyStep[];
    designs: DesignVariant[];
    acceptance: AcceptanceCriterion[];
    testCases: DeliveryTestCase[];
    bugs: DeliveryBug[];
    environments: DeliveryEnvironment[];
    runs: DeliveryRun[];
};

export type DemoScenario = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    entities: DemoEntities;
};

function makeNode(type: CanvasNodeType, x: number, y: number, metadata: Record<string, unknown> = {}) {
    const node = createCanvasNode(type, { x, y });
    node.metadata = { ...node.metadata, ...metadata };
    return node;
}

function link(from: string, to: string, type: CanvasConnection["type"], label?: string): CanvasConnection {
    return { id: nanoid(), fromNodeId: from, toNodeId: to, type, ...(label ? { label } : {}) };
}

/**
 * 铺开七幕：1 需求 / 2 三条旅程与步骤原型 / 3 三版设计 / 4 验收标准与用例 /
 * 5 一次真实形态的运行记录 / 6 两个问题单 / 7 一个环境。位置固定，重复载入会叠在右侧，不覆盖已有内容。
 */
export function buildDemoScenario(offsetX = 0, offsetY = 0): DemoScenario {
    const nodes: CanvasNodeData[] = [];
    const connections: CanvasConnection[] = [];
    const entities: DemoEntities = { journeys: [], steps: [], designs: [], acceptance: [], testCases: [], bugs: [], environments: [], runs: [] };

    // 1) 需求
    const requirement = makeNode(CanvasNodeType.Requirement, offsetX, offsetY, { statement: BRIEF.statement, status: "success" });
    requirement.title = BRIEF.title;
    nodes.push(requirement);

    // 2) 三条旅程 + 步骤原型
    const planned = planJourneys(BRIEF);
    planned.forEach((plan, journeyIndex) => {
        const journeyY = offsetY + 520 + journeyIndex * 900;
        const journeyNode = makeNode(CanvasNodeType.Journey, offsetX, journeyY, { statement: plan.title });
        journeyNode.title = plan.title;
        nodes.push(journeyNode);
        connections.push(link(requirement.id, journeyNode.id, "derives"));

        const journeyId = `J-0${journeyIndex + 1}`;
        const stepIds: string[] = [];
        plan.steps.forEach((title, stepIndex) => {
            const stepNode = makeNode(CanvasNodeType.JourneyStep, offsetX - 360 + stepIndex * 260, journeyY + 430, {
                statement: title,
                journeyId,
                prototypeHtml: stepScreenHtml(title, plan.title),
            });
            nodes.push(stepNode);
            connections.push(link(journeyNode.id, stepNode.id, "specifies"));
            const stepId = `${journeyId}-S${stepIndex + 1}`;
            stepIds.push(stepId);
            entities.steps.push({ id: stepId, journeyId, order: stepIndex + 1, title, nodeId: stepNode.id });
        });
        entities.journeys.push({ id: journeyId, title: plan.title, stepIds, nodeId: journeyNode.id });
    });

    // 3) 三版设计
    const generated = generateDesignVariants(BRIEF);
    const designY = offsetY + 520 + planned.length * 900 + 120;
    const designIds: string[] = [];
    generated.forEach((variant, index) => {
        const node = makeNode(CanvasNodeType.Design, offsetX - 420 + index * 420, designY, {
            variantLabel: variant.label,
            selected: index === 0,
            variantOf: "",
        });
        nodes.push(node);
        if (index === 0) {
            // 同组锚点指向 A 版自己，B/C 指向它，选定逻辑沿用现有分组规则。
            for (const other of nodes.filter((item) => item.type === CanvasNodeType.Design)) other.metadata = { ...other.metadata, variantOf: node.id };
        }
        const id = `D-01-${variant.label}`;
        designIds.push(id);
        entities.designs.push({
            id,
            journeyId: "J-01",
            label: variant.label,
            style: variant.style,
            notes: variant.notes,
            selected: index === 0,
            nodeId: node.id,
            html: variant.html,
            updatedAt: new Date().toISOString(),
        });
        if (index > 0) connections.push(link(requirement.id, node.id, "derives"));
    });
    // 锚点回填：A 版节点自己的 id 才是分组键。
    const designNodes = nodes.filter((item) => item.type === CanvasNodeType.Design);
    if (designNodes[0]) {
        for (const node of designNodes) node.metadata = { ...node.metadata, variantOf: designNodes[0].id };
        for (const variant of entities.designs) {
            const match = designNodes.find((node) => node.metadata?.variantLabel === variant.label);
            if (match) variant.nodeId = match.id;
        }
    }

    // 4) 六条验收标准，每条挂到具体步骤
    const AC_SPECS: { statement: string; journeyId: string; stepId: string; status: AcceptanceCriterion["status"] }[] = [
        { statement: "选择门店与时间段后可以提交预约", journeyId: "J-01", stepId: "J-01-S2", status: "passing" },
        { statement: "同一时段重复提交会被拦截", journeyId: "J-02", stepId: "J-02-S1", status: "failing" },
        { statement: "预约成功后展示确认信息与二维码", journeyId: "J-01", stepId: "J-01-S3", status: "passing" },
        { statement: "超时未到自动释放时段", journeyId: "J-02", stepId: "J-02-S2", status: "ready" },
        { statement: "店员可以核销当日预约", journeyId: "J-03", stepId: "J-03-S1", status: "passing" },
        { statement: "店长可以导出预约统计报表", journeyId: "J-03", stepId: "J-03-S3", status: "ready" },
    ];
    const acY = designY + 520;
    const acNodes: CanvasNodeData[] = [];
    AC_SPECS.forEach((spec, index) => {
        const acId = `AC-0${index + 1}`;
        const node = makeNode(CanvasNodeType.Acceptance, offsetX - 700 + index * 280, acY, { acId, statement: spec.statement });
        nodes.push(node);
        acNodes.push(node);
        const stepNode = nodes.find((item) => item.metadata?.statement === entities.steps.find((step) => step.id === spec.stepId)?.title && item.type === CanvasNodeType.JourneyStep);
        if (stepNode) connections.push(link(node.id, stepNode.id, "covers"));
        entities.acceptance.push({
            id: acId,
            statement: spec.statement,
            journeyIds: [spec.journeyId],
            stepIds: [spec.stepId],
            testCaseIds: [],
            status: spec.status,
            nodeId: node.id,
        });
    });

    // 4b) 每条 AC 两条用例（unit + e2e），锚点即报告回填依据
    let caseIndex = 0;
    for (const ac of entities.acceptance) {
        for (const layer of ["unit", "e2e"] as const) {
            caseIndex += 1;
            const id = `TC-${String(caseIndex).padStart(2, "0")}`;
            entities.testCases.push({
                id,
                acId: ac.id,
                title: `${ac.statement} · ${layer === "unit" ? "规则校验" : "端到端主路径"}`,
                selector: acAnchor(ac.id),
                layer,
            });
            ac.testCaseIds.push(id);
        }
    }

    // 5) 运行记录 + 6) 问题单 + 7) 环境
    const envNode = makeNode(CanvasNodeType.Environment, offsetX + 260, acY + 420, { envId: "ENV-01", envName: "staging", url: "https://staging.booking.example" });
    nodes.push(envNode);
    entities.environments.push({
        id: "ENV-01",
        name: "staging",
        url: "https://staging.booking.example",
        version: "v0.2.0",
        status: "healthy",
        deployedAt: new Date().toISOString(),
        nodeId: envNode.id,
    });

    const runNode = makeNode(CanvasNodeType.Run, offsetX - 340, acY + 420, { runId: "RUN-01", runKind: "test" });
    nodes.push(runNode);
    entities.runs.push({
        id: "RUN-01",
        kind: "test",
        command: "pnpm test:e2e",
        cwd: "~/work/booking",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: "failed",
        nodeId: runNode.id,
        results: entities.testCases.map((testCase) => ({
            acId: testCase.acId,
            testCaseId: testCase.id,
            result: testCase.acId === "AC-02" ? "fail" : "pass",
        })),
    });
    connections.push(link(runNode.id, acNodes[1]?.id || acNodes[0].id, "proves"));

    const BUGS: { title: string; severity: DeliveryBug["severity"]; violates: string[]; status: DeliveryBug["status"] }[] = [
        { title: "同一时段连点两次会创建两条预约", severity: "P1", violates: ["AC-02"], status: "fixing" },
        { title: "超时释放后时段仍显示已占用", severity: "P2", violates: ["AC-04"], status: "open" },
    ];
    BUGS.forEach((bug, index) => {
        const id = `BUG-0${index + 1}`;
        const node = makeNode(CanvasNodeType.Bug, offsetX - 700 + index * 320, acY + 760, { bugId: id, severity: bug.severity, statement: bug.title });
        nodes.push(node);
        const target = acNodes.find((item) => item.metadata?.acId === bug.violates[0]);
        if (target) connections.push(link(node.id, target.id, "violates"));
        entities.bugs.push({ id, title: bug.title, severity: bug.severity, violates: bug.violates, status: bug.status, fixRunIds: [], nodeId: node.id });
    });

    return { nodes, connections, entities };
}
