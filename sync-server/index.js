#!/usr/bin/env node
/**
 * CanvasAgents Sync Server — self-hosted account & data sync for the web app.
 *
 * Zero third-party dependencies: node:http + node:sqlite + node:crypto.
 *
 *   node index.js                 # listens on 127.0.0.1:17372 (env PORT/HOST to override)
 *   PORT=0.0.0.0:8080 node index.js
 *
 * API (all JSON unless noted):
 *   GET    /health
 *   POST   /v1/auth/register {username, password} -> {token, user}
 *   POST   /v1/auth/login    {username, password} -> {token, user}
 *   POST   /v1/auth/logout                       (Bearer) -> {ok:true}
 *   GET    /v1/me                                (Bearer) -> {user}
 *   GET    /v1/domains/:domain/manifest          (Bearer) -> stored manifest JSON | 404
 *   PUT    /v1/domains/:domain/manifest          (Bearer) JSON body -> {updatedAt}
 *   GET    /v1/domains/:domain/files/:key        (Bearer) -> binary | 404
 *   PUT    /v1/domains/:domain/files/:key        (Bearer) raw body -> {ok:true}
 */
import { createServer as createHttpServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, hostname } from "node:os";
import { pathToFileURL } from "node:url";

const DEFAULT_PORT = 17372;
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
};
const DOMAINS = new Set(["canvas", "assets", "image-workbench", "video-workbench", "config"]);
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const TOKEN_TTL_MS = 365 * 24 * 3600 * 1000;
const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;

export function defaultDbPath() {
    return join(homedir(), ".canvasagents", "sync-server.db");
}

function hashPassword(password, salt) {
    return scryptSync(password, salt, 64).toString("hex");
}

function verifyPassword(password, salt, expectedHex) {
    const actual = Buffer.from(hashPassword(password, salt), "hex");
    const expected = Buffer.from(expectedHex, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hashToken(token) {
    return createHash("sha256").update(token).digest("hex");
}

function newToken() {
    return `cas_${randomBytes(24).toString("base64url")}`;
}

export function createSyncServer(options = {}) {
    const dbPath = options.dbPath || defaultDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            pass_salt TEXT NOT NULL,
            pass_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tokens (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS manifests (
            user_id TEXT NOT NULL,
            domain TEXT NOT NULL,
            body TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (user_id, domain)
        );
        CREATE TABLE IF NOT EXISTS files (
            user_id TEXT NOT NULL,
            domain TEXT NOT NULL,
            file_key TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            bytes INTEGER NOT NULL,
            data BLOB NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (user_id, domain, file_key)
        );
    `);

    const stmts = {
        userByName: db.prepare("SELECT * FROM users WHERE username = ?"),
        userById: db.prepare("SELECT * FROM users WHERE id = ?"),
        insertUser: db.prepare("INSERT INTO users (id, username, display_name, pass_salt, pass_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
        insertToken: db.prepare("INSERT INTO tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"),
        token: db.prepare("SELECT t.user_id, t.expires_at FROM tokens t WHERE t.token_hash = ?"),
        deleteToken: db.prepare("DELETE FROM tokens WHERE token_hash = ?"),
        getManifest: db.prepare("SELECT body FROM manifests WHERE user_id = ? AND domain = ?"),
        putManifest: db.prepare(`INSERT INTO manifests (user_id, domain, body, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, domain) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`),
        getFile: db.prepare("SELECT mime_type, bytes, data FROM files WHERE user_id = ? AND domain = ? AND file_key = ?"),
        putFile: db.prepare(`INSERT INTO files (user_id, domain, file_key, mime_type, bytes, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, domain, file_key) DO UPDATE SET mime_type = excluded.mime_type, bytes = excluded.bytes, data = excluded.data, updated_at = excluded.updated_at`),
    };

    function readBody(req, limit) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            req.on("data", (chunk) => {
                size += chunk.length;
                if (size > limit) {
                    reject(Object.assign(new Error("payload too large"), { status: 413 }));
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            req.on("end", () => resolve(Buffer.concat(chunks)));
            req.on("error", reject);
        });
    }

    function send(res, status, body, headers = {}) {
        const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
        for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
        res.writeHead(status, { "Content-Length": payload.length, ...headers });
        res.end(payload);
    }

    function sendJson(res, status, body) {
        send(res, status, body, { "Content-Type": "application/json; charset=utf-8" });
    }

    function bearerUserId(req) {
        const header = req.headers.authorization || "";
        const match = /^Bearer\s+(.+)$/i.exec(header);
        if (!match) return null;
        const row = stmts.token.get(hashToken(match[1].trim()));
        if (!row) return null;
        if (row.expires_at < Date.now()) {
            stmts.deleteToken.run(hashToken(match[1].trim()));
            return null;
        }
        return row.user_id;
    }

    function publicUser(row) {
        return { id: row.id, username: row.username, displayName: row.display_name };
    }

    function issueToken(userId) {
        const token = newToken();
        stmts.insertToken.run(hashToken(token), userId, Date.now() + TOKEN_TTL_MS, Date.now());
        return token;
    }

    async function handler(req, res) {
        const url = new URL(req.url || "/", "http://local");
        const parts = url.pathname.split("/").filter(Boolean);
        try {
            if (req.method === "OPTIONS") {
                for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
                res.writeHead(204, { "Content-Length": 0 });
                res.end();
                return;
            }
            if (req.method === "GET" && url.pathname === "/health") {
                sendJson(res, 200, { ok: true, host: hostname(), now: new Date().toISOString() });
                return;
            }

            if (parts[0] === "v1" && parts[1] === "auth" && req.method === "POST") {
                const body = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString("utf8") || "{}");
                const username = String(body.username || "").trim();
                const password = String(body.password || "");
                if (parts[2] === "register") {
                    if (!USERNAME_PATTERN.test(username)) throw Object.assign(new Error("invalid username (3-32 chars: a-z 0-9 _ -)"), { status: 400 });
                    if (password.length < 6) throw Object.assign(new Error("password must be at least 6 characters"), { status: 400 });
                    if (stmts.userByName.get(username)) throw Object.assign(new Error("username already taken"), { status: 409 });
                    const salt = randomBytes(16).toString("hex");
                    const id = randomBytes(12).toString("hex");
                    stmts.insertUser.run(id, username, username, salt, hashPassword(password, salt), Date.now());
                    sendJson(res, 200, { token: issueToken(id), user: publicUser(stmts.userById.get(id)) });
                    return;
                }
                if (parts[2] === "login") {
                    const row = stmts.userByName.get(username);
                    if (!row || !verifyPassword(password, row.pass_salt, row.pass_hash)) {
                        throw Object.assign(new Error("invalid username or password"), { status: 401 });
                    }
                    sendJson(res, 200, { token: issueToken(row.id), user: publicUser(row) });
                    return;
                }
                if (parts[2] === "logout") {
                    const header = req.headers.authorization || "";
                    const match = /^Bearer\s+(.+)$/i.exec(header);
                    if (match) stmts.deleteToken.run(hashToken(match[1].trim()));
                    sendJson(res, 200, { ok: true });
                    return;
                }
            }

            if (parts[0] === "v1" && parts[1] === "me" && req.method === "GET") {
                const userId = bearerUserId(req);
                if (!userId) throw Object.assign(new Error("unauthorized"), { status: 401 });
                const row = stmts.userById.get(userId);
                if (!row) throw Object.assign(new Error("unauthorized"), { status: 401 });
                sendJson(res, 200, { user: publicUser(row) });
                return;
            }

            if (parts[0] === "v1" && parts[1] === "domains" && (req.method === "GET" || req.method === "PUT")) {
                const userId = bearerUserId(req);
                if (!userId) throw Object.assign(new Error("unauthorized"), { status: 401 });
                const domain = parts[2];
                if (!DOMAINS.has(domain)) throw Object.assign(new Error("unknown domain"), { status: 404 });
                if (parts[3] === "manifest") {
                    if (req.method === "GET") {
                        const row = stmts.getManifest.get(userId, domain);
                        if (!row) throw Object.assign(new Error("not found"), { status: 404 });
                        send(res, 200, Buffer.from(row.body), { "Content-Type": "application/json; charset=utf-8" });
                        return;
                    }
                    const body = await readBody(req, MAX_JSON_BYTES);
                    JSON.parse(body.toString("utf8"));
                    const updatedAt = Date.now();
                    stmts.putManifest.run(userId, domain, body.toString("utf8"), updatedAt);
                    sendJson(res, 200, { updatedAt: new Date(updatedAt).toISOString() });
                    return;
                }
                if (parts[3] === "files" && parts[4]) {
                    const fileKey = decodeURIComponent(parts.slice(4).join("/"));
                    if (req.method === "GET") {
                        const row = stmts.getFile.get(userId, domain, fileKey);
                        if (!row) throw Object.assign(new Error("not found"), { status: 404 });
                        send(res, 200, Buffer.from(row.data), { "Content-Type": row.mime_type });
                        return;
                    }
                    const data = await readBody(req, MAX_FILE_BYTES);
                    stmts.putFile.run(userId, domain, fileKey, req.headers["content-type"] || "application/octet-stream", data.length, data, Date.now());
                    sendJson(res, 200, { ok: true, bytes: data.length });
                    return;
                }
            }

            throw Object.assign(new Error("not found"), { status: 404 });
        } catch (error) {
            const status = error?.status || 500;
            if (status >= 500) console.error(`[sync-server] ${req.method} ${url.pathname}:`, error);
            sendJson(res, status, { error: error?.message || "internal error" });
        }
    }

    const server = createHttpServer(handler);
    return { server, db };
}

export async function startSyncServer(options = {}) {
    const { server } = createSyncServer(options);
    const listenTarget = options.listen || process.env.LISTEN || process.env.PORT || String(DEFAULT_PORT);
    const [host = "127.0.0.1", port = DEFAULT_PORT] = /^\[?([^\]]+)\]?:([\d]+)$/.test(listenTarget)
        ? [RegExp.$1, Number(RegExp.$2)]
        : ["127.0.0.1", Number(listenTarget)];
    await new Promise((resolve) => server.listen(port, host, resolve));
    return { server, host, port };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    const { server } = createSyncServer({ dbPath: process.env.DB_PATH || undefined });
    const host = process.env.LISTEN_HOST || "127.0.0.1";
    const port = Number(process.env.PORT || DEFAULT_PORT);
    server.listen(port, host, () => {
        console.log(`[canvasagents-sync-server] listening on http://${host}:${port}`);
        console.log(`[canvasagents-sync-server] db: ${process.env.DB_PATH || defaultDbPath()}`);
        console.log("[canvasagents-sync-server] domains: canvas, assets, image-workbench, video-workbench, config");
    });
}
