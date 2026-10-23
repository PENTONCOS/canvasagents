// G3: 环境节点的持续健康探测（纯函数，浏览器 fetch 由组件注入）。
//
// 约定：
// - 探测目标只有一个来源：buildHealthUrl（127.0.0.1 + port + healthPath，缺省 "/"），
//   这里只负责「端口从哪来」和「结果怎么落到状态」，不另写一套 URL 拼装。
// - 超时同样复用 SERVICE_PROBE_TIMEOUT_MS，避免两处超时语义漂移。
// - 写入 metadata 的结果必须是可向后兼容的形状：旧节点没有 envHealth 字段时读出来是 null，
//   不抛错、不把状态伪造成 healthy。
import { SERVICE_DEFAULT_HEALTH_PATH, SERVICE_PROBE_TIMEOUT_MS, buildHealthUrl, normalizePort } from "@/lib/canvas/service-node-utils";

/** 面板打开期间的轮询间隔；面板关闭（组件卸载）即停。 */
export const ENV_PROBE_INTERVAL_MS = 30_000;

export const ENV_HEALTH_STATUSES = ["probing", "healthy", "unhealthy"] as const;
export type EnvHealthStatus = (typeof ENV_HEALTH_STATUSES)[number];

/** 一次探测的最终结果；checkedAt 用 ISO 字符串，和部署时间同一套格式。 */
export type EnvHealthSnapshot = {
    status: EnvHealthStatus;
    httpStatus?: number;
    checkedAt: string;
    error?: string;
};

/** 探测目标：port 为 null 表示「没法探测」（没端口），url 为空串。 */
export type EnvProbeTarget = { port: number | null; healthPath: string; url: string };

/** metadata 里与健康探测相关的字段；用 unknown 接收，旧数据/脏数据都能安全读。 */
export type EnvProbeMetadata = {
    url?: unknown;
    envHealthPort?: unknown;
    envHealthPath?: unknown;
    envHealth?: unknown;
};

/** 失败原因分类：让组件能翻成中英文，而不是把 "AbortError" 直接甩给用户。 */
export type ProbeFailure = "no-target" | "timeout" | "network" | "aborted";

export type ProbeOutcome = {
    checkedAt: string;
    httpStatus?: number;
    error?: string;
    failure?: ProbeFailure;
};

export type ProbeFetch = (url: string, init: { cache: "no-store"; mode?: "cors" | "no-cors"; signal: AbortSignal }) => Promise<{ status: number }>;

// 与 StatusColor 相同的三态语义：灰=探测中，绿=健康，红=异常。
export const ENV_HEALTH_COLOR: Record<EnvHealthStatus, string> = {
    probing: "#a8a29e",
    healthy: "#22c55e",
    unhealthy: "#ef4444",
};

const ENV_HEALTH_LABEL_KEY: Record<EnvHealthStatus, string> = {
    probing: "canvas.node.delivery.envHealth.probing",
    healthy: "canvas.node.delivery.envHealth.healthy",
    unhealthy: "canvas.node.delivery.envHealth.unhealthy",
};

export function envHealthLabelKey(status: EnvHealthStatus): string {
    return ENV_HEALTH_LABEL_KEY[status];
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * 从环境 URL 里取回环端口。只有回环地址才可探测——staging 的公网域名不该由浏览器直连，
 * 也不该让「拿不到端口」被误读成服务不健康。
 */
export function portFromUrl(value: unknown): number | null {
    const raw = text(value);
    if (!raw) return null;
    try {
        const parsed = new URL(raw);
        if (!LOOPBACK_HOSTS.has(parsed.hostname)) return null;
        return normalizePort(parsed.port);
    } catch {
        return null;
    }
}

/**
 * 探测目标解析：显式端口优先，其次从回环 URL 推导；健康路径缺省 "/"。
 * 最终 URL 一律交给 buildHealthUrl，保证与 service 节点同语义。
 */
export function resolveEnvProbeTarget(metadata: EnvProbeMetadata | null | undefined): EnvProbeTarget {
    const explicitPort = normalizePort(metadata?.envHealthPort);
    const port = explicitPort ?? portFromUrl(metadata?.url);
    const healthPath = text(metadata?.envHealthPath) || SERVICE_DEFAULT_HEALTH_PATH;
    return { port, healthPath, url: buildHealthUrl(port, healthPath) };
}

/** 2xx/3xx 视为健康；4xx/5xx 是服务在，但健康检查没过。 */
export function isHealthyHttpStatus(status: number): boolean {
    return status >= 200 && status < 400;
}

/**
 * 探测结果 → 状态。没有状态码也没有错误，说明请求解析成功但响应不透明（no-cors 回退），
 * 只能判「可达」，按健康处理并在 UI 上不显示状态码——不编造一个 200。
 */
export function envHealthFromProbe(outcome: ProbeOutcome): EnvHealthSnapshot {
    const checkedAt = text(outcome.checkedAt) || new Date().toISOString();
    const httpStatus = typeof outcome.httpStatus === "number" && Number.isInteger(outcome.httpStatus) && outcome.httpStatus > 0 ? outcome.httpStatus : undefined;
    const rawError = text(outcome.error);
    if (rawError) return { status: "unhealthy", httpStatus, checkedAt, error: rawError };
    if (httpStatus != null && !isHealthyHttpStatus(httpStatus)) {
        return { status: "unhealthy", httpStatus, checkedAt, error: `HTTP ${httpStatus}` };
    }
    return { status: "healthy", httpStatus, checkedAt };
}

/** 读旧 metadata：没有 envHealth 或形状不对时返回 null，绝不假装探测过。 */
export function readEnvHealth(metadata: EnvProbeMetadata | null | undefined): EnvHealthSnapshot | null {
    const raw = metadata?.envHealth;
    if (typeof raw !== "object" || raw === null) return null;
    const record = raw as Record<string, unknown>;
    const status = record.status;
    if (typeof status !== "string" || !(ENV_HEALTH_STATUSES as readonly string[]).includes(status)) return null;
    const httpStatus = typeof record.httpStatus === "number" && Number.isInteger(record.httpStatus) && record.httpStatus > 0 ? record.httpStatus : undefined;
    const checkedAt = text(record.checkedAt);
    const error = text(record.error) || undefined;
    return { status: status as EnvHealthStatus, httpStatus, checkedAt, error };
}

/** 探测结果写回 metadata 的唯一入口；空错误/无状态码不落空字段。 */
export function envHealthMetadataPatch(snapshot: EnvHealthSnapshot): { envHealth: NonNullable<EnvHealthSnapshot> } {
    return {
        envHealth: {
            status: snapshot.status,
            httpStatus: snapshot.httpStatus,
            checkedAt: text(snapshot.checkedAt),
            error: text(snapshot.error) || undefined,
        },
    };
}

/** HH:MM:SS（本地时区）；无法解析时返回空串，交给 UI 显示「尚未探测」。 */
export function formatProbeClock(value: unknown): string {
    const raw = text(value);
    if (!raw) return "";
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (part: number) => String(part).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** "HTTP 200"；没有状态码时返回空串（不显示 "HTTP 0"）。 */
export function formatHttpStatus(value: unknown): string {
    const code = typeof value === "number" ? value : Number.NaN;
    if (!Number.isInteger(code) || code <= 0) return "";
    return `HTTP ${code}`;
}

function messageOf(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 真正发一次探测。先按正常 CORS 请求读状态码；读不到（本地服务没配 CORS 时浏览器会抛
 * TypeError）再退回 no-cors 判「可达」，此时没有状态码。
 * signal 是外部取消（组件卸载 / 立即复检），超时由 SERVICE_PROBE_TIMEOUT_MS 控制。
 */
export async function probeEnvironmentHealth(
    url: string,
    options: { fetchImpl?: ProbeFetch; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProbeOutcome> {
    const checkedAt = new Date().toISOString();
    const target = text(url);
    if (!target) return { checkedAt, error: "no-target", failure: "no-target" };
    const fetchImpl: ProbeFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    const timeoutMs = options.timeoutMs ?? SERVICE_PROBE_TIMEOUT_MS;
    const controller = new AbortController();
    const external = options.signal;
    const abortFromOutside = () => controller.abort();
    if (external) {
        if (external.aborted) return { checkedAt, error: "aborted", failure: "aborted" };
        external.addEventListener("abort", abortFromOutside);
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(target, { cache: "no-store", signal: controller.signal });
        return { checkedAt, httpStatus: response.status };
    } catch (cause) {
        if (external?.aborted) return { checkedAt, error: "aborted", failure: "aborted" };
        if (controller.signal.aborted) return { checkedAt, error: "timeout", failure: "timeout" };
        try {
            await fetchImpl(target, { cache: "no-store", mode: "no-cors", signal: controller.signal });
            return { checkedAt };
        } catch (fallbackCause) {
            if (external?.aborted) return { checkedAt, error: "aborted", failure: "aborted" };
            if (controller.signal.aborted) return { checkedAt, error: "timeout", failure: "timeout" };
            return { checkedAt, error: messageOf(fallbackCause) || messageOf(cause), failure: "network" };
        }
    } finally {
        clearTimeout(timer);
        external?.removeEventListener("abort", abortFromOutside);
    }
}
