/**
 * CanvasAgents Sync Server — Cloudflare Workers core.
 *
 * Framework-agnostic: createApp({ db, files, now }) returns
 * async function handle(request): Promise<Response>.
 *
 *   db     minimal D1-compatible adapter: db.prepare(sql).bind(...args).first()/.all()/.run()
 *   files  minimal R2-compatible adapter: files.get(key) / files.put(key, body, { httpMetadata }) / files.delete(key)
 *   now    () => number (epoch ms), injected so tests can control time
 *
 * API (same contract as sync-server/index.js):
 *   GET    /health
 *   POST   /v1/auth/register {username, password} -> {token, user}
 *   POST   /v1/auth/login    {username, password} -> {token, user}
 *   POST   /v1/auth/logout                       (Bearer) -> {ok:true}
 *   GET    /v1/me                                (Bearer) -> {user}
 *   GET    /v1/domains/:domain/manifest          (Bearer) -> stored manifest JSON | 404
 *   PUT    /v1/domains/:domain/manifest          (Bearer) JSON body -> {updatedAt}
 *   GET    /v1/domains/:domain/files/:key        (Bearer) -> binary | 404
 *   PUT    /v1/domains/:domain/files/:key        (Bearer) raw body -> {ok:true, bytes}
 *
 * Passwords use PBKDF2-SHA256 (Web Crypto). Workers has no scrypt, so accounts
 * created by the old Node server do not carry over — see README.
 */
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
};
const DOMAINS = new Set(["canvas", "assets", "image-workbench", "video-workbench", "config"]);
const MAX_JSON_BYTES = 64 * 1024 * 1024;
// Cloudflare Free caps a request body at 100MB, so the file ceiling sits just below it.
const MAX_FILE_BYTES = 90 * 1024 * 1024;
const TOKEN_TTL_MS = 365 * 24 * 3600 * 1000;
const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;
const PBKDF2_ITERATIONS = 100000;

function httpError(status, message) {
    return Object.assign(new Error(message), { status });
}

function bytesToHex(bytes) {
    let out = "";
    for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
    return out;
}

function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i += 1) {
        out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

function randomBytes(byteLength) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return bytes;
}

function randomHex(byteLength) {
    return bytesToHex(randomBytes(byteLength));
}

function base64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

async function hashToken(token) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    return bytesToHex(new Uint8Array(digest));
}

function newToken() {
    return `cas_${base64Url(randomBytes(24))}`;
}

async function derivePasswordHex(password, saltHex, iterations) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: hexToBytes(saltHex), iterations, hash: "SHA-256" },
        key,
        256,
    );
    return bytesToHex(new Uint8Array(bits));
}

async function hashPassword(password, saltHex) {
    const hashHex = await derivePasswordHex(password, saltHex, PBKDF2_ITERATIONS);
    return `pbkdf2$${PBKDF2_ITERATIONS}$${saltHex}$${hashHex}`;
}

function parsePasswordHash(stored) {
    const parts = String(stored || "").split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2") return null;
    const iterations = Number(parts[1]);
    if (!Number.isInteger(iterations) || iterations <= 0) return null;
    if (!/^[0-9a-f]+$/i.test(parts[2]) || parts[2].length !== 32) return null;
    if (!/^[0-9a-f]+$/i.test(parts[3])) return null;
    return { iterations, saltHex: parts[2], hashHex: parts[3] };
}

async function verifyPassword(password, stored) {
    const parsed = parsePasswordHash(stored);
    if (!parsed) return false;
    const actual = await derivePasswordHex(password, parsed.saltHex, parsed.iterations);
    return constantTimeEqual(actual, parsed.hashHex);
}

async function readBody(request, limit, message) {
    const stream = request.body;
    if (!stream) return new Uint8Array(0);
    const reader = stream.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
            try {
                await reader.cancel();
            } catch (error) {
                console.warn(`[sync-edge] failed to cancel oversized body: ${error?.message}`);
            }
            throw httpError(413, message);
        }
        chunks.push(value);
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

async function objectToBytes(object) {
    if (typeof object.arrayBuffer === "function") {
        return new Uint8Array(await object.arrayBuffer());
    }
    const body = object.body;
    if (body == null) return new Uint8Array(0);
    if (typeof body === "string") return new TextEncoder().encode(body);
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (typeof body.getReader === "function") {
        return new Uint8Array(await new Response(body).arrayBuffer());
    }
    throw new Error("unsupported R2 object body");
}

export function createApp({ db, files, now = () => Date.now() }) {
    const stmts = {
        userByName: (username) => db.prepare("SELECT * FROM users WHERE username = ?").bind(username).first(),
        userById: (id) => db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first(),
        insertUser: (id, username, displayName, salt, hash, createdAt) =>
            db.prepare("INSERT INTO users (id, username, display_name, pass_salt, pass_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(id, username, displayName, salt, hash, createdAt).run(),
        insertToken: (tokenHash, userId, expiresAt, createdAt) =>
            db.prepare("INSERT INTO tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
                .bind(tokenHash, userId, expiresAt, createdAt).run(),
        token: (tokenHash) => db.prepare("SELECT t.user_id, t.expires_at FROM tokens t WHERE t.token_hash = ?")
            .bind(tokenHash).first(),
        deleteToken: (tokenHash) => db.prepare("DELETE FROM tokens WHERE token_hash = ?").bind(tokenHash).run(),
        getManifest: (userId, domain) => db.prepare("SELECT body FROM manifests WHERE user_id = ? AND domain = ?")
            .bind(userId, domain).first(),
        putManifest: (userId, domain, body, updatedAt) =>
            db.prepare(`INSERT INTO manifests (user_id, domain, body, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id, domain) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`)
                .bind(userId, domain, body, updatedAt).run(),
    };

    function json(status, body) {
        return new Response(JSON.stringify(body), {
            status,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
        });
    }

    function raw(status, bytes, contentType) {
        return new Response(bytes, {
            status,
            headers: { ...CORS_HEADERS, "Content-Type": contentType },
        });
    }

    async function bearerUserId(request) {
        const header = request.headers.get("authorization") || "";
        const match = /^Bearer\s+(.+)$/i.exec(header);
        if (!match) return null;
        const tokenHash = await hashToken(match[1].trim());
        const row = await stmts.token(tokenHash);
        if (!row) return null;
        if (row.expires_at < now()) {
            await stmts.deleteToken(tokenHash);
            return null;
        }
        return row.user_id;
    }

    function publicUser(row) {
        return { id: row.id, username: row.username, displayName: row.display_name };
    }

    async function issueToken(userId) {
        const token = newToken();
        const createdAt = now();
        await stmts.insertToken(await hashToken(token), userId, createdAt + TOKEN_TTL_MS, createdAt);
        return token;
    }

    function fileKeyFor(userId, domain, fileKey) {
        return `files/${userId}/${domain}/${fileKey}`;
    }

    return async function handle(request) {
        const url = new URL(request.url);
        const parts = url.pathname.split("/").filter(Boolean);
        try {
            if (request.method === "OPTIONS") {
                return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
            }
            if (request.method === "GET" && url.pathname === "/health") {
                return json(200, { ok: true, now: new Date(now()).toISOString() });
            }

            if (parts[0] === "v1" && parts[1] === "auth" && request.method === "POST") {
                const bytes = await readBody(request, MAX_JSON_BYTES, "manifest exceeds the 64MB limit");
                const body = JSON.parse(new TextDecoder().decode(bytes) || "{}");
                const username = String(body.username || "").trim();
                const password = String(body.password || "");
                const displayName = String(body.displayName || "").trim() || username;
                if (parts[2] === "register") {
                    if (!USERNAME_PATTERN.test(username)) throw httpError(400, "invalid username (3-32 chars: a-z 0-9 _ -)");
                    if (password.length < 6) throw httpError(400, "password must be at least 6 characters");
                    if (await stmts.userByName(username)) throw httpError(409, "username already taken");
                    const salt = randomHex(16);
                    const id = randomHex(12);
                    await stmts.insertUser(id, username, displayName, salt, await hashPassword(password, salt), now());
                    return json(200, { token: await issueToken(id), user: publicUser(await stmts.userById(id)) });
                }
                if (parts[2] === "login") {
                    const row = await stmts.userByName(username);
                    if (!row || !(await verifyPassword(password, row.pass_hash))) {
                        throw httpError(401, "invalid username or password");
                    }
                    return json(200, { token: await issueToken(row.id), user: publicUser(row) });
                }
                if (parts[2] === "logout") {
                    const header = request.headers.get("authorization") || "";
                    const match = /^Bearer\s+(.+)$/i.exec(header);
                    if (match) await stmts.deleteToken(await hashToken(match[1].trim()));
                    return json(200, { ok: true });
                }
            }

            if (parts[0] === "v1" && parts[1] === "me" && request.method === "GET") {
                const userId = await bearerUserId(request);
                if (!userId) throw httpError(401, "unauthorized");
                const row = await stmts.userById(userId);
                if (!row) throw httpError(401, "unauthorized");
                return json(200, { user: publicUser(row) });
            }

            if (parts[0] === "v1" && parts[1] === "domains" && (request.method === "GET" || request.method === "PUT")) {
                const userId = await bearerUserId(request);
                if (!userId) throw httpError(401, "unauthorized");
                const domain = parts[2];
                if (!DOMAINS.has(domain)) throw httpError(404, "unknown domain");
                if (parts[3] === "manifest") {
                    if (request.method === "GET") {
                        const row = await stmts.getManifest(userId, domain);
                        if (!row) throw httpError(404, "not found");
                        return raw(200, row.body, "application/json; charset=utf-8");
                    }
                    const bytes = await readBody(request, MAX_JSON_BYTES, "manifest exceeds the 64MB limit");
                    const text = new TextDecoder().decode(bytes);
                    JSON.parse(text);
                    const updatedAt = now();
                    await stmts.putManifest(userId, domain, text, updatedAt);
                    return json(200, { updatedAt: new Date(updatedAt).toISOString() });
                }
                if (parts[3] === "files" && parts[4]) {
                    const fileKey = decodeURIComponent(parts.slice(4).join("/"));
                    const key = fileKeyFor(userId, domain, fileKey);
                    if (request.method === "GET") {
                        const object = await files.get(key);
                        if (!object) throw httpError(404, "not found");
                        const contentType = object.httpMetadata?.contentType || "application/octet-stream";
                        return raw(200, await objectToBytes(object), contentType);
                    }
                    const data = await readBody(
                        request,
                        MAX_FILE_BYTES,
                        "file exceeds the 90MB limit (Cloudflare Free caps a request body at 100MB)",
                    );
                    const contentType = request.headers.get("content-type") || "application/octet-stream";
                    await files.put(key, data, { httpMetadata: { contentType } });
                    return json(200, { ok: true, bytes: data.length });
                }
            }

            throw httpError(404, "not found");
        } catch (error) {
            const status = error?.status || 500;
            if (status >= 500) console.error(`[sync-edge] ${request.method} ${url.pathname}:`, error);
            return json(status, { error: error?.message || "internal error" });
        }
    };
}
