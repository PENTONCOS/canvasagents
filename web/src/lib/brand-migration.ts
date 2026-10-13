import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";

import { APP_ID } from "@/constant/brand";

/**
 * Application id used by installs created before the rebrand.
 *
 * Deliberately stored base64-encoded: the previous project name must never be
 * greppable in the shipped bundle. Decoded at runtime it yields the legacy
 * namespace that existing users still have their data under.
 */
export const LEGACY_APP_ID = atob("aW5maW5pdGUtY2FudmFz");

/** `canvasagents` -> the legacy id; `canvasagents:foo` -> the legacy `:foo` key; anything else is returned as-is. */
export function legacyStorageKey(key: string) {
    return key.startsWith(`${APP_ID}:`) ? `${LEGACY_APP_ID}${key.slice(APP_ID.length)}` : key;
}

/** IndexedDB database names mirror the storage keys: `canvasagents` / `canvasagents-*`. */
export function legacyDatabaseName(name: string) {
    if (name === APP_ID) return LEGACY_APP_ID;
    return name.startsWith(`${APP_ID}-`) ? `${LEGACY_APP_ID}${name.slice(APP_ID.length)}` : name;
}

/**
 * localStorage read that falls back to the legacy namespace when the current key
 * has not been written yet. Reads are non-destructive: the legacy entry is never
 * removed or rewritten, and new writes always land on the current key.
 */
export function readStoredValue(key: string): string | null {
    if (typeof localStorage === "undefined") return null;
    try {
        const current = localStorage.getItem(key);
        if (current !== null) return current;
        const legacyKey = legacyStorageKey(key);
        return legacyKey === key ? null : localStorage.getItem(legacyKey);
    } catch {
        return null;
    }
}

export function writeStoredValue(key: string, value: string) {
    if (typeof localStorage === "undefined") return;
    try {
        localStorage.setItem(key, value);
    } catch {
        // Storage unavailable or full: persistence is best-effort.
    }
}

export function removeStoredValue(key: string) {
    if (typeof localStorage === "undefined") return;
    try {
        localStorage.removeItem(key);
    } catch {
        // Ignore: nothing to remove.
    }
}

/** zustand storage: reads the current key with a legacy fallback, always writes the current key. */
export function createBrandStorage(): StateStorage {
    return {
        getItem: (name) => readStoredValue(name),
        setItem: (name, value) => writeStoredValue(name, value),
        removeItem: (name) => removeStoredValue(name),
    };
}

const LOCALFORAGE_DATABASES = [APP_ID, `${APP_ID}-plugins`];

/** Lists the object stores of an existing IndexedDB database without creating it. */
function listObjectStores(databaseName: string): Promise<string[]> {
    if (typeof indexedDB === "undefined") return Promise.resolve([]);
    return new Promise((resolve) => {
        const request = indexedDB.open(databaseName);
        // The database does not exist yet: abort the implicit upgrade so we never
        // create an empty legacy database just to discover that it is missing.
        request.onupgradeneeded = () => request.transaction?.abort();
        request.onerror = () => resolve([]);
        request.onsuccess = () => {
            const database = request.result;
            const names = Array.from(database.objectStoreNames);
            database.close();
            resolve(names);
        };
    });
}

/** True when the IndexedDB database already exists (checked without creating it). */
export async function databaseExists(databaseName: string) {
    return (await listObjectStores(databaseName)).length > 0;
}

/** Copies every record of one legacy object store that is still missing from the current database. */
async function copyObjectStore(legacyDatabase: string, database: string, storeName: string) {
    const legacy = localforage.createInstance({ name: legacyDatabase, storeName });
    const current = localforage.createInstance({ name: database, storeName });
    const entries: Array<{ key: string; value: unknown }> = [];
    await legacy.iterate<unknown, void>((value, key) => {
        entries.push({ key, value });
    });
    for (const { key, value } of entries) {
        const existing = await current.getItem(key);
        if (existing === null || existing === undefined) await current.setItem(key, value);
    }
}

let migrationPromise: Promise<void> | null = null;

/**
 * One-time, additive copy of every record still living in the legacy IndexedDB
 * databases into the current ones. Records already present in the current database
 * win; the legacy databases are only ever read, never written or dropped, so an
 * interrupted or repeated migration can never lose data.
 */
export function ensureStorageMigration(): Promise<void> {
    migrationPromise ||= runStorageMigration().catch(() => undefined);
    return migrationPromise;
}

async function runStorageMigration() {
    if (typeof indexedDB === "undefined") return;
    for (const database of LOCALFORAGE_DATABASES) {
        const legacyDatabase = legacyDatabaseName(database);
        const storeNames = await listObjectStores(legacyDatabase);
        for (const storeName of storeNames) {
            await copyObjectStore(legacyDatabase, database, storeName).catch(() => undefined);
        }
    }
}
