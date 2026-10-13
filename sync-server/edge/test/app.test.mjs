import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { before, describe, it } from "node:test";

import { createApp } from "../src/app.js";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

// Minimal D1-compatible adapter over node:sqlite (prepare/bind/first/all/run).
function createFakeDb() {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA);
    return {
        prepare(sql) {
            return {
                bind(...args) {
                    const statement = db.prepare(sql);
                    return {
                        async first() {
                            const row = statement.get(...args);
                            return row === undefined ? null : row;
                        },
                        async all() {
                            return { results: statement.all(...args) };
                        },
                        async run() {
                            const info = statement.run(...args);
                            return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
                        },
                    };
                },
            };
        },
    };
}

// Minimal R2-compatible adapter over an in-memory Map.
function createFakeFiles() {
    const store = new Map();
    return {
        async get(key) {
            const entry = store.get(key);
            if (!entry) return null;
            return {
                httpMetadata: { contentType: entry.contentType },
                async arrayBuffer() {
                    return entry.bytes.buffer.slice(entry.bytes.byteOffset, entry.bytes.byteOffset + entry.bytes.byteLength);
                },
            };
        },
        async put(key, body, options = {}) {
            const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
            store.set(key, { bytes, contentType: options.httpMetadata?.contentType || "application/octet-stream" });
        },
        async delete(key) {
            store.delete(key);
        },
    };
}

describe("canvasagents-sync-edge", () => {
    let app;
    let tokenA;

    before(() => {
        app = createApp({ db: createFakeDb(), files: createFakeFiles(), now: () => Date.now() });
    });

    async function api(method, path, { token, json, body, contentType } = {}) {
        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        if (json !== undefined) {
            body = JSON.stringify(json);
            contentType = "application/json";
        }
        if (contentType) headers["Content-Type"] = contentType;
        const response = await app(new Request(`https://sync.test${path}`, { method, headers, body }));
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
        const response = await app(new Request("https://sync.test/v1/me", { method: "OPTIONS" }));
        assert.equal(response.status, 204);
        assert.equal(response.headers.get("access-control-allow-origin"), "*");
        assert.ok((response.headers.get("access-control-allow-headers") || "").includes("Authorization"));
    });
});
