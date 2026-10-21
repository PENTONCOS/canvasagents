import { describe, expect, test } from "bun:test";

import { planBugsFromAnnotations } from "@/lib/delivery/annotation-bugs";
import type { DeliveryAnnotation } from "@/types/delivery";

function annotation(overrides: Partial<DeliveryAnnotation> & Pick<DeliveryAnnotation, "id">): DeliveryAnnotation {
    return {
        nodeId: "image-1",
        shape: "rect",
        from: { x: 0.1, y: 0.1 },
        to: { x: 0.5, y: 0.5 },
        label: 1,
        createdAt: 1,
        ...overrides,
    };
}

describe("圈注 → 问题单规划", () => {
    test("一条圈注一个 BUG，编号连续分配不撞号", () => {
        const planned = planBugsFromAnnotations([annotation({ id: "AN-01", label: 1 }), annotation({ id: "AN-02", label: 2 })], []);
        expect(planned.map((item) => item.bug.id)).toEqual(["BUG-01", "BUG-02"]);
        expect(planned.map((item) => item.annotationId)).toEqual(["AN-01", "AN-02"]);
    });

    test("接着已有最大号往后排，不复用已删除的号", () => {
        const planned = planBugsFromAnnotations([annotation({ id: "AN-09", label: 9 })], ["BUG-01", "BUG-07"]);
        expect(planned[0].bug.id).toBe("BUG-08");
    });

    test("已生成过问题单的圈注不重复下单", () => {
        const planned = planBugsFromAnnotations([annotation({ id: "AN-01", bugId: "BUG-03" }), annotation({ id: "AN-02", label: 2 })], ["BUG-03"]);
        expect(planned).toHaveLength(1);
        expect(planned[0].annotationId).toBe("AN-02");
        expect(planned[0].bug.id).toBe("BUG-04");
    });

    test("圈注带 AC 时问题单带 violates，标题自动回指 AC", () => {
        const planned = planBugsFromAnnotations([annotation({ id: "AN-03", label: 3, acId: "AC-08" })], []);
        expect(planned[0].bug.violates).toEqual(["AC-08"]);
        expect(planned[0].bug.title).toBe("#3 违反 AC-08");
        expect(planned[0].bug.status).toBe("open");
    });

    test("没有 AC 的圈注不编造 violates", () => {
        const planned = planBugsFromAnnotations([annotation({ id: "AN-04", label: 4 })], []);
        expect(planned[0].bug.violates).toEqual([]);
        expect(planned[0].bug.title).toBe("#4 圈注问题");
    });

    test("有备注时备注即标题", () => {
        const planned = planBugsFromAnnotations([annotation({ id: "AN-05", label: 5, acId: "AC-02", note: "按钮间距不对" })], []);
        expect(planned[0].bug.title).toBe("按钮间距不对");
    });

    test("空输入不产生问题单", () => {
        expect(planBugsFromAnnotations([], ["BUG-01"])).toEqual([]);
    });
});
