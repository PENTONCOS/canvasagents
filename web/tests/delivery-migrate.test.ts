import { describe, expect, test } from "bun:test";

import { migrateDeliveryState } from "@/stores/use-delivery-store";

describe("delivery store 迁移", () => {
    test("v0 缺失实体桶时补空对象", () => {
        const out = migrateDeliveryState({}, 0);
        expect(out.acceptance).toEqual({});
        expect(out.testCases).toEqual({});
        expect(out.bugs).toEqual({});
        expect(out.runs).toEqual({});
        expect(out.environments).toEqual({});
    });

    test("已有实体保留，仅补缺失桶", () => {
        const persisted = { acceptance: { "AC-01": { id: "AC-01" } } };
        const out = migrateDeliveryState(persisted, 0);
        expect((out.acceptance as Record<string, unknown>)["AC-01"]).toBeDefined();
        expect(out.bugs).toEqual({});
    });

    test("非对象输入归一为空结构", () => {
        const out = migrateDeliveryState(null, 0);
        expect(out.acceptance).toEqual({});
        expect(out.environments).toEqual({});
    });
});
