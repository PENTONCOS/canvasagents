// A2: 网页预览节点。URL 规整与失败判定是纯逻辑，放这里单测覆盖；
// 渲染/探测仍在 nodes/preview-node.tsx（复用既有 M4 节点）。
export const PREVIEW_NODE_TYPE = "preview";
/** 仅作输入框占位提示，不再作为空 URL 的默认值（空 URL 要显示空状态，而不是硬塞一个地址）。 */
export const DEFAULT_PREVIEW_URL = "http://localhost:5173";

export type PreviewUrlProblem = "empty" | "unsupported";
export type PreviewUrlResult = { url: string; problem: PreviewUrlProblem | null };

const UNSAFE_SCHEME = /^(javascript|data|vbscript|blob|about|file):/i;

/** 内网/本机主机默认走 http（https 在这些地址上通常没有证书）。 */
function isLocalHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
    if (host === "::1" || host === "0.0.0.0") return true;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
    const private172 = /^172\.(\d{1,3})\./.exec(host);
    return Boolean(private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31);
}

/**
 * 把用户输入折成 iframe 可用的地址：
 * - 空输入 → problem "empty"（节点显示可读的空状态，不加载白屏）；
 * - 显式 http(s) → 原样校验；
 * - 其它协议（javascript:/data:/file: 等）→ "unsupported"，绝不让脚本协议进 iframe；
 * - 无协议（含 localhost:5173）→ 本机/内网补 http，其它补 https。
 */
export function normalizePreviewUrl(input: string): PreviewUrlResult {
    const raw = typeof input === "string" ? input.trim() : "";
    if (!raw) return { url: "", problem: "empty" };
    if (UNSAFE_SCHEME.test(raw)) return { url: "", problem: "unsupported" };

    if (/^https?:\/\//i.test(raw)) {
        try {
            const parsed = new URL(raw);
            return parsed.hostname ? { url: raw, problem: null } : { url: "", problem: "unsupported" };
        } catch {
            return { url: "", problem: "unsupported" };
        }
    }
    // 其它带 `scheme://` 的协议（ftp/ws/...）不是网页，iframe 里没有意义。
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return { url: "", problem: "unsupported" };

    const host = raw.split(/[/?#]/, 1)[0] || "";
    if (!host) return { url: "", problem: "unsupported" };
    const scheme = isLocalHost(host.replace(/:\d+$/, "")) ? "http" : "https";
    try {
        const parsed = new URL(`${scheme}://${raw}`);
        return parsed.hostname ? { url: `${scheme}://${raw}`, problem: null } : { url: "", problem: "unsupported" };
    } catch {
        return { url: "", problem: "unsupported" };
    }
}

export type PreviewProbeStatus = "unknown" | "reachable" | "unreachable";
/** 站点禁止内嵌、网络不可达、超时——三张可读文案。 */
export type PreviewFailure = "blocked" | "unreachable" | "timeout";

/**
 * 什么时候把 iframe 换成可读错误卡（绝不白屏）。
 * 判定只看 iframe 自己：加载成功 → 不报错；onError → 网络不可达；
 * 过了超时还没有 onLoad → 超时。**探测结果不参与这里的判定**，
 * 因为 no-cors 探测对公网 URL 本来就会因 CORS/策略误判。
 */
export function resolvePreviewFailure(input: { loaded: boolean; failed: boolean; elapsedMs: number; timeoutMs?: number }): PreviewFailure | null {
    if (input.loaded) return null;
    if (input.failed) return "unreachable";
    if (input.elapsedMs >= (input.timeoutMs ?? 12000)) return "timeout";
    return null;
}

/**
 * 超时之后再决定文案：探测说服务可达却始终没有 onLoad，基本就是被 X-Frame-Options/CSP 拦了；
 * 探测说不可达则按网络问题提示；探测未知就如实说“超时”。只在已判定要出错误卡后调用。
 */
export function classifyPreviewFailure(failure: PreviewFailure, probeStatus: PreviewProbeStatus): PreviewFailure {
    if (failure !== "timeout") return failure;
    if (probeStatus === "reachable") return "blocked";
    if (probeStatus === "unreachable") return "unreachable";
    return "timeout";
}
