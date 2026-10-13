# CanvasAgents Sync Server — Cloudflare Workers edition

The same HTTP API as `../index.js` (the zero-dependency Node server), ported to a
Cloudflare Worker backed by D1 (accounts, tokens, manifests) and R2 (file blobs).
The existing web client talks to it unchanged.

## Deploy

```sh
# 1. Create the D1 database and copy its database_id into wrangler.toml
npx wrangler d1 create canvasagents-sync

# 2. Create the R2 bucket for file blobs
npx wrangler r2 bucket create canvasagents-sync-files

# 3. Apply the schema to the remote database
npx wrangler d1 execute canvasagents-sync --file=schema.sql --remote

# 4. Deploy the Worker
npx wrangler deploy
```

Wrangler prints the public URL on the last line, e.g.:

```
https://sync.canvasagents-sync.workers.dev
```

Use that URL as the sync server address in the CanvasAgents web app.

## API

Identical to the Node server:

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | no auth |
| POST | `/v1/auth/register` | `{username, password}` -> `{token, user}` |
| POST | `/v1/auth/login` | `{username, password}` -> `{token, user}` |
| POST | `/v1/auth/logout` | Bearer -> `{ok:true}` |
| GET | `/v1/me` | Bearer -> `{user}` |
| GET | `/v1/domains/:domain/manifest` | Bearer -> stored manifest JSON / 404 |
| PUT | `/v1/domains/:domain/manifest` | Bearer, JSON -> `{updatedAt}` |
| GET | `/v1/domains/:domain/files/:key` | Bearer -> binary / 404 |
| PUT | `/v1/domains/:domain/files/:key` | Bearer, raw body -> `{ok:true, bytes}` |

Allowed domains: `canvas`, `assets`, `image-workbench`, `video-workbench`, `config`.

Limits: manifest bodies are capped at 64MB, file uploads at 90MB (Cloudflare Free
caps a request body at 100MB, so larger uploads return `413`).

## Passwords

Workers Web Crypto has no `scrypt`, so passwords here use PBKDF2-SHA256
(100000 iterations, 16-byte random salt), stored as
`pbkdf2$<iters>$<saltHex>$<hashHex>`. **Accounts created by the old Node/scrypt
server do not carry over** — a fresh deploy starts with an empty user table, and
users re-register.

## Tests

The app core (`src/app.js`) is runtime-agnostic and runs under Node with a fake
D1 (node:sqlite) and an in-memory Map as fake R2:

```sh
node --test test/*.test.mjs
```
