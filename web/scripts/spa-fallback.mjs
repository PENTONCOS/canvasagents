#!/usr/bin/env node
// Surge (and most static hosts) serve `200.html` as the SPA fallback for any
// URL that does not match a real file. The app uses path routing
// (createBrowserRouter with /canvas, /canvas/:id), so without this fallback a
// hard refresh on /canvas returns 404. Vite only emits index.html, so copy it.
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const index = join(webRoot, "dist", "index.html");
const fallback = join(webRoot, "dist", "200.html");

if (!existsSync(index)) {
    console.error(`[spa-fallback] missing ${index}; run the vite build first`);
    process.exit(1);
}

copyFileSync(index, fallback);
console.log(`[spa-fallback] wrote ${fallback}`);
