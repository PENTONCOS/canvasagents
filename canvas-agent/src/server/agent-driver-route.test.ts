import assert from "node:assert/strict";
import test from "node:test";

import { isKnownAgentDriver, rewriteAgentDriverPath } from "./agent-driver-route.js";

test("rewriteAgentDriverPath keeps canonical codex paths intact", () => {
    assert.deepEqual(rewriteAgentDriverPath("/agent/codex/threads"), {
        driver: "codex",
        canonicalPath: "/agent/codex/threads",
    });
    assert.deepEqual(rewriteAgentDriverPath("/agent/codex/threads/thread-1"), {
        driver: "codex",
        canonicalPath: "/agent/codex/threads/thread-1",
    });
});

test("rewriteAgentDriverPath rewrites unknown-but-known drivers onto codex", () => {
    // Currently only codex is known; the rewrite is identity for it. This guards the
    // contract so adding a second driver alias later only extends KNOWN_AGENT_DRIVERS.
    assert.deepEqual(rewriteAgentDriverPath("/agent/codex"), { driver: "codex", canonicalPath: "/agent/codex" });
});

test("rewriteAgentDriverPath returns null for unknown drivers and non-agent paths", () => {
    assert.equal(rewriteAgentDriverPath("/agent/claude/threads"), null);
    assert.equal(rewriteAgentDriverPath("/agent/"), null);
    assert.equal(rewriteAgentDriverPath("/canvas/state"), null);
    assert.equal(rewriteAgentDriverPath("/agent/codexx/threads"), null);
});

test("isKnownAgentDriver narrows correctly", () => {
    assert.equal(isKnownAgentDriver("codex"), true);
    assert.equal(isKnownAgentDriver("claude"), false);
});
