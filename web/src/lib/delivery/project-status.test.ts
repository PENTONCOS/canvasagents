import { describe, expect, it } from "bun:test";

import { addCounts, summarizeProjectTasks } from "./project-status";
import type { CanvasNodeData } from "@/types/canvas";
import type { AcceptanceCriterion, AcStatus } from "@/types/delivery";

function ac(id: string, status: AcStatus): AcceptanceCriterion {
    return {
        id,
        statement: `statement ${id}`,
        status,
        journeyIds: [],
        stepIds: [],
    } as AcceptanceCriterion;
}

function node(id: string, acId?: string): CanvasNodeData {
    return {
        id,
        type: "acceptance",
        title: id,
        position: { x: 0, y: 0 },
        width: 100,
        height: 100,
        metadata: acId ? { acId } : undefined,
    };
}

describe("summarizeProjectTasks", () => {
    it("按 AC 状态分成 已完成 / 进行中 / 待办", () => {
        const counts = summarizeProjectTasks(
            [node("n1", "AC-01"), node("n2", "AC-02"), node("n3", "AC-03")],
            { "AC-01": ac("AC-01", "passing"), "AC-02": ac("AC-02", "failing"), "AC-03": ac("AC-03", "ready") },
        );
        expect(counts).toEqual({ done: 1, doing: 1, todo: 1, total: 3 });
    });

    it("同一个 AC 挂了两张卡片只算一件事", () => {
        const counts = summarizeProjectTasks([node("n1", "AC-09"), node("n2", "AC-09")], { "AC-09": ac("AC-09", "passing") });
        expect(counts).toEqual({ done: 1, doing: 0, todo: 0, total: 1 });
    });

    it("节点引用了不存在的 AC 时算待办，不能静默丢掉", () => {
        const counts = summarizeProjectTasks([node("n1", "AC-404")], {});
        expect(counts).toEqual({ done: 0, doing: 0, todo: 1, total: 1 });
    });

    it("blocked 算进行中（验证过但没过），draft 算待办", () => {
        const counts = summarizeProjectTasks([node("n1", "AC-01"), node("n2", "AC-02")], {
            "AC-01": ac("AC-01", "blocked"),
            "AC-02": ac("AC-02", "draft"),
        });
        expect(counts).toEqual({ done: 0, doing: 1, todo: 1, total: 2 });
    });

    it("没有 AC 节点的画布全 0", () => {
        expect(summarizeProjectTasks([node("n1")], {})).toEqual({ done: 0, doing: 0, todo: 0, total: 0 });
    });
});

describe("addCounts", () => {
    it("逐项相加", () => {
        expect(addCounts({ done: 1, doing: 2, todo: 3, total: 6 }, { done: 1, doing: 0, todo: 1, total: 2 })).toEqual({ done: 2, doing: 2, todo: 4, total: 8 });
    });
});
