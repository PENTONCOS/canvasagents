import type { PromptSource } from "@/services/api/prompt-source-presets";
import { accountRequestInit, resolveServerUrl } from "@/services/account-client";
import { runAppSync, type AppSyncProgress, type AppSyncResult, type AppSyncTransport, type DomainKey } from "@/services/app-sync";
import { useAccountStore } from "@/stores/use-account-store";
import { useConfigStore, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { usePromptSourceStore, type PromptSourceSchedule } from "@/stores/use-prompt-source-store";

export type ConfigDomainData = {
    config: AiConfig;
    webdav: WebdavSyncConfig;
    promptSources: {
        sources: PromptSource[];
        schedule: PromptSourceSchedule;
    };
};

export type ConfigSyncAction = "uploaded" | "downloaded" | "in-sync" | "conflict";

export type AccountSyncResult = {
    syncedAt: string;
    app: AppSyncResult;
    config: ConfigSyncAction;
};

export const CONFIG_SYNC_STATE_KEY = "infinite-canvas:config_sync_state";

type ConfigSyncState = {
    hash: string;
    syncedAt: string;
};

function parseFilePath(path: string) {
    const [domain, , ...rest] = path.split("/");
    return { domain: domain as DomainKey, name: rest.join("/") };
}

function domainUrl(path: string) {
    return `${resolveServerUrl()}${path}`;
}

/** Transport that swaps WebDAV for the self-hosted CanvasAgents sync server. */
export function accountTransport(): AppSyncTransport {
    return {
        readManifest: async (domain) => {
            const response = await fetch(domainUrl(`/v1/domains/${domain}/manifest`), accountRequestInit("GET"));
            if (response.status === 404) return null;
            if (!response.ok) throw new Error(`读取云端清单失败（${response.status}）`);
            return new Blob([await response.arrayBuffer()], { type: "application/json" });
        },
        writeManifest: async (domain, blob) => {
            const response = await fetch(domainUrl(`/v1/domains/${domain}/manifest`), accountRequestInit("PUT", blob, "application/json"));
            if (!response.ok) throw new Error(`上传云端清单失败（${response.status}）`);
        },
        readFile: async (path) => {
            const { domain, name } = parseFilePath(path);
            const response = await fetch(domainUrl(`/v1/domains/${domain}/files/${encodeURIComponent(name)}`), accountRequestInit("GET"));
            if (response.status === 404) return null;
            if (!response.ok) throw new Error(`下载云端文件失败（${response.status}）`);
            return new Blob([await response.arrayBuffer()], { type: response.headers.get("Content-Type") || "application/octet-stream" });
        },
        writeFile: async (path, blob, mimeType) => {
            const { domain, name } = parseFilePath(path);
            const response = await fetch(domainUrl(`/v1/domains/${domain}/files/${encodeURIComponent(name)}`), accountRequestInit("PUT", blob, mimeType));
            if (!response.ok) throw new Error(`上传云端文件失败（${response.status}）`);
        },
    };
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

async function hashData(value: unknown): Promise<string> {
    const text = stableStringify(value);
    if (typeof crypto !== "undefined" && crypto.subtle) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        return Array.from(new Uint8Array(digest))
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
    }
    let hash = 5381;
    for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
    return hash.toString(16);
}

function readConfigSyncState(): ConfigSyncState | null {
    if (typeof localStorage === "undefined") return null;
    try {
        const raw = localStorage.getItem(CONFIG_SYNC_STATE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<ConfigSyncState>;
        return parsed && typeof parsed.hash === "string" ? { hash: parsed.hash, syncedAt: parsed.syncedAt || "" } : null;
    } catch {
        // corrupt state: fall back to a first-sync comparison
        return null;
    }
}

function writeConfigSyncState(hash: string) {
    if (typeof localStorage === "undefined") return;
    try {
        localStorage.setItem(CONFIG_SYNC_STATE_KEY, JSON.stringify({ hash, syncedAt: new Date().toISOString() } satisfies ConfigSyncState));
    } catch {
        // storage full or unavailable: sync still succeeded, only the baseline record is skipped
    }
}

export function currentConfigData(): ConfigDomainData {
    const { config, webdav } = useConfigStore.getState();
    const { sources, schedule } = usePromptSourceStore.getState();
    return { config, webdav, promptSources: { sources, schedule } };
}

function defaultConfigData(): ConfigDomainData {
    const configState = useConfigStore.getInitialState();
    const promptState = usePromptSourceStore.getInitialState();
    return { config: configState.config, webdav: configState.webdav, promptSources: { sources: promptState.sources, schedule: promptState.schedule } };
}

export function applyConfigData(data: ConfigDomainData) {
    useConfigStore.setState({ config: data.config, webdav: data.webdav });
    usePromptSourceStore.setState({ sources: data.promptSources.sources, schedule: data.promptSources.schedule });
}

function isConfigDomainData(value: unknown): value is ConfigDomainData {
    if (!value || typeof value !== "object") return false;
    const data = value as Partial<ConfigDomainData>;
    return Boolean(data.config && data.webdav && data.promptSources && Array.isArray(data.promptSources.sources));
}

async function writeRemoteConfig(transport: AppSyncTransport, data: ConfigDomainData) {
    await transport.writeManifest("config", new Blob([JSON.stringify(data)], { type: "application/json" }));
}

/**
 * Settings sync uses a content-hash three-way comparison (local / remote / last synced)
 * instead of timestamps: store hydration keeps rewriting the local revision stamp, so
 * time-based LWW would always look "locally changed".
 */
async function syncConfigDomain(transport: AppSyncTransport, onProgress?: AppSyncProgress): Promise<ConfigSyncAction> {
    const emit = (stage: string, status?: "active" | "success" | "exception") => onProgress?.({ domain: "config", label: "配置", stage, status });
    emit("读取远端清单", "active");
    const remoteBlob = await transport.readManifest("config");
    const local = currentConfigData();
    const localHash = await hashData(local);

    if (!remoteBlob) {
        emit("上传配置", "active");
        await writeRemoteConfig(transport, local);
        writeConfigSyncState(localHash);
        emit("完成", "success");
        return "uploaded";
    }

    let remote: unknown;
    try {
        remote = JSON.parse(await remoteBlob.text());
    } catch {
        throw new Error("云端配置清单格式不正确");
    }
    if (!isConfigDomainData(remote)) throw new Error("云端配置清单不是当前应用的数据");
    const remoteHash = await hashData(remote);

    if (localHash === remoteHash) {
        writeConfigSyncState(localHash);
        emit("配置无变化", "success");
        return "in-sync";
    }

    const state = readConfigSyncState();
    if (state) {
        const localChanged = localHash !== state.hash;
        const remoteChanged = remoteHash !== state.hash;
        if (localChanged && !remoteChanged) {
            emit("上传配置", "active");
            await writeRemoteConfig(transport, local);
            writeConfigSyncState(localHash);
            emit("完成", "success");
            return "uploaded";
        }
        if (!localChanged && remoteChanged) {
            emit("应用云端配置", "active");
            applyConfigData(remote);
            writeConfigSyncState(remoteHash);
            emit("完成", "success");
            return "downloaded";
        }
        emit("配置冲突，已保留本地", "exception");
        return "conflict";
    }

    // First sync on this device: adopt the cloud copy only when the local one is still pristine.
    const pristineHash = await hashData(defaultConfigData());
    if (localHash === pristineHash && remoteHash !== pristineHash) {
        emit("应用云端配置", "active");
        applyConfigData(remote);
        writeConfigSyncState(remoteHash);
        emit("完成", "success");
        return "downloaded";
    }
    if (remoteHash === pristineHash) {
        emit("上传配置", "active");
        await writeRemoteConfig(transport, local);
        writeConfigSyncState(localHash);
        emit("完成", "success");
        return "uploaded";
    }
    emit("配置冲突，已保留本地", "exception");
    return "conflict";
}

/** Full account sync: canvas / assets / image-workbench / video-workbench + settings. */
export async function syncAccountData(onProgress?: AppSyncProgress): Promise<AccountSyncResult> {
    if (!useAccountStore.getState().token) throw new Error("未登录账号");
    const transport = accountTransport();
    const app = await runAppSync(transport, onProgress);
    const config = await syncConfigDomain(transport, onProgress);
    return { syncedAt: new Date().toISOString(), app, config };
}

/** Conflict resolution: overwrite the cloud copy with this device's settings. */
export async function pushConfigToCloud(): Promise<void> {
    const local = currentConfigData();
    await writeRemoteConfig(accountTransport(), local);
    writeConfigSyncState(await hashData(local));
}

/** Conflict resolution: overwrite this device's settings with the cloud copy. */
export async function pullConfigFromCloud(): Promise<ConfigDomainData | null> {
    const blob = await accountTransport().readManifest("config");
    if (!blob) return null;
    const remote = JSON.parse(await blob.text()) as unknown;
    if (!isConfigDomainData(remote)) throw new Error("云端配置清单不是当前应用的数据");
    applyConfigData(remote);
    writeConfigSyncState(await hashData(remote));
    return remote;
}
