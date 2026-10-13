import localforage from "localforage";

import type { PluginStorage } from "@/types/canvas-plugin";
import { APP_ID } from "@/constant/brand";
import { ensureStorageMigration } from "@/lib/brand-migration";

// Lightweight canvas event bus for communication between nodes and plugins.
type Handler = (payload: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

export function emitCanvasEvent(event: string, payload?: unknown) {
    handlers.get(event)?.forEach((handler) => {
        try {
            handler(payload);
        } catch (error) {
            console.error(`[canvas-event] handler for "${event}" failed`, error);
        }
    });
}

export function onCanvasEvent(event: string, handler: Handler) {
    let set = handlers.get(event);
    if (!set) {
        set = new Set();
        handlers.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
}

// Private plugin storage isolated by pluginId namespace.
const stores = new Map<string, LocalForage>();

export function createPluginStorage(pluginId: string): PluginStorage {
    let store = stores.get(pluginId);
    if (!store) {
        store = localforage.createInstance({ name: `${APP_ID}-plugins`, storeName: pluginId });
        stores.set(pluginId, store);
    }
    return {
        get: async (key) => {
            await ensureStorageMigration();
            return store!.getItem(key);
        },
        set: async (key, value) => {
            await ensureStorageMigration();
            await store!.setItem(key, value);
        },
        remove: async (key) => {
            await ensureStorageMigration();
            await store!.removeItem(key);
        },
    };
}
