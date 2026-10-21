// M0: agent driver routing (dev plan §1.4). Normalizes `/agent/:driver/*` paths onto the
// existing `/agent/codex/*` handlers so a second driver can register its own prefix later
// without touching the frontend. Pure function so the rewrite rules stay unit-testable.

export const KNOWN_AGENT_DRIVERS = ["codex", "claude"] as const;

export type AgentDriver = (typeof KNOWN_AGENT_DRIVERS)[number];

export function isKnownAgentDriver(value: string): value is AgentDriver {
    return (KNOWN_AGENT_DRIVERS as readonly string[]).includes(value);
}

/**
 * Rewrites `/agent/:driver/...` onto the canonical handler path.
 * - `/agent/codex/threads` → unchanged (canonical already).
 * - `/agent/codex/threads` with driver=codex → `/agent/codex/threads`.
 * - unknown driver → null (caller answers 404 with the driver name).
 * Non `/agent/` paths → null (not our concern).
 */
export function rewriteAgentDriverPath(pathname: string): { driver: AgentDriver; canonicalPath: string } | null {
    const match = /^\/agent\/([^/]+)(\/.*)?$/.exec(pathname);
    if (!match) return null;
    const driver = match[1];
    if (!isKnownAgentDriver(driver)) return null;
    const rest = match[2] ?? "";
    // codex 是历史路径（前端早期全部硬编码），改写保持兼容；
    // 新 driver（claude）有自己的 handler，路径原样保留。
    return { driver, canonicalPath: driver === "codex" ? `/agent/codex${rest}` : pathname };
}
