import { describe, expect, test } from "bun:test";

import { annotationBugTitle, annotationRect, clampNormalized, nextAnnotationLabel } from "@/types/delivery";

describe("圈注几何", () => {
    test("归一化坐标钳到 0..1，非法值归零", () => {
        expect(clampNormalized(-0.4)).toBe(0);
        expect(clampNormalized(1.7)).toBe(1);
        expect(clampNormalized(Number.NaN)).toBe(0);
        expect(clampNormalized(0.25)).toBe(0.25);
    });

    test("反向拖拽也得到非负宽高（右下 → 左上）", () => {
        const rect = annotationRect({ from: { x: 0.8, y: 0.6 }, to: { x: 0.2, y: 0.1 } }, { width: 400, height: 200 });
        expect(rect).toEqual({ x: 80, y: 20, width: 240, height: 100 });
    });

    test("整张图圈注覆盖全尺寸", () => {
        const rect = annotationRect({ from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, { width: 300, height: 150 });
        expect(rect).toEqual({ x: 0, y: 0, width: 300, height: 150 });
    });

    test("越界坐标先钳位再算尺寸，矩形不会跑到图外", () => {
        const rect = annotationRect({ from: { x: -1, y: -1 }, to: { x: 2, y: 2 } }, { width: 100, height: 100 });
        expect(rect).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    });
});

describe("圈注编号", () => {
    test("空列表从 1 开始", () => {
        expect(nextAnnotationLabel([])).toBe(1);
    });

    test("删除中间编号后不复用（避免截图数字与单号错位）", () => {
        expect(nextAnnotationLabel([1, 3])).toBe(4);
    });

    test("忽略非法值", () => {
        expect(nextAnnotationLabel([Number.NaN, 2])).toBe(3);
    });
});

describe("由圈注生成问题单标题", () => {
    test("有备注用备注", () => {
        expect(annotationBugTitle({ label: 2, acId: "AC-08", note: "按钮点击无响应" })).toBe("按钮点击无响应");
    });

    test("没备注时带上违反的 AC，保证可追溯", () => {
        expect(annotationBugTitle({ label: 2, acId: "AC-08" })).toBe("#2 违反 AC-08");
    });

    test("既没备注也没 AC 时仍给编号", () => {
        expect(annotationBugTitle({ label: 5 })).toBe("#5 圈注问题");
    });
});
