import { useAccountStore } from "@/stores/use-account-store";

export type AccountApiResult<T> = {
    status: number;
    data: T;
    headers: Headers;
};

function normalizeServerUrl(value: string) {
    return value.trim().replace(/\/+$/, "");
}

export function resolveServerUrl(serverUrl?: string) {
    const configured = normalizeServerUrl(serverUrl ?? useAccountStore.getState().serverUrl);
    if (configured) return configured;
    if (typeof window !== "undefined" && window.location) {
        const { protocol, hostname, port } = window.location;
        if (protocol.startsWith("http")) return `${protocol}//${hostname}${port? `:${port}`: ""}`;
    }
    return "http://127.0.0.1:17372";
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
