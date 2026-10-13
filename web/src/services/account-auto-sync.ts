import { create, type StoreApi } from "zustand";

import { currentConfigData, hashData, syncAccountData, type AccountSyncResult } from "@/services/account-sync";
import type { AppSyncProgress } from "@/services/app-sync";
import { useAccountStore } from "@/stores/use-account-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useConfigStore } from "@/stores/use-config-store";
import { usePromptSourceStore } from "@/stores/use-prompt-source-store";

/**
 * Automatic account sync coordinator.
 *
 * Watches every store that belongs to an account and pushes the result to the
 * self-hosted sync server a few seconds after it changes, so the product never
 * asks the user to press "sync now". It owns the tricky parts:
 *  - debounce bursts into a single sync (~4s) and never run two syncs at once
 *  - ignore store writes caused by applying remote data (loop guard + cooldown)
 *  - skip no-op syncs through a cheap content hash of the last successful sync
 *  - swallow failures into an error state, back off ~20s, then retry
 *
 * The image/video generation log stores are plain localforage instances without
 * change events, so they cannot trigger a sync on their own; they are still
 * uploaded by every sync that a watched domain starts.
 */

export const AUTO_SYNC_DEBOUNCE_MS = 4000;
export const AUTO_SYNC_COOLDOWN_MS = 2000;
export const AUTO_SYNC_BACKOFF_MS = 20000;

export type AccountAutoSyncStatus = "idle" | "syncing" | "error";

type AccountAutoSyncStore = {
    status: AccountAutoSyncStatus;
    lastError: string;
    setStatus: (status: AccountAutoSyncStatus, lastError?: string) => void;
};

/** Small readable state so the UI can render "syncing / last synced / failed" without subscribing to the sync itself. */
export const useAccountAutoSyncStore = create<AccountAutoSyncStore>((set) => ({
    status: "idle",
    lastError: "",
    setStatus: (status, lastError = "") => set({ status, lastError }),
}));

type WatchedRefs = {
    projects: unknown;
    deletedProjects: unknown;
    assets: unknown;
    config: unknown;
    webdav: unknown;
    sources: unknown;
    schedule: unknown;
};

let started = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let backoffTimer: ReturnType<typeof setTimeout> | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let suppressionDepth = 0;
let suppressedUntil = 0;
let syncing = false;
let pendingForce = false;
let lastKnownToken = "";
let lastSyncedRefs: WatchedRefs | null = null;
let lastSyncedHash = "";

function isSuppressed() {
    return suppressionDepth > 0 || Date.now() < suppressedUntil;
}

function currentRefs(): WatchedRefs {
    const canvas = useCanvasStore.getState();
    const asset = useAssetStore.getState();
    const config = useConfigStore.getState();
    const prompt = usePromptSourceStore.getState();
    return {
        projects: canvas.projects,
        deletedProjects: canvas.deletedProjects,
        assets: asset.assets,
        config: config.config,
        webdav: config.webdav,
        sources: prompt.sources,
        schedule: prompt.schedule,
    };
}

function sameRefs(a: WatchedRefs | null, b: WatchedRefs) {
    if (!a) return false;
    return (
        a.projects === b.projects &&
        a.deletedProjects === b.deletedProjects &&
        a.assets === b.assets &&
        a.config === b.config &&
        a.webdav === b.webdav &&
        a.sources === b.sources &&
        a.schedule === b.schedule
    );
}

/**
 * Media payloads travel as storage keys, so long strings (base64 data URLs,
 * blob URLs) collapse into a short marker. Hashing megabytes of base64 on every
 * keystroke would defeat the point of a *cheap* change check.
 */
function sanitizeForHash(value: unknown, depth = 0): unknown {
    if (typeof value === "string") return value.length > 256 ? `#long:${value.length}:${value.slice(0, 32)}` : value;
    if (value === null || typeof value !== "object") return value;
    if (depth > 24) return "#deep";
    if (Array.isArray(value)) return value.map((item) => sanitizeForHash(item, depth + 1));
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    Object.keys(record).forEach((key) => {
        output[key] = sanitizeForHash(record[key], depth + 1);
    });
    return output;
}

async function snapshotHash() {
    const { projects, deletedProjects } = useCanvasStore.getState();
    const { assets } = useAssetStore.getState();
    return hashData(sanitizeForHash({ canvas: { projects, deletedProjects }, assets, config: currentConfigData() }));
}

function clearBackoff() {
    if (!backoffTimer) return;
    clearTimeout(backoffTimer);
    backoffTimer = null;
}

function scheduleBackoff() {
    clearBackoff();
    backoffTimer = setTimeout(() => {
        backoffTimer = null;
        if (!useAccountStore.getState().token) return;
        // A retry after a failure must run even when the content hash is unchanged.
        void performSync(true);
    }, AUTO_SYNC_BACKOFF_MS);
}

/**
 * Changes made while a sync is applying remote data are ignored by the
 * listeners, so re-check once the cooldown ends and sync anything that slipped
 * through instead of silently dropping it.
 */
function scheduleSettleCheck() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
        settleTimer = null;
        if (isSuppressed() || !useAccountStore.getState().token) return;
        if (lastSyncedRefs && !sameRefs(lastSyncedRefs, currentRefs())) scheduleSync();
    }, AUTO_SYNC_COOLDOWN_MS + 250);
}

function scheduleSync(delay = AUTO_SYNC_DEBOUNCE_MS) {
    if (!useAccountStore.getState().token) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void triggerSync(false);
    }, delay);
}

async function triggerSync(force: boolean) {
    if (isSuppressed()) {
        // Remote data is still settling: look again after the cooldown.
        scheduleSync(AUTO_SYNC_DEBOUNCE_MS);
        return;
    }
    await performSync(force);
}

/**
 * Single-flight sync. Returns the result for callers that surface it (manual
 * recovery), or `null` when the call was skipped, deduplicated or failed —
 * failures never throw, they surface through the status store.
 */
async function performSync(force: boolean, onProgress?: AppSyncProgress): Promise<AccountSyncResult | null> {
    if (syncing) {
        pendingForce = pendingForce || force;
        return null;
    }
    if (!useAccountStore.getState().token) {
        useAccountAutoSyncStore.getState().setStatus("idle");
        return null;
    }
    if (!force) {
        const refs = currentRefs();
        if (sameRefs(lastSyncedRefs, refs) || (await snapshotHash()) === lastSyncedHash) {
            useAccountAutoSyncStore.getState().setStatus("idle");
            return null;
        }
    }

    clearBackoff();
    syncing = true;
    suppressionDepth += 1;
    useAccountAutoSyncStore.getState().setStatus("syncing");
    let result: AccountSyncResult | null = null;
    try {
        result = await syncAccountData(onProgress);
        useAccountStore.getState().setLastSyncedAt(result.syncedAt);
        lastSyncedRefs = currentRefs();
        lastSyncedHash = await snapshotHash();
        useAccountAutoSyncStore.getState().setStatus("idle");
    } catch (error) {
        // Never bubble into the UI: a failed auto-sync becomes a status line plus a retry.
        const message = error instanceof Error ? error.message : "account auto sync failed";
        useAccountAutoSyncStore.getState().setStatus("error", message);
        scheduleBackoff();
    } finally {
        syncing = false;
        suppressionDepth -= 1;
        suppressedUntil = Date.now() + AUTO_SYNC_COOLDOWN_MS;
        scheduleSettleCheck();
    }
    if (pendingForce) {
        pendingForce = false;
        scheduleSync(AUTO_SYNC_DEBOUNCE_MS);
    }
    return result;
}

function subscribeDomain<T>(store: StoreApi<T>, changed: (state: T, prev: T) => boolean) {
    return store.subscribe((state, prev) => {
        if (isSuppressed()) return;
        if (!changed(state, prev)) return;
        scheduleSync();
    });
}

function handleAccountChange() {
    const { token } = useAccountStore.getState();
    if (token === lastKnownToken) return;
    const previousToken = lastKnownToken;
    lastKnownToken = token;

    if (!token) {
        // Logout keeps local data on purpose; only pending work is cancelled.
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = null;
        clearBackoff();
        useAccountAutoSyncStore.getState().setStatus("idle");
        return;
    }
    if (previousToken) return;

    // A fresh session: pull the account's data right away.
    void performSync(true);
}

/**
 * Starts the coordinator. Call exactly once from the client root; a second call
 * is a no-op. On a page with an already-restored session nothing syncs until the
 * first change (or an explicit `requestAccountSync`), matching the login-driven
 * sync contract.
 */
export function startAccountAutoSync() {
    if (started || typeof window === "undefined") return;
    started = true;
    lastKnownToken = useAccountStore.getState().token;
    subscribeDomain(useCanvasStore, (state, prev) => state.projects !== prev.projects || state.deletedProjects !== prev.deletedProjects);
    subscribeDomain(useAssetStore, (state, prev) => state.assets !== prev.assets);
    subscribeDomain(useConfigStore, (state, prev) => state.config !== prev.config || state.webdav !== prev.webdav);
    subscribeDomain(usePromptSourceStore, (state, prev) => state.sources !== prev.sources || state.schedule !== prev.schedule);
    useAccountStore.subscribe(handleAccountChange);
}

/** Manual recovery entry point (the ghost "resync" button) and login-time sync. */
export async function requestAccountSync(options?: { force?: boolean; onProgress?: AppSyncProgress }): Promise<AccountSyncResult | null> {
    return performSync(options?.force ?? true, options?.onProgress);
}
