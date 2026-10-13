import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { createSyncServer } from "../index.js";

describe("canvasagents-sync-server", () => {
    let server;
    let baseUrl;
    let dbDir;
    let tokenA;

    before(async () => {
        dbDir = mkdtempSync(join(tmpdir(), "canvasagents-sync-test-"));
        const created = createSyncServer({ dbPath: join(dbDir, "test.db") });
        server = created.server;
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    after(async () => {
        await new Promise((resolve) => server.close(resolve));
        rmSync(dbDir, { recursive: true, force: true });
    });

    async function api(method, path, { token, json, body, contentType } = {}) {
        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        if (json !== undefined) {
            body = Buffer.from(JSON.stringify(json));
            contentType = "application/json";
        }
        if (contentType) headers["Content-Type"] = contentType;
        const response = await fetch(`${baseUrl}${path}`, { method, headers, body });
        const raw = await response.arrayBuffer();
        const text = Buffer.from(raw).toString("utf8");
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            data = text;
        }
        return { status: response.status, data, raw, headers: response.headers };
    }

    it("health endpoint answers without auth", async () => {
        const { status, data } = await api("GET", "/health");
        assert.equal(status, 200);
        assert.equal(data.ok, true);
    });

    it("registers a user and returns a session token", async () => {
        const { status, data } = await api("POST", "/v1/auth/register", { json: { username: "alice", password: "secret123" } });
        assert.equal(status, 200);
        assert.ok(data.token.startsWith("cas_"));
        assert.equal(data.user.username, "alice");
        assert.equal(data.user.displayName, "alice");
        tokenA = data.token;
    });

    it("rejects duplicate username and weak password", async () => {
        const dup = await api("POST", "/v1/auth/register", { json: { username: "alice", password: "secret123" } });
        assert.equal(dup.status, 409);
        const weak = await api("POST", "/v1/auth/register", { json: { username: "bob", password: "123" } });
        assert.equal(weak.status, 400);
    });

    it("logs in with correct credentials and rejects wrong ones", async () => {
        const ok = await api("POST", "/v1/auth/login", { json: { username: "alice", password: "secret123" } });
        assert.equal(ok.status, 200);
        assert.ok(ok.data.token.startsWith("cas_"));
        const bad = await api("POST", "/v1/auth/login", { json: { username: "alice", password: "wrong!" } });
        assert.equal(bad.status, 401);
    });

    it("guards /v1/me and domain routes behind bearer auth", async () => {
        assert.equal((await api("GET", "/v1/me")).status, 401);
        assert.equal((await api("GET", "/v1/domains/canvas/manifest")).status, 401);
        assert.equal((await api("GET", "/v1/me", { token: "cas_invalid" })).status, 401);
    });

    it("returns current user for a valid token", async () => {
        const { status, data } = await api("GET", "/v1/me", { token: tokenA });
        assert.equal(status, 200);
        assert.equal(data.user.username, "alice");
    });

    it("stores and returns a domain manifest per user", async () => {
        const missing = await api("GET", "/v1/domains/canvas/manifest", { token: tokenA });
        assert.equal(missing.status, 404);

        const manifest = { app: "canvasagents", version: 1, domain: "canvas", data: { projects: [{ id: "p1" }] }, files: [] };
        const put = await api("PUT", "/v1/domains/canvas/manifest", { token: tokenA, json: manifest });
        assert.equal(put.status, 200);
        assert.ok(put.data.updatedAt);

        const get = await api("GET", "/v1/domains/canvas/manifest", { token: tokenA });
        assert.equal(get.status, 200);
        assert.deepEqual(get.data.data.projects, [{ id: "p1" }]);
    });

    it("isolates manifests between users", async () => {
        const reg = await api("POST", "/v1/auth/register", { json: { username: "bob", password: "secret456" } });
        assert.equal(reg.status, 200);
        const tokenB = reg.data.token;
        const get = await api("GET", "/v1/domains/canvas/manifest", { token: tokenB });
        assert.equal(get.status, 404);
    });

    it("rejects unknown domains", async () => {
        const put = await api("PUT", "/v1/domains/secret/manifest", { token: tokenA, json: {} });
        assert.equal(put.status, 404);
    });

    it("stores and returns binary files", async () => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const key = encodeURIComponent("image:abc123");
        const put = await api("PUT", `/v1/domains/assets/files/${key}`, { token: tokenA, body: png, contentType: "image/png" });
        assert.equal(put.status, 200);

        const get = await api("GET", `/v1/domains/assets/files/${key}`, { token: tokenA });
        assert.equal(get.status, 200);
        assert.equal(get.headers.get("content-type"), "image/png");
        assert.deepEqual(Buffer.from(get.raw), png);

        const gone = await api("GET", `/v1/domains/assets/files/${encodeURIComponent("image:missing")}`, { token: tokenA });
        assert.equal(gone.status, 404);
    });

    it("handles config domain for settings sync", async () => {
        const put = await api("PUT", "/v1/domains/config/manifest", { token: tokenA, json: { config: { model: "gpt-5.5" }, updatedAt: "2026-10-12T00:00:00.000Z" } });
        assert.equal(put.status, 200);
        const get = await api("GET", "/v1/domains/config/manifest", { token: tokenA });
        assert.equal(get.data.config.model, "gpt-5.5");
    });

    it("revokes tokens on logout", async () => {
        const login = await api("POST", "/v1/auth/login", { json: { username: "alice", password: "secret123" } });
        const token = login.data.token;
        assert.equal((await api("GET", "/v1/me", { token })).status, 200);
        assert.equal((await api("POST", "/v1/auth/logout", { token })).status, 200);
        assert.equal((await api("GET", "/v1/me", { token })).status, 401);
    });

    it("answers CORS preflight", async () => {
        const response = await fetch(`${baseUrl}/v1/me`, { method: "OPTIONS" });
        assert.equal(response.status, 204);
        assert.equal(response.headers.get("access-control-allow-origin"), "*");
        assert.ok((response.headers.get("access-control-allow-headers") || "").includes("Authorization"));
    });
});
