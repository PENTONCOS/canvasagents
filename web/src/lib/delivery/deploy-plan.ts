import type { DeploymentRecord } from "@/types/delivery";

/**
 * M4: 部署历史与回滚目标（纯函数）。
 *
 * 关键约定：history 队首永远是「当前线上版本」。回滚不是删除记录，
 * 而是把上一条换到队首——这样再回滚一次还能回到刚才那版，符合人的直觉。
 * 桥端只负责跑命令和探测健康状态，不参与「该回哪一版」的判断。
 */

export const DEPLOY_HISTORY_LIMIT = 10;

export function pushDeployment(history: DeploymentRecord[] | undefined, record: DeploymentRecord, limit = DEPLOY_HISTORY_LIMIT): DeploymentRecord[] {
    return [record, ...(history || [])].slice(0, limit);
}

export function planRollback(history: DeploymentRecord[] | undefined): { previous?: DeploymentRecord; nextHistory: DeploymentRecord[]; error?: string } {
    const list = history || [];
    if (list.length < 2) return { nextHistory: list, error: "no previous version" };
    const [current, previous, ...rest] = list;
    return { previous, nextHistory: [previous, current, ...rest] };
}

/** 部署后写回环境的字段：URL/版本/状态/时间/history 一起更新，避免各处拼装。 */
export function applyDeployment(
    env: { history?: DeploymentRecord[] },
    input: { version: string; url: string; status: "healthy" | "unhealthy"; deployedAt?: string },
): { version: string; url: string; status: "healthy" | "unhealthy"; deployedAt: string; history: DeploymentRecord[] } {
    const deployedAt = input.deployedAt || new Date().toISOString();
    const record: DeploymentRecord = { version: input.version, url: input.url, deployedAt, status: input.status };
    return { version: input.version, url: input.url, status: input.status, deployedAt, history: pushDeployment(env.history, record) };
}
