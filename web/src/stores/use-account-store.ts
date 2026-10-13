import { create } from "zustand";
import { persist } from "zustand/middleware";

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
};

type AccountStore = AccountState & {
    setServerUrl: (serverUrl: string) => void;
    setSession: (payload: { token: string; user: AccountUser }) => void;
    setUser: (user: AccountUser | null) => void;
    setLastSyncedAt: (lastSyncedAt: string) => void;
    clearSession: () => void;
};

export const useAccountStore = create<AccountStore>()(
    persist(
        (set) => ({
            serverUrl: "",
            token: "",
            user: null,
            lastSyncedAt: "",
            setServerUrl: (serverUrl) => set({ serverUrl }),
            setSession: ({ token, user }) => set({ token, user }),
            setUser: (user) => set({ user }),
            setLastSyncedAt: (lastSyncedAt) => set({ lastSyncedAt }),
            clearSession: () => set({ token: "", user: null, lastSyncedAt: "" }),
        }),
        {
            name: "infinite-canvas:account_store",
            partialize: (state) => ({ serverUrl: state.serverUrl, token: state.token, user: state.user, lastSyncedAt: state.lastSyncedAt }),
        },
    ),
);
