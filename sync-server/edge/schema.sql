-- CanvasAgents Sync Server — Cloudflare D1 schema.
-- Apply with:
--   npx wrangler d1 execute canvasagents-sync --file=schema.sql --remote
--
-- Only account + manifest data lives in D1. File blobs live in R2 (binding FILES),
-- so there is deliberately no `files` table here.

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
