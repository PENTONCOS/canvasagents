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

    // D3: 关联字段（旅程/步骤/用例索引）是后加的，老记录必须能继续读，
    // 否则侧栏/一览在旧数据上会因为 undefined.includes 直接崩。
    test("v3 旧 AC 缺 journeyIds/stepIds/testCaseIds 时补空数组", () => {
        const persisted = { acceptance: { "AC-01": { id: "AC-01", statement: "点击后跳转", status: "draft", nodeId: "n1" } } };
        const out = migrateDeliveryState(persisted, 3);
        const ac = out.acceptance["AC-01"];
        expect(ac.journeyIds).toEqual([]);
        expect(ac.stepIds).toEqual([]);
        expect(ac.testCaseIds).toEqual([]);
        // 原有字段不能被迁移抹掉。
        expect(ac.statement).toBe("点击后跳转");
        expect(ac.nodeId).toBe("n1");
    });

    test("v3 旧用例缺 acId 时归一为空串，非法 selector 被丢弃", () => {
        const persisted = { testCases: { "TC-01": { id: "TC-01", title: "旧用例", selector: 42 } } };
        const out = migrateDeliveryState(persisted, 3);
        const testCase = out.testCases["TC-01"];
        expect(testCase.acId).toBe("");
        expect(testCase.selector).toBeUndefined();
        expect(testCase.title).toBe("旧用例");
    });
});
