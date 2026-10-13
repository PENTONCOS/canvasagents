import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";

import { APP_ID } from "@/constant/brand";
import { ensureStorageMigration } from "@/lib/brand-migration";

localforage.config({
    name: APP_ID,
    storeName: "app_state",
});

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        try {
            // Legacy installs keep their records in the old database; copy them over
            // before reading so hydration never sees an empty store.
            await ensureStorageMigration();
            return (await localforage.getItem<string>(name)) || null;
        } catch {
            return window.localStorage.getItem(name);
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.setItem(name, value);
        } catch {
            window.localStorage.setItem(name, value);
        }
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.removeItem(name);
        } catch {
            window.localStorage.removeItem(name);
        }
    },
};
