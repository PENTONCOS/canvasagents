import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { localForageStorage } from "@/lib/localforage-storage";
import { createTestCaseDraft, withAcRelations } from "@/lib/delivery/ac-testcase";
import { planAcStatusUpdates, type AcResultInput } from "@/lib/delivery/run-results";
import { nextRunStatus } from "@/lib/delivery/run-status";
import {
    transitionAc,
    type AcceptanceCriterion,
    type AcStatus,
    type AcTestLayer,
    type DeliveryBug,
    type DeliveryEnvironment,
    type DeliveryRun,
    type DeliveryRunRound,
    nextAnnotationLabel,
    type DeliveryAnnotation,
    type DeliveryTestCase,
    type DesignVariant,
    type Journey,
    type JourneyStep,
} from "@/types/delivery";

// M0: delivery domain store (dev plan §1.3). Entities are the source of truth;
// canvas nodes are views and reference entities via metadata.acId / bugId / runId.

type DeliveryState = {
    journeys: Record<string, Journey>;
    steps: Record<string, JourneyStep>;
    designs: Record<string, DesignVariant>;
    acceptance: Record<string, AcceptanceCriterion>;
    testCases: Record<string, DeliveryTestCase>;
    bugs: Record<string, DeliveryBug>;
    runs: Record<string, DeliveryRun>;
    environments: Record<string, DeliveryEnvironment>;
    annotations: Record<string, DeliveryAnnotation>;
};

/** 持久化实体桶（partialize 收集的字段），迁移函数的输入/输出形状。 */
type DeliveryPersistedState = Pick<
    DeliveryState,
    "journeys" | "steps" | "designs" | "acceptance" | "testCases" | "bugs" | "runs" | "environments" | "annotations"
>;

type DeliveryActions = {
    upsertJourney: (journey: Journey) => void;
    removeJourney: (id: string) => void;
    upsertStep: (step: JourneyStep) => void;
    removeStep: (id: string) => void;
    upsertDesign: (variant: DesignVariant) => void;
    removeDesign: (id: string) => void;
    /** 选定某版设计：同一旅程其余版本自动取消选定（至多一版选中）。 */
    selectDesign: (id: string) => void;
    upsertAc: (ac: AcceptanceCriterion) => void;
    removeAc: (id: string) => void;
    setAcStatus: (id: string, status: AcStatus, runId?: string) => { ok: boolean; error?: string };
    /** 按测试结果批量回填 AC 状态（失败优先；返回被拒绝的条目，便于提示）。 */
    applyAcResults: (results: AcResultInput[], runId?: string) => { applied: string[]; rejected: { acId: string; reason: string }[] };
    upsertTestCase: (testCase: DeliveryTestCase) => void;
    removeTestCase: (id: string) => void;
    /** D3: 从 AC 直接建用例——锚点与 acId 一起写死，报告才有得回填。 */
    createTestCaseForAc: (acId: string, input: { title: string; file?: string; layer?: AcTestLayer }) => DeliveryTestCase | null;
    /** D3: AC 挂旅程；换旅程时，不属于新旅程的步骤一并摘掉。 */
    setAcJourney: (acId: string, journeyId?: string) => void;
    /** D3: AC 挂步骤；步骤必须存在，并且自动把所属旅程补进 journeyIds。 */
    setAcStep: (acId: string, stepId?: string) => { ok: boolean; error?: string };
    upsertBug: (bug: DeliveryBug) => void;
    removeBug: (id: string) => void;
    setBugStatus: (id: string, status: DeliveryBug["status"]) => void;
    upsertAnnotation: (annotation: DeliveryAnnotation) => void;
    removeAnnotation: (id: string) => void;
    /** 新建圈注：编号在画布内递增，删除中间编号也不复用。 */
    addAnnotation: (input: Omit<DeliveryAnnotation, "id" | "label" | "createdAt">) => DeliveryAnnotation;
    upsertRun: (run: DeliveryRun) => void;
    /** M4: 追加一轮运行记录，并把 run 状态推进到该轮结果。 */
    appendRunRound: (runId: string, round: DeliveryRunRound) => void;
    /**
     * E2: 报告摘要 → 一轮运行 + AC 回填。按 reportId 幂等：
     * 同一份报告重复到达（HTTP 响应与事件流双路径）只累计一轮。
     */
    applyVerifyReport: (input: { runId: string; round: DeliveryRunRound; acResults: AcResultInput[] }) => { applied: boolean; reason?: "no-run" | "duplicate" };
    /** M4: 回放一次历史运行，把当时的测试结果重新回填到 AC 上（不伪造通过）。 */
    replayRun: (runId: string) => { applied: string[]; rejected: { acId: string; reason: string }[] };
    upsertEnvironment: (env: DeliveryEnvironment) => void;
    removeEnvironment: (id: string) => void;
    resetDelivery: () => void;
};

export type DeliveryStore = DeliveryState & DeliveryActions;

const EMPTY_STATE: DeliveryState = {
    journeys: {},
    steps: {},
    designs: {},
    acceptance: {},
    testCases: {},
    bugs: {},
    runs: {},
    environments: {},
    annotations: {},
};

export const useDeliveryStore = create<DeliveryStore>()(
    persist(
        (set, get) => ({
            ...EMPTY_STATE,

            upsertJourney: (journey) =>
                set((state) => ({ journeys: { ...state.journeys, [journey.id]: journey } })),

            removeJourney: (id) =>
                set((state) => {
                    const journeys = { ...state.journeys };
                    delete journeys[id];
                    // 级联删除该旅程下的步骤与设计版本，避免孤儿实体。
                    const steps = Object.fromEntries(Object.entries(state.steps).filter(([, step]) => step.journeyId !== id));
                    const designs = Object.fromEntries(Object.entries(state.designs).filter(([, design]) => design.journeyId !== id));
                    return { journeys, steps, designs };
                }),

            upsertStep: (step) => set((state) => ({ steps: { ...state.steps, [step.id]: step } })),

            removeStep: (id) =>
                set((state) => {
                    const steps = { ...state.steps };
                    delete steps[id];
                    return { steps };
                }),

            upsertDesign: (variant) =>
                set((state) => {
                    const designs = { ...state.designs, [variant.id]: variant };
                    // 新版本若声明选中，同旅程其他版本必须让位。
                    if (variant.selected) {
                        for (const [key, item] of Object.entries(designs)) {
                            if (key !== variant.id && item.journeyId === variant.journeyId && item.selected) {
                                designs[key] = { ...item, selected: false };
                            }
                        }
                    }
                    return { designs };
                }),

            removeDesign: (id) =>
                set((state) => {
                    const designs = { ...state.designs };
                    delete designs[id];
                    return { designs };
                }),

            selectDesign: (id) =>
                set((state) => {
                    const target = state.designs[id];
                    if (!target) return state;
                    const designs: Record<string, DesignVariant> = {};
                    for (const [key, item] of Object.entries(state.designs)) {
                        designs[key] = { ...item, selected: key === id };
                    }
                    return { designs };
                }),

            upsertAc: (ac) =>
                set((state) => ({ acceptance: { ...state.acceptance, [ac.id]: withAcRelations(ac) } })),

            removeAc: (id) =>
                set((state) => {
                    const acceptance = { ...state.acceptance };
                    delete acceptance[id];
                    // Drop test cases anchored to the removed AC so orphans never accumulate.
                    const testCases = Object.fromEntries(
                        Object.entries(state.testCases).filter(([, testCase]) => testCase.acId !== id),
                    );
                    return { acceptance, testCases };
                }),

            setAcStatus: (id, status, runId) => {
                const current = useDeliveryStore.getState().acceptance[id];
                if (!current) return { ok: false, error: `unknown AC ${id}` };
                const result = transitionAc(current.status, status);
                if (!result.ok) return { ok: false, error: result.error };
                set((state) => ({
                    acceptance: {
                        ...state.acceptance,
                        [id]: { ...current, status: result.status, lastRunId: runId ?? current.lastRunId },
                    },
                }));
                return { ok: true };
            },

            applyAcResults: (results, runId) => {
                const { plans, rejected } = planAcStatusUpdates(useDeliveryStore.getState().acceptance, results);
                // 结果先落到 run 上：即使一条 AC 都迁移不了（例如全是 draft→passing 之外的非法迁移），
                // 这次运行跑出来的是什么也必须留下痕迹，否则「回放」会变成回放空数据。
                if (runId) {
                    set((state) => {
                        const run = state.runs[runId];
                        if (!run) return {};
                        return { runs: { ...state.runs, [runId]: { ...run, results: results.map((item) => ({ acId: item.acId, result: item.result })) } } };
                    });
                }
                if (plans.length === 0) {
                    return { applied: [], rejected: rejected.map((item) => ({ acId: item.acId, reason: item.reason })) };
                }
                set((state) => {
                    const acceptance = { ...state.acceptance };
                    for (const plan of plans) {
                        let current = acceptance[plan.acId];
                        for (const step of plan.steps) {
                            const next = transitionAc(current.status, step);
                            if (!next.ok) break;
                            current = { ...current, status: next.status, lastRunId: runId ?? current.lastRunId };
                        }
                        acceptance[plan.acId] = current;
                    }
                    return { acceptance };
                });
                return {
                    applied: plans.flatMap((plan) => plan.steps.map((step) => `${plan.acId}:${step}`)),
                    rejected: rejected.map((item) => ({ acId: item.acId, reason: item.reason })),
                };
            },

            upsertTestCase: (testCase) =>
                set((state) => {
                    const testCases = { ...state.testCases, [testCase.id]: testCase };
                    // testCaseIds 是派生索引：以用例自身的 acId 为准，换 AC 时旧的一边也要摘掉。
                    const acceptance: Record<string, AcceptanceCriterion> = {};
                    for (const [id, ac] of Object.entries(state.acceptance)) {
                        const current = ac.testCaseIds ?? [];
                        const shouldHave = id === testCase.acId;
                        const has = current.includes(testCase.id);
                        if (shouldHave === has) continue;
                        acceptance[id] = {
                            ...ac,
                            testCaseIds: shouldHave ? [...current, testCase.id] : current.filter((item) => item !== testCase.id),
                        };
                    }
                    if (Object.keys(acceptance).length === 0) return { testCases };
                    return { testCases, acceptance: { ...state.acceptance, ...acceptance } };
                }),

            removeTestCase: (id) =>
                set((state) => {
                    const testCases = { ...state.testCases };
                    delete testCases[id];
                    const acceptance = Object.fromEntries(
                        Object.entries(state.acceptance).map(([acId, ac]) => [
                            acId,
                            (ac.testCaseIds ?? []).includes(id)
                                ? { ...ac, testCaseIds: (ac.testCaseIds ?? []).filter((item) => item !== id) }
                                : ac,
                        ]),
                    );
                    return { testCases, acceptance };
                }),

            createTestCaseForAc: (acId, input) => {
                const state = useDeliveryStore.getState();
                if (!state.acceptance[acId]) return null;
                const testCase = createTestCaseDraft({
                    acId,
                    title: input.title,
                    existingIds: Object.keys(state.testCases),
                    file: input.file,
                    layer: input.layer,
                });
                if (!testCase.title) return null;
                state.upsertTestCase(testCase);
                return testCase;
            },

            setAcJourney: (acId, journeyId) =>
                set((state) => {
                    const ac = state.acceptance[acId];
                    if (!ac) return {};
                    const id = journeyId || "";
                    // 换旅程时旧步骤不再属于新旅程，留着会画出「步骤挂错旅程」的错数据。
                    const stepIds = (ac.stepIds ?? []).filter((stepId) => {
                        const step = state.steps[stepId];
                        return Boolean(step) && (!id || step.journeyId === id);
                    });
                    return { acceptance: { ...state.acceptance, [acId]: { ...ac, journeyIds: id ? [id] : [], stepIds } } };
                }),

            setAcStep: (acId, stepId) => {
                const state = useDeliveryStore.getState();
                const ac = state.acceptance[acId];
                if (!ac) return { ok: false, error: `unknown AC ${acId}` };
                if (!stepId) {
                    set((current) => ({ acceptance: { ...current.acceptance, [acId]: { ...current.acceptance[acId], stepIds: [] } } }));
                    return { ok: true };
                }
                const step = state.steps[stepId];
                if (!step) return { ok: false, error: `unknown step ${stepId}` };
                set((current) => ({
                    acceptance: {
                        ...current.acceptance,
                        [acId]: { ...current.acceptance[acId], stepIds: [stepId], journeyIds: step.journeyId ? [step.journeyId] : [] },
                    },
                }));
                return { ok: true };
            },

            upsertBug: (bug) => set((state) => ({ bugs: { ...state.bugs, [bug.id]: bug } })),

            removeBug: (id) =>
                set((state) => {
                    const bugs = { ...state.bugs };
                    delete bugs[id];
                    return { bugs };
                }),

            setBugStatus: (id, status) =>
                set((state) => {
                    const bug = state.bugs[id];
                    if (!bug) return state;
                    return { bugs: { ...state.bugs, [id]: { ...bug, status } } };
                }),

            upsertAnnotation: (annotation) =>
                set((state) => ({ annotations: { ...state.annotations, [annotation.id]: annotation } })),

            removeAnnotation: (id) =>
                set((state) => {
                    const annotations = { ...state.annotations };
                    delete annotations[id];
                    return { annotations };
                }),

            addAnnotation: (input) => {
                const label = nextAnnotationLabel(Object.values(useDeliveryStore.getState().annotations).map((item) => item.label));
                const annotation: DeliveryAnnotation = {
                    ...input,
                    id: `AN-${String(label).padStart(2, "0")}`,
                    label,
                    createdAt: Date.now(),
                };
                set((state) => ({ annotations: { ...state.annotations, [annotation.id]: annotation } }));
                return annotation;
            },

            upsertRun: (run) => set((state) => ({ runs: { ...state.runs, [run.id]: run } })),

            appendRunRound: (runId, round) =>
                set((state) => {
                    const run = state.runs[runId];
                    if (!run) return {};
                    const rounds = [...(run.rounds || []), round];
                    // 状态推导集中到 nextRunStatus：skipped（无锚点）不再冒充 failed。
                    const status = nextRunStatus(rounds);
                    return {
                        runs: {
                            ...state.runs,
                            [runId]: { ...run, rounds, status, finishedAt: round.finishedAt || run.finishedAt },
                        },
                    };
                }),

            applyVerifyReport: ({ runId, round, acResults }) => {
                const run = useDeliveryStore.getState().runs[runId];
                if (!run) return { applied: false, reason: "no-run" };
                // 双路径（HTTP 响应 / SSE 事件）会送来同一份报告；reportId 相同就只记一轮。
                if (round.reportId && (run.rounds || []).some((item) => item.reportId === round.reportId)) {
                    return { applied: false, reason: "duplicate" };
                }
                get().appendRunRound(runId, round);
                get().applyAcResults(acResults, runId);
                return { applied: true };
            },

            replayRun: (runId) => {
                const run = get().runs[runId];
                if (!run) return { applied: [], rejected: [{ acId: "-", reason: "run not found" }] };
                const results: AcResultInput[] = run.results
                    .filter((item) => Boolean(item.acId))
                    .map((item) => ({ acId: item.acId as string, result: item.result }));
                return get().applyAcResults(results, runId);
            },

            upsertEnvironment: (env) =>
                set((state) => ({ environments: { ...state.environments, [env.id]: env } })),

            removeEnvironment: (id) =>
                set((state) => {
                    const environments = { ...state.environments };
                    delete environments[id];
                    return { environments };
                }),

            resetDelivery: () => set({ ...EMPTY_STATE }),
        }),
        {
            name: "delivery-store",
            version: 4,
            migrate: migrateDeliveryState,
            storage: createJSONStorage(() => localForageStorage),
            // Persist entities only; actions are rebuilt on hydration.
            partialize: (state) => ({
                journeys: state.journeys,
                steps: state.steps,
                designs: state.designs,
                acceptance: state.acceptance,
                testCases: state.testCases,
                bugs: state.bugs,
                runs: state.runs,
                environments: state.environments,
                annotations: state.annotations,
            }),
        },
    ),
);

/** 交付域持久化迁移：旧版本缺实体桶时补空对象，避免 hydrate 后字段为 undefined。 */
export function migrateDeliveryState(persisted: unknown, version: number) {
    const base = (persisted && typeof persisted === "object"? persisted: {}) as Record<string, unknown>;
    for (const key of ["journeys", "steps", "designs", "acceptance", "testCases", "bugs", "runs", "environments", "annotations"]) {
        if (!base[key] || typeof base[key]!== "object") base[key] = {};
    }
    // D3（v4）：AC 的旅程/步骤/用例索引与用例的 acId 都是新加的关联字段，
    // 老记录上缺这些字段也要能正常读（否则 `.includes` 会在旧数据上直接抛错）。
    const acceptance = base.acceptance as Record<string, Record<string, unknown>>;
    for (const ac of Object.values(acceptance)) {
        if (!ac || typeof ac !== "object") continue;
        for (const key of ["journeyIds", "stepIds", "testCaseIds"]) {
            if (!Array.isArray(ac[key])) ac[key] = [];
        }
    }
    const testCases = base.testCases as Record<string, Record<string, unknown>>;
    for (const testCase of Object.values(testCases)) {
        if (!testCase || typeof testCase !== "object") continue;
        if (typeof testCase.acId !== "string") testCase.acId = "";
        if (testCase.selector !== undefined && typeof testCase.selector !== "string") delete testCase.selector;
    }
    void version;
    return base as DeliveryPersistedState;
}
