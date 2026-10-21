import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 把「store 动作 × UI 入口」对照接进单测门禁。
 *
 * 光有脚本没人跑等于没有：`renameWindow` 就是这么躺在 store 里好几天，
 * 界面上一个入口都没有，而 tsc / build / 293 条单测全都通过。
 */
test("store 的每个动作，界面上都有入口（或明确标注为内部专用）", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const result = spawnSync("node", ["scripts/agent-action-coverage.mjs"], { cwd: root, encoding: "utf8" });
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    expect(result.status, `动作覆盖检查失败：\n${output}`).toBe(0);
});

test("覆盖检查真的会拦住「有实现没入口」的动作", async () => {
    // 反向验证：如果脚本对缺失动作也报通过，那它就只是个安慰剂。
    const { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const script = readFileSync(join(root, "scripts/agent-action-coverage.mjs"), "utf8");
    const sandbox = mkdtempSync(join(tmpdir(), "action-coverage-"));
    try {
        mkdirSync(join(sandbox, "scripts"), { recursive: true });
        mkdirSync(join(sandbox, "src/stores"), { recursive: true });
        mkdirSync(join(sandbox, "src/components"), { recursive: true });
        mkdirSync(join(sandbox, "src/pages"), { recursive: true });
        writeFileSync(join(sandbox, "scripts/agent-action-coverage.mjs"), script);
        // 一个动作有 UI 引用，另一个没有——后者必须让脚本退出码非 0。
        writeFileSync(join(sandbox, "src/stores/use-agent-store.ts"), "type AgentStore = {\n    usedAction: () => void;\n    orphanAction: () => void;\n};\n");
        writeFileSync(join(sandbox, "src/components/panel.tsx"), "export const x = useAgentStore((state) => state.usedAction);\n");

        const result = spawnSync("node", ["scripts/agent-action-coverage.mjs"], { cwd: sandbox, encoding: "utf8" });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain("orphanAction");
        expect(result.stdout).not.toContain("✗ usedAction");
    } finally {
        rmSync(sandbox, { recursive: true, force: true });
    }
});
