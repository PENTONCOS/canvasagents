import assert from "node:assert/strict";
import { test } from "node:test";

import { deploymentStatus, probeHealth } from "./deployer.js";

test("健康检查把 2xx/3xx 视为健康，5xx 视为不健康", async () => {
    const healthy = deploymentStatus({ ok: true, status: 200, latencyMs: 1, checkedAt: "" });
    const unhealthy = deploymentStatus({ ok: false, status: 500, latencyMs: 1, checkedAt: "" });
    assert.equal(healthy, "healthy");
    assert.equal(unhealthy, "unhealthy");
});

test("探测不可达地址返回 ok=false 且不抛错", async () => {
    const result = await probeHealth("http://127.0.0.1:9/health", 300);
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
});
