import { useAccountStore } from "@/stores/use-account-store";

export type AccountApiResult<T> = {
    status: number;
    data: T;
    headers: Headers;
};

// 内置的公网同步服务（Cloudflare Workers + D1 + R2），留空时默认使用它，
// 这样换一台电脑登录同一个账号即可恢复配置。自建部署可在「同步服务器地址」里覆盖。
export const DEFAULT_SYNC_SERVER_URL = "https://sync.canvasagents-sync.workers.dev";

function normalizeServerUrl(value: string) {
    return value.trim().replace(/\/+$/, "");
}

export function resolveServerUrl(serverUrl?: string) {
    const configured = normalizeServerUrl(serverUrl ?? useAccountStore.getState().serverUrl);
    if (configured) return configured;
    if (typeof window !== "undefined" && window.location) {
        const { protocol, hostname, port } = window.location;
        // 本地开发时优先同源，方便连本机自建的同步服务。
        if (protocol.startsWith("http") && (hostname === "localhost" || hostname === "127.0.0.1")) {
            return `${protocol}//${hostname}${port ? `:${port}` : ""}`;
        }
    }
    return DEFAULT_SYNC_SERVER_URL;
}

export function accountRequestInit(method: string, body?: BodyInit, contentType?: string): RequestInit {
    const { token } = useAccountStore.getState();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (contentType) headers["Content-Type"] = contentType;
    return { method, headers, body };
}

export async function accountRequest<T>(path: string, init: RequestInit): Promise<AccountApiResult<T>> {
    const url = `${resolveServerUrl()}${path}`;
    const response = await fetch(url, init);
    const text = new TextDecoder().decode(await response.arrayBuffer());
    let data: T;
    try {
        data = JSON.parse(text) as T;
    } catch {
        data = text as unknown as T;
    }
    return { status: response.status, data, headers: response.headers };
}

export async function accountRequestJson<T>(path: string, init: RequestInit): Promise<{ status: number; data: T }> {
    const { status, data } = await accountRequest<T>(path, init);
    return { status, data };
}
