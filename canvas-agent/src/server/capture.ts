import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { CONFIG_DIR } from "../config.js";

const run = promisify(execFile);

/** 产物墙目录：与桥配置同 home，不进仓库。 */
export const WALL_DIR = path.join(CONFIG_DIR, "wall");
const HELPER_DIR = path.join(CONFIG_DIR, "bin");
const HELPER_SRC = path.join(HELPER_DIR, "winid.c");
const HELPER_BIN = path.join(HELPER_DIR, "winid");

/** 目录保留上限：超出后按写入时间滚动删除最旧文件。 */
export const MAX_WALL_FILES = 200;
/** 同一 nodeId 在该窗口内重复触发只截一次，避免连发刷屏。 */
const DEDUPE_MS = 5000;
/** 小于该体积的截图判为「权限缺失/黑图」而非真实产物（画布窗口实测 >1MB）。 */
const MIN_CAPTURE_BYTES = 20 * 1024;

const WINID_SOURCE = `#include <CoreGraphics/CoreGraphics.h>
#include <stdio.h>
#include <string.h>
int main(void) {
    CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (!list) return 1;
    for (CFIndex i = 0; i < CFArrayGetCount(list); i++) {
        CFDictionaryRef w = CFArrayGetValueAtIndex(list, i);
        CFNumberRef num = CFDictionaryGetValue(w, kCGWindowNumber);
        CFStringRef owner = CFDictionaryGetValue(w, kCGWindowOwnerName);
        CFStringRef name = CFDictionaryGetValue(w, kCGWindowName);
        int n = -1;
        if (num) CFNumberGetValue(num, kCFNumberIntType, &n);
        char ob[256] = {0}, nb[512] = {0};
        if (owner) CFStringGetCString(owner, ob, sizeof(ob), kCFStringEncodingUTF8);
        if (name) CFStringGetCString(name, nb, sizeof(nb), kCFStringEncodingUTF8);
        printf("%d\\t%s\\t%s\\n", n, ob, nb);
    }
    return 0;
}
`;

export type WallEntry = { file: string; url: string; nodeId?: string; tag?: string; bytes: number; createdAt: number };
export type CaptureErrorCode = "WINDOW_NOT_FOUND" | "SCREEN_PERMISSION" | "HELPER_UNAVAILABLE" | "CAPTURE_FAILED";
export type CaptureResult = { ok: true; file: string; url: string; bytes: number } | { ok: false; code: CaptureErrorCode; error: string };

const lastCaptureAt = new Map<string, number>();

/** 文件名安全化：只留字母数字下划线横线，防目录穿越。 */
export function sanitizeNodeId(value: unknown) {
    return String(value ?? "").replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 48);
}

export function wallFileName(timestamp: number, nodeId: string) {
    return `${timestamp}${nodeId ? `-${nodeId}` : ""}.png`;
}

export function parseWallFileName(name: string) {
    const match = /^(\d+)(?:-([A-Za-z0-9_-]+))?\.png$/.exec(name);
    if (!match) return null;
    return { createdAt: Number(match[1]), nodeId: match[2] || "" };
}

/** 只允许读取墙目录下的裸文件名。 */
export function isSafeWallFile(file: string) {
    return Boolean(file) && path.basename(file) === file && /\.png$/i.test(file);
}

/** 编译（并缓存）窗口枚举小工具；无 clang 时给出结构化错误。 */
async function ensureWinIdHelper() {
    try {
        await stat(HELPER_BIN);
        return HELPER_BIN;
    } catch {
        /* 首次调用需要编译 */
    }
    try {
        await mkdir(HELPER_DIR, { recursive: true });
        await writeFile(HELPER_SRC, WINID_SOURCE, "utf8");
        await run("clang", ["-O2", "-framework", "CoreGraphics", "-framework", "CoreFoundation", "-o", HELPER_BIN, HELPER_SRC], { timeout: 60_000 });
        return HELPER_BIN;
    } catch (error) {
        throw Object.assign(new Error(`无法编译窗口枚举工具：${(error as Error).message}`), { captureCode: "HELPER_UNAVAILABLE" as CaptureErrorCode });
    }
}

/** 枚举屏幕上的窗口，返回 { id, owner, name }。 */
export async function listWindows() {
    const helper = await ensureWinIdHelper();
    const { stdout } = await run(helper, [], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout
        .split("\n")
        .map((line) => line.split("\t"))
        .filter((parts) => parts.length >= 3 && Number(parts[0]) > 0)
        .map(([id, owner, ...rest]) => ({ id: Number(id), owner, name: rest.join("\t") }));
}

/** 找到画布所在的浏览器窗口 ID：先按标题匹配，再退回最前面的浏览器窗口。 */
export async function resolveWindowId(hint?: string) {
    const windows = await listWindows();
    const browsers = windows.filter((item) => /Chrome|Chromium|Edge|Brave/i.test(item.owner));
    const needle = String(hint || "").trim().toLowerCase();
    if (needle) {
        const exact = browsers.find((item) => item.name.toLowerCase().includes(needle));
        if (exact) return exact.id;
    }
    const named = browsers.find((item) => item.name.trim());
    return named?.id ?? browsers[0]?.id ?? null;
}

/** 超出上限时按创建时间删除最旧文件。 */
export async function pruneWall(dir = WALL_DIR, max = MAX_WALL_FILES) {
    let names: string[];
    try {
        names = await readdir(dir);
    } catch {
        return 0;
    }
    const files = names.filter((name) => name.endsWith(".png")).sort();
    const extra = files.length - max;
    if (extra <= 0) return 0;
    let removed = 0;
    for (const name of files.slice(0, extra)) {
        try {
            await unlink(path.join(dir, name));
            removed += 1;
        } catch {
            /* 清理失败不阻塞截图 */
        }
    }
    return removed;
}

/** 列出产物墙条目（按时间倒序）。 */
export async function listWall(dir = WALL_DIR): Promise<WallEntry[]> {
    let names: string[];
    try {
        names = await readdir(dir);
    } catch {
        return [];
    }
    const entries: WallEntry[] = [];
    for (const name of names) {
        const parsed = parseWallFileName(name);
        if (!parsed) continue;
        try {
            const info = await stat(path.join(dir, name));
            if (!info.isFile()) continue;
            entries.push({ file: name, url: `/agent/wall/${encodeURIComponent(name)}`, nodeId: parsed.nodeId || undefined, bytes: info.size, createdAt: parsed.createdAt });
        } catch {
            /* 跳过不可读条目 */
        }
    }
    return entries.sort((a, b) => b.createdAt - a.createdAt);
}

/** 截取画布窗口并落入产物墙；失败一律返回结构化错误，不抛进 agent turn。 */
export async function captureWall(options: { nodeId?: unknown; tag?: unknown; windowTitle?: unknown; force?: boolean } = {}): Promise<CaptureResult> {
    const nodeId = sanitizeNodeId(options.nodeId);
    const key = nodeId || "default";
    const now = Date.now();
    if (!options.force) {
        const last = lastCaptureAt.get(key) || 0;
        if (now - last < DEDUPE_MS) return { ok: false, code: "CAPTURE_FAILED", error: "重复触发已忽略" };
    }
    let windowId: number | null;
    try {
        windowId = await resolveWindowId(typeof options.windowTitle === "string" ? options.windowTitle : undefined);
    } catch (error) {
        const code = (error as { captureCode?: CaptureErrorCode }).captureCode || "WINDOW_NOT_FOUND";
        return { ok: false, code, error: (error as Error).message };
    }
    if (!windowId) return { ok: false, code: "WINDOW_NOT_FOUND", error: "未找到可截图的浏览器窗口" };
    await mkdir(WALL_DIR, { recursive: true });
    const file = wallFileName(now, nodeId);
    const target = path.join(WALL_DIR, file);
    try {
        await run("/usr/sbin/screencapture", ["-x", "-l", String(windowId), target], { timeout: 20_000 });
    } catch (error) {
        return { ok: false, code: "CAPTURE_FAILED", error: (error as Error).message };
    }
    let bytes = 0;
    try {
        bytes = (await stat(target)).size;
    } catch {
        return { ok: false, code: "CAPTURE_FAILED", error: "截图未生成" };
    }
    if (bytes < MIN_CAPTURE_BYTES) {
        await unlink(target).catch(() => undefined);
        return { ok: false, code: "SCREEN_PERMISSION", error: "截图为空，疑似缺少屏幕录制权限" };
    }
    lastCaptureAt.set(key, now);
    await pruneWall();
    return { ok: true, file, url: `/agent/wall/${encodeURIComponent(file)}`, bytes };
}

/** 读取产物墙中的单张图片。 */
export async function readWallFile(file: string) {
    if (!isSafeWallFile(file)) return null;
    try {
        return await readFile(path.join(WALL_DIR, file));
    } catch {
        return null;
    }
}
