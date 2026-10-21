import { spawn } from "node:child_process";

/**
 * M4: 部署器的最小可信部分。
 *
 * 部署这件事的难点不是「跑一条命令」，而是部署完之后说不清「现在线上是哪一版」。
 * 桥端只负责两件可验证的事：跑命令、探测健康状态。部署历史与回滚目标由前端
 * 按实体记录决定（web/src/lib/delivery/deploy-plan.ts），桥端不替用户「猜」该回哪一版。
 */

export type HealthResult = { ok: boolean; status: number; latencyMs: number; error?: string; checkedAt: string };

export type HealthProbe = (url: string, timeoutMs: number) => Promise<HealthResult>;

/** 默认探针：GET 请求，跟随重定向；5xx/4xx 都算不健康（部署完拿到 404 也是坏的）。 */
export const probeHealth: HealthProbe = async (url, timeoutMs) => {
    const startedAt = Date.now();
    const checkedAt = new Date().toISOString();
    try {
        const response = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
        return { ok: response.status >= 200 && response.status < 400, status: response.status, latencyMs: Date.now() - startedAt, checkedAt };
    } catch (error) {
        return { ok: false, status: 0, latencyMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error), checkedAt };
    }
};

export type DeploymentRecord = { version: string; url: string; deployedAt: string; status: "healthy" | "unhealthy" };

export type CommandResult = { ok: boolean; exitCode: number | null; output: string };

/** 跑部署命令，输出截尾保留（前 8KB + 后 8KB），避免把整段日志塞回浏览器。 */
export async function runCommand(command: string, cwd: string, timeoutMs = 120_000): Promise<CommandResult> {
    return await new Promise((resolve) => {
        const child = spawn(command, { cwd, shell: true, env: process.env });
        let output = "";
        let settled = false;
        const finish = (result: CommandResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish({ ok: false, exitCode: null, output: `${output}\n[timeout] ${timeoutMs}ms` });
        }, timeoutMs);
        child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
        child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
        child.once("error", (error) => finish({ ok: false, exitCode: null, output: `${output}\n${error.message}` }));
        child.once("close", (code) => finish({ ok: code === 0, exitCode: code, output: tail(output) }));
    });
}

function tail(text: string, limit = 16_384): string {
    if (text.length <= limit) return text;
    const half = Math.floor(limit / 2);
    return `${text.slice(0, half)}\n…[truncated]…\n${text.slice(-half)}`;
}

export function deploymentStatus(health: HealthResult): DeploymentRecord["status"] {
    return health.ok ? "healthy" : "unhealthy";
}
