/**
 * Agent driver 选择（M5）。前端所有 `/agent/*` 请求都经过这里拼路径，
 * 这样接第二家 CLI 时不需要再改 19 处硬编码。
 *
 * 设计取舍：状态放在模块里而不是 zustand store，是因为 `services/api/canvas-agent.ts`
 * 也被非 React 代码调用；放 store 会引入循环依赖，且取不到 hook 外的最新值。
 */

export type AgentDriverId = "codex" | "claude";

export const AGENT_DRIVER_STORAGE_KEY = "canvasagents.agent.driver";
export const AGENT_DRIVER_IDS: AgentDriverId[] = ["codex", "claude"];

const listeners = new Set<(driver: AgentDriverId) => void>();

function readDriver(): AgentDriverId {
    if (typeof localStorage === "undefined") return "codex";
    const stored = localStorage.getItem(AGENT_DRIVER_STORAGE_KEY);
    return isAgentDriverId(stored) ? stored : "codex";
}

export function isAgentDriverId(value: unknown): value is AgentDriverId {
    return typeof value === "string" && (AGENT_DRIVER_IDS as string[]).includes(value);
}

let current: AgentDriverId = readDriver();

export function getAgentDriver(): AgentDriverId {
    return current;
}

export function setAgentDriver(driver: AgentDriverId) {
    if (driver === current) return;
    current = driver;
    try {
        localStorage.setItem(AGENT_DRIVER_STORAGE_KEY, driver);
    } catch {
        // 隐私模式下 localStorage 会抛；不写也不影响本次会话。
    }
    listeners.forEach((listener) => listener(driver));
}

export function subscribeAgentDriver(listener: (driver: AgentDriverId) => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/**
 * 把 driver 相对路径拼成完整 API 路径。
 * `agentApiPath("/threads")` → `/agent/codex/threads`（当前 driver 决定前缀）。
 */
export function agentApiPath(path: string, driver: AgentDriverId = current): string {
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `/agent/${driver}${suffix}`;
}

export function agentDriverLabel(driver: AgentDriverId): string {
    return driver === "claude" ? "Claude Code" : "Codex";
}
