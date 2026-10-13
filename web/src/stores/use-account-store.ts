import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { APP_ID } from "@/constant/brand";
import { createBrandStorage } from "@/lib/brand-migration";

export type AccountUser = {
    id: string;
    username: string;
    displayName: string;
};

export type AccountState = {
    serverUrl: string;
    token: string;
    user: AccountUser | null;
    lastSyncedAt: string;
    /** Id of the account that owns the local data; survives logout so a switch can be detected. */
    lastAccountId: string;
};

type AccountStore = AccountState & {
    setServerUrl: (serverUrl: string) => void;
    setSession: (payload: { token: string; user: AccountUser }) => void;
    setUser: (user: AccountUser | null) => void;
    setLastSyncedAt: (lastSyncedAt: string) => void;
    setLastAccountId: (lastAccountId: string) => void;
    clearSession: () => void;
};

export const useAccountStore = create<AccountStore>()(
    persist(
        (set) => ({
            serverUrl: "",
            token: "",
            user: null,
            lastSyncedAt: "",
            lastAccountId: "",
            setServerUrl: (serverUrl) => set({ serverUrl }),
            setSession: ({ token, user }) => set({ token, user }),
            setUser: (user) => set({ user }),
            setLastSyncedAt: (lastSyncedAt) => set({ lastSyncedAt }),
            setLastAccountId: (lastAccountId) => set({ lastAccountId }),
            clearSession: () => set({ token: "", user: null, lastSyncedAt: "" }),
        }),
        {
            name: `${APP_ID}:account_store`,
            storage: createJSONStorage(() => createBrandStorage()),
            partialize: (state) => ({ serverUrl: state.serverUrl, token: state.token, user: state.user, lastSyncedAt: state.lastSyncedAt, lastAccountId: state.lastAccountId }),
        },
    ),
);
