import { APP_ID } from "@/constant/brand";
import { randomId } from "@/lib/utils";

/**
 * 一个页面会话内稳定的 Agent 客户端 id。
 *
 * 队列视图（挂在 layout 上，不在面板里）也要能发起「继续」，而桥端 `/turn` 认这个 id
 * 判断「发起任务的网页还在不在」。所以身份获取从面板里抽出来共用一份，
 * 而不是队列自己另起一套 id —— 两套 id 会让桥端以为任务来自两个客户端。
 */

type AgentClientGlobal = typeof globalThis & { __canvasAgentsClientIdPromise?: Promise<string> };

const CLIENT_ID_STORAGE_KEY = "canvas-agent-client-id";

function readAgentClientId() {
    try {
        return sessionStorage.getItem(CLIENT_ID_STORAGE_KEY) || "";
    } catch {
        // 隐私模式下 sessionStorage 会抛；退化成纯内存身份，不影响本次会话。
        return "";
    }
}

function saveAgentClientId(clientId: string) {
    try {
        sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, clientId);
    } catch {
        // The in-memory identity still keeps request ownership consistent within the current page session.
    }
}

export function acquireAgentClientId(): Promise<string> {
    const scope = globalThis as AgentClientGlobal;
    scope.__canvasAgentsClientIdPromise ||= (async () => {
        const storedClientId = readAgentClientId();
        let clientId = storedClientId || randomId();
        if (!navigator.locks) {
            if (!storedClientId) saveAgentClientId(clientId);
            return clientId;
        }
        while (true) {
            const acquired = await new Promise<boolean>((resolve, reject) => {
                void navigator.locks.request(`${APP_ID}-agent:${clientId}`, { ifAvailable: true }, async (lock) => {
                    if (!lock) return resolve(false);
                    resolve(true);
                    await new Promise<void>(() => undefined);
                }).catch(reject);
            });
            if (acquired) {
                saveAgentClientId(clientId);
                return clientId;
            }
            clientId = randomId();
        }
    })().catch(() => {
        const clientId = randomId();
        saveAgentClientId(clientId);
        return clientId;
    });
    return scope.__canvasAgentsClientIdPromise;
}
