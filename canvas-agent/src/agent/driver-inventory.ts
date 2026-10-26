import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    { id: "opencode", label: "OpenCode", bin: "opencode", args: ["--version"] },
];

/**
 * 探测本机装了哪些 agent CLI。用 spawnSync 而不是 which，是因为 Windows 上 which 不可用，
 * 而 spawnSync 天然带回退出码。探测失败一律返回 available:false + 原因，不抛。
 */
/**
 * launchd / 双击启动的进程往往拿不到登录 shell 的 PATH，
 * 于是 spawnSync("codex") 直接 ENOENT，界面上就把装好的 CLI 显示成「未安装」。
 * 这里按 PATH + 常见安装目录解析一次绝对路径，再交给 spawnSync。
 */
function resolveBin(bin: string): string {
    if (bin.includes("/")) return bin;
    const extra = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", path.join(os.homedir(), ".bun", "bin"), path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".opencode", "bin")];
    const dirs = [...(process.env.PATH || "").split(path.delimiter), ...extra].filter(Boolean);
    for (const dir of dirs) {
        const candidate = path.join(dir, bin);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch {
            // 继续找下一个目录；找不到就退回裸命令名，让 spawnSync 给出原始错误。
        }
    }
    return bin;
}

export function driverInventory(): DriverInventoryEntry[] {
    return DRIVERS.map((driver) => {
        try {
            const result = spawnSync(resolveBin(driver.bin), driver.args, { encoding: "utf8", timeout: 5000, shell: process.platform === "win32", windowsHide: true });
            if (result.error) return { id: driver.id, label: driver.label, available: false, error: result.error.message };
            if (result.status !== 0) return { id: driver.id, label: driver.label, available: false, error: (result.stderr || result.stdout || "").trim().slice(0, 200) || `exit ${result.status}` };
            return { id: driver.id, label: driver.label, available: true, version: (result.stdout || "").trim().split(/\r?\n/)[0].slice(0, 120) };
        } catch (error) {
            return { id: driver.id, label: driver.label, available: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
}
