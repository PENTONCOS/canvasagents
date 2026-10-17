// Pure decision policy for the account auto-sync coordinator (account-auto-sync.ts). Kept free of
// stores and DOM so the boot and account-change rules can be unit tested directly, and so a future
// refactor cannot quietly drop the "a restored session still pulls" behaviour.

export type BootSyncPlan = "none" | "now" | "after-hydration";
export type AccountChangePlan = "ignore" | "cancel" | "sync" | "switch";

/**
 * A restored session (token already present at boot) must still pull once, otherwise a device that
 * signs in and changes nothing shows an empty canvas until the user edits or presses "sync now".
 * The pull waits for the canvas store to finish restoring from IndexedDB so a not-yet-hydrated
 * (empty) local state can never be merged over the cloud copy.
 */
export function planBootSync(token: string, canvasHydrated: boolean): BootSyncPlan {
    if (!token) return "none";
    return canvasHydrated ? "now" : "after-hydration";
}

/**
 * Token / identity change on the account store:
 *  - unchanged token                -> ignore
 *  - token cleared                  -> cancel pending work (logout keeps local data on purpose)
 *  - new non-empty token            -> sync: a re-login must pull even into the same account, so a
 *                                      stale token on another device cannot leave its canvas empty
 *  - a *different* account id       -> switch: wipe local data first, then sync
 */
export function planAccountChange(previousToken: string, nextToken: string, accountId: string, storedAccountId: string): AccountChangePlan {
    if (nextToken === previousToken) return "ignore";
    if (!nextToken) return "cancel";
    if (accountId && storedAccountId && storedAccountId !== accountId) return "switch";
    return "sync";
}
