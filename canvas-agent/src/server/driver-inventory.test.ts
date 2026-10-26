import assert from "node:assert/strict";
import { test } from "node:test";

import { driverInventory } from "../agent/driver-inventory.js";

test("driver 清单：codex / claude / opencode 都在，字段完整", () => {
    const entries = driverInventory();
    const ids = entries.map((entry) => entry.id);
    assert.deepEqual(ids, ["codex", "claude", "opencode"]);
    for (const entry of entries) {
        assert.equal(typeof entry.label, "string");
        assert.equal(typeof entry.available, "boolean");
        // 没装 CLI 时必须带原因，装了必须带版本——不能两个都空。
        if (entry.available) assert.ok(entry.version && entry.version.length > 0, `${entry.id} 可用但没有版本号`);
        else assert.ok(entry.error && entry.error.length > 0, `${entry.id} 不可用但没有原因`);
    }
});

test("driver 清单：探测结果稳定，多次调用不抛", () => {
    const first = driverInventory();
    const second = driverInventory();
    assert.deepEqual(first.map((entry) => entry.id), second.map((entry) => entry.id));
});
