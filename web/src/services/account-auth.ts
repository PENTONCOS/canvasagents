import i18n from "@/i18n";
import { accountRequest, accountRequestInit, accountRequestJson, resolveServerUrl } from "@/services/account-client";
import { useAccountStore } from "@/stores/use-account-store";
import type { AccountUser } from "@/stores/use-account-store";

type AuthPayload = { token: string; user: AccountUser };

function authError(status: number, fallback: string) {
    return new Error(i18n.t(`config.account.errors.status${status}`, { defaultValue: "" }) || fallback);
}

export async function registerAccount(username: string, password: string, displayName: string): Promise<AuthPayload> {
    const { status, data } = await accountRequestJson<AuthPayload | { error: string }>("/v1/auth/register", accountRequestInit("POST", JSON.stringify({ username, password, displayName: displayName || username }), "application/json"));
    if (status !== 200 || !("token" in data)) throw authError(status, i18n.t("config.account.errors.registerFailed"));
    useAccountStore.getState().setServerUrl(resolveServerUrl());
    useAccountStore.getState().setSession(data);
    return data;
}

export async function loginAccount(username: string, password: string): Promise<AuthPayload> {
    const { status, data } = await accountRequestJson<AuthPayload | { error: string }>("/v1/auth/login", accountRequestInit("POST", JSON.stringify({ username, password }), "application/json"));
    if (status !== 200 || !("token" in data)) throw authError(status, i18n.t("config.account.errors.loginFailed"));
    useAccountStore.getState().setServerUrl(resolveServerUrl());
    useAccountStore.getState().setSession(data);
    return data;
}

export async function fetchCurrentUser(): Promise<AccountUser | null> {
    const { token } = useAccountStore.getState();
    if (!token) return null;
    const { status, data } = await accountRequestJson<{ user: AccountUser } | { error: string }>("/v1/me", accountRequestInit("GET"));
    if (status !== 200 || !("user" in data)) {
        if (status === 401) useAccountStore.getState().clearSession();
        return null;
    }
    useAccountStore.getState().setUser(data.user);
    return data.user;
}

export async function logoutAccount(): Promise<void> {
    const { token } = useAccountStore.getState();
    if (token) {
        try {
            await accountRequest("/v1/auth/logout", accountRequestInit("POST"));
        } catch {
            // best-effort: local session is cleared regardless
        }
    }
    useAccountStore.getState().clearSession();
}
