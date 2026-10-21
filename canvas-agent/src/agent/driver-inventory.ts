import { spawnSync } from "node:child_process";

/** 一个 agent driver 的可用性，供前端 driver 切换器显示。 */
export type DriverInventoryEntry = {
    id: string;
    label: string;
    /** CLI 是否可执行；false 时前端应给出「未安装」而不是静默失败。 */
    available: boolean;
    version?: string;
    error?: string;
};

const DRIVERS: Array<{ id: string; label: string; bin: string; args: string[] }> = [
    { id: "codex", label: "Codex", bin: "codex", args: ["--version"] },
    { id: "claude", label: "Claude Code", bin: "claude", args: ["--version"] },
];

/**
 * 探测本机装了哪些 agent CLI。用 spawnSync 而不是 which，是因为 Windows 上 which 不可用，
 * 而 spawnSync 天然带回退出码。探测失败一律返回 available:false + 原因，不抛。
 */
export function driverInventory(): DriverInventoryEntry[] {
    return DRIVERS.map((driver) => {
        try {
            const result = spawnSync(driver.bin, driver.args, { encoding: "utf8", timeout: 5000, shell: process.platform === "win32", windowsHide: true });
            if (result.error) return { id: driver.id, label: driver.label, available: false, error: result.error.message };
            if (result.status !== 0) return { id: driver.id, label: driver.label, available: false, error: (result.stderr || result.stdout || "").trim().slice(0, 200) || `exit ${result.status}` };
            return { id: driver.id, label: driver.label, available: true, version: (result.stdout || "").trim().split(/\r?\n/)[0].slice(0, 120) };
        } catch (error) {
            return { id: driver.id, label: driver.label, available: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
}
