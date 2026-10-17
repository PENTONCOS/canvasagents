import { expect, test } from "bun:test";

import { planAccountChange, planBootSync } from "../src/services/account-auto-sync-policy";

// Regression guard for the "signed in on another device but the canvas is empty" bug: a session
// restored from storage never changes the account token, so nothing pulled until the user pressed
// "sync now". The boot plan must ask for a pull whenever a token is already present.

test("boot: no token never pulls", () => {
    expect(planBootSync("", false)).toBe("none");
    expect(planBootSync("", true)).toBe("none");
});

test("boot: a restored session pulls once the canvas store has hydrated", () => {
    expect(planBootSync("tok", true)).toBe("now");
});

test("boot: a restored session waits for hydration rather than merging an empty local state", () => {
    expect(planBootSync("tok", false)).toBe("after-hydration");
});

test("account change: an unchanged token is ignored", () => {
    expect(planAccountChange("tok", "tok", "u1", "u1")).toBe("ignore");
    expect(planAccountChange("", "", "", "")).toBe("ignore");
});

test("account change: a cleared token cancels pending work", () => {
    expect(planAccountChange("tok", "", "u1", "u1")).toBe("cancel");
});

test("account change: a first login syncs", () => {
    expect(planAccountChange("", "tok", "u1", "")).toBe("sync");
    expect(planAccountChange("", "tok", "u1", "u1")).toBe("sync");
});

test("account change: a re-login with a new token still syncs", () => {
    // The old code returned early for any non-empty previous token, so a stale token on another
    // device meant logging in never pulled the cloud copy.
    expect(planAccountChange("stale", "fresh", "u1", "u1")).toBe("sync");
});

test("account change: a different account wipes local data before syncing", () => {
    expect(planAccountChange("tok", "next", "u2", "u1")).toBe("switch");
    expect(planAccountChange("", "next", "u2", "u1")).toBe("switch");
});
