/**
 * CanvasAgents Sync Server — Cloudflare Worker entry point.
 *
 * Binds env.DB (D1) and env.FILES (R2) into the adapters that createApp expects,
 * then delegates every request. Imports cleanly under Node: no Cloudflare-only
 * globals are touched at module scope, so the module can be bundled or imported
 * without a Workers runtime present.
 */
import { createApp } from "./app.js";

function createDbAdapter(db) {
    if (!db || typeof db.prepare !== "function") {
        throw new Error("missing D1 binding: DB");
    }
    return db;
}

function createFileAdapter(files) {
    if (!files || typeof files.get !== "function" || typeof files.put !== "function") {
        throw new Error("missing R2 binding: FILES");
    }
    return files;
}

export default {
    async fetch(request, env) {
        const app = createApp({
            db: createDbAdapter(env?.DB),
            files: createFileAdapter(env?.FILES),
            now: () => Date.now(),
        });
        return app(request);
    },
};
