import { describe, expect, test } from "bun:test";

import { canDeleteGroup, groupCanvases, planProjectGroups, resolveActiveGroupId, type CanvasProjectGroup } from "../src/lib/canvas/canvas-projects";

const now = "2026-10-24T02:00:00.000Z";

function group(id: string, title = id): CanvasProjectGroup {
    return { id, title, createdAt: now, updatedAt: now };
}

function canvas(id: string, groupId?: string) {
    // nodes / chatSessions 用真实结构里的字段，验证迁移不会碰到画布内容
    return { id, groupId, title: id, nodes: [{ id: `${id}-node` }], chatSessions: [{ id: `${id}-s` }] };
}

function options(prefix = "new") {
    let seq = 0;
    return { now, defaultTitle: "默认项目", newId: () => `${prefix}-${++seq}` };
}

describe("planProjectGroups 迁移", () => {
    test("没有画布也没有项目时不凭空造项目", () => {
        const plan = planProjectGroups([], [], options());
        expect(plan.groups).toEqual([]);
        expect(plan.canvases).toEqual([]);
        expect(plan.createdGroupId).toBeNull();
    });

    test("有画布但没有任何项目时新建默认项目，所有画布归入其中", () => {
        const plan = planProjectGroups([canvas("c1"), canvas("c2")], [], options());
        expect(plan.groups).toHaveLength(1);
        expect(plan.groups[0].title).toBe("默认项目");
        expect(plan.createdGroupId).toBe(plan.groups[0].id);
        expect(plan.canvases.map((item) => item.groupId)).toEqual([plan.groups[0].id, plan.groups[0].id]);
    });

    test("已有项目时，缺 groupId 的画布归入第一个项目，不再造新项目", () => {
        const plan = planProjectGroups([canvas("c1")], [group("g1", "一号"), group("g2", "二号")], options());
        expect(plan.groups).toHaveLength(2);
        expect(plan.createdGroupId).toBeNull();
        expect(plan.canvases[0].groupId).toBe("g1");
    });

    test("groupId 指向不存在的项目时同样归入第一个项目", () => {
        const plan = planProjectGroups([canvas("c1", "ghost")], [group("g1")], options());
        expect(plan.canvases[0].groupId).toBe("g1");
    });

    test("全部合法时原样返回画布数组，不做无意义重写", () => {
        const canvases = [canvas("c1", "g1"), canvas("c2", "g2")];
        const plan = planProjectGroups(canvases, [group("g1"), group("g2")], options());
        expect(plan.canvases).toBe(canvases);
        expect(plan.createdGroupId).toBeNull();
    });

    test("迁移只改 groupId，画布里的节点与会话原样保留", () => {
        const plan = planProjectGroups([canvas("c1")], [group("g1")], options());
        expect(plan.canvases[0].nodes).toEqual([{ id: "c1-node" }]);
        expect(plan.canvases[0].chatSessions).toEqual([{ id: "c1-s" }]);
        expect(plan.canvases[0].title).toBe("c1");
    });

    test("重复项目 id 只留第一个，空 id 丢弃，空标题用默认标题补齐", () => {
        const plan = planProjectGroups([], [group("g1", "一号"), group("g1", "重复"), group("", "空"), group("g2", "  ")], options());
        expect(plan.groups.map((item) => item.id)).toEqual(["g1", "g2"]);
        expect(plan.groups[0].title).toBe("一号");
        expect(plan.groups[1].title).toBe("默认项目");
    });
});

describe("groupCanvases 分桶", () => {
    test("按项目顺序分组，空项目保留在结果里", () => {
        const { buckets, orphans } = groupCanvases([canvas("c1", "g2"), canvas("c2", "g1")], [group("g1"), group("g2"), group("g3")]);
        expect(buckets.map((bucket) => bucket.group.id)).toEqual(["g1", "g2", "g3"]);
        expect(buckets[0].canvases.map((item) => item.id)).toEqual(["c2"]);
        expect(buckets[1].canvases.map((item) => item.id)).toEqual(["c1"]);
        expect(buckets[2].canvases).toEqual([]);
        expect(orphans).toEqual([]);
    });

    test("不属于任何项目的画布单独返回，不会被静默丢掉", () => {
        const { buckets, orphans } = groupCanvases([canvas("c1", "g1"), canvas("c2", "ghost")], [group("g1")]);
        expect(buckets[0].canvases.map((item) => item.id)).toEqual(["c1"]);
        expect(orphans.map((item) => item.id)).toEqual(["c2"]);
    });
});

describe("canDeleteGroup 删除守卫", () => {
    test("项目里还有画布时不允许删", () => {
        expect(canDeleteGroup([canvas("c1", "g1")], "g1")).toBe(false);
    });

    test("空项目可以删", () => {
        expect(canDeleteGroup([canvas("c1", "g2")], "g1")).toBe(true);
    });
});

describe("resolveActiveGroupId", () => {
    const groups = [group("g1"), group("g2")];

    test("优先用户选中的项目", () => {
        expect(resolveActiveGroupId(groups, "g2", "g1")).toBe("g2");
    });

    test("选中项目已被删时退回当前画布所属项目", () => {
        expect(resolveActiveGroupId(groups, "gone", "g2")).toBe("g2");
    });

    test("两者都失效时退回第一个项目，一个都没有则返回 null", () => {
        expect(resolveActiveGroupId(groups, null, null)).toBe("g1");
        expect(resolveActiveGroupId([], "gone", "gone")).toBeNull();
    });
});
