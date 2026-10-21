import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { localForageStorage } from "@/lib/localforage-storage";
import {
    transitionAc,
    type AcceptanceCriterion,
    type AcStatus,
    type DeliveryBug,
    type DeliveryEnvironment,
    type DeliveryRun,
    type DeliveryTestCase,
} from "@/types/delivery";

// M0: delivery domain store (dev plan §1.3). Entities are the source of truth;
// canvas nodes are views and reference entities via metadata.acId / bugId / runId.

type DeliveryState = {
    acceptance: Record<string, AcceptanceCriterion>;
    testCases: Record<string, DeliveryTestCase>;
    bugs: Record<string, DeliveryBug>;
    runs: Record<string, DeliveryRun>;
    environments: Record<string, DeliveryEnvironment>;
};

/** 持久化实体桶（partialize 收集的字段），迁移函数的输入/输出形状。 */
type DeliveryPersistedState = Pick<DeliveryState, "acceptance" | "testCases" | "bugs" | "runs" | "environments">;

type DeliveryActions = {
    upsertAc: (ac: AcceptanceCriterion) => void;
    removeAc: (id: string) => void;
    setAcStatus: (id: string, status: AcStatus, runId?: string) => { ok: boolean; error?: string };
    upsertTestCase: (testCase: DeliveryTestCase) => void;
    removeTestCase: (id: string) => void;
    upsertBug: (bug: DeliveryBug) => void;
    removeBug: (id: string) => void;
    setBugStatus: (id: string, status: DeliveryBug["status"]) => void;
    upsertRun: (run: DeliveryRun) => void;
    upsertEnvironment: (env: DeliveryEnvironment) => void;
    removeEnvironment: (id: string) => void;
    resetDelivery: () => void;
};

export type DeliveryStore = DeliveryState & DeliveryActions;

const EMPTY_STATE: DeliveryState = {
    acceptance: {},
    testCases: {},
    bugs: {},
    runs: {},
    environments: {},
};

export const useDeliveryStore = create<DeliveryStore>()(
    persist(
        (set) => ({
            ...EMPTY_STATE,

            upsertAc: (ac) =>
                set((state) => ({ acceptance: { ...state.acceptance, [ac.id]: ac } })),

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

            upsertTestCase: (testCase) =>
                set((state) => ({ testCases: { ...state.testCases, [testCase.id]: testCase } })),

            removeTestCase: (id) =>
                set((state) => {
                    const testCases = { ...state.testCases };
                    delete testCases[id];
                    return { testCases };
                }),

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

            upsertRun: (run) => set((state) => ({ runs: { ...state.runs, [run.id]: run } })),

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
            version: 1,
            migrate: migrateDeliveryState,
            storage: createJSONStorage(() => localForageStorage),
            // Persist entities only; actions are rebuilt on hydration.
            partialize: (state) => ({
                acceptance: state.acceptance,
                testCases: state.testCases,
                bugs: state.bugs,
                runs: state.runs,
                environments: state.environments,
            }),
        },
    ),
);

/** 交付域持久化迁移：旧版本缺实体桶时补空对象，避免 hydrate 后字段为 undefined。 */
export function migrateDeliveryState(persisted: unknown, version: number) {
    const base = (persisted && typeof persisted === "object"? persisted: {}) as Record<string, unknown>;
    for (const key of ["acceptance", "testCases", "bugs", "runs", "environments"]) {
        if (!base[key] || typeof base[key]!== "object") base[key] = {};
    }
    void version;
    return base as DeliveryPersistedState;
}
