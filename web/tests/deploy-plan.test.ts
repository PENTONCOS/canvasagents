import { describe, expect, test } from "bun:test";

import { applyDeployment, DEPLOY_HISTORY_LIMIT, planRollback, pushDeployment } from "@/lib/delivery/deploy-plan";
import type { DeploymentRecord } from "@/types/delivery";

function record(version: string): DeploymentRecord {
    return { version, url: `https://${version}.example.com`, deployedAt: `2026-10-2${version.slice(1)}T00:00:00.000Z`, status: "healthy" };
}

describe("部署历史与回滚", () => {
    test("新部署排在最前", () => {
        expect(pushDeployment([record("v1")], record("v2")).map((item) => item.version)).toEqual(["v2", "v1"]);
    });

    test("历史无界增长会被截断", () => {
        const many = Array.from({ length: DEPLOY_HISTORY_LIMIT + 5 }, (_, index) => record(`v${index}`));
        expect(pushDeployment(many, record("new"))).toHaveLength(DEPLOY_HISTORY_LIMIT);
    });

    test("回滚把上一条换到队首，再回滚能回到刚才那版", () => {
        const first = planRollback([record("v3"), record("v2"), record("v1")]);
        expect(first.previous?.version).toBe("v2");
        expect(first.nextHistory.map((item) => item.version)).toEqual(["v2", "v3", "v1"]);
        const second = planRollback(first.nextHistory);
        expect(second.previous?.version).toBe("v3");
    });

    test("没有上一条时拒绝回滚，不假装成功", () => {
        expect(planRollback([record("v1")]).previous).toBeUndefined();
        expect(planRollback(undefined).error).toBeTruthy();
    });

    test("部署成功写回环境字段并保留历史", () => {
        const applied = applyDeployment({ history: [record("v1")] }, { version: "v2", url: "https://staging.example.com", status: "healthy", deployedAt: "2026-10-21T10:00:00.000Z" });
        expect(applied.version).toBe("v2");
        expect(applied.status).toBe("healthy");
        expect(applied.history.map((item) => item.version)).toEqual(["v2", "v1"]);
    });

    test("部署失败也留痕，状态是 unhealthy", () => {
        const applied = applyDeployment({}, { version: "v2", url: "https://x.example.com", status: "unhealthy" });
        expect(applied.history[0].status).toBe("unhealthy");
        expect(applied.history).toHaveLength(1);
    });
});
