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
const HELPER_VER = path.join(HELPER_DIR, "winid.ver");
/** helper 输出协议版本：字段变了就 +1，保证已编译的旧二进制会被重编。 */
const HELPER_VERSION = "2";

/** 目录保留上限：超出后按写入时间滚动删除最旧文件。 */
export const MAX_WALL_FILES = 200;
/** 同一 nodeId 在该窗口内重复触发只截一次，避免连发刷屏。 */
const DEDUPE_MS = 5000;
/** 小于该体积的截图判为「权限缺失/黑图」而非真实产物（画布窗口实测 >1MB）。 */
const MIN_CAPTURE_BYTES = 20 * 1024;
/** 只有这些属主的窗口才可能是画布；避免抓到 Dock/输入法/菜单栏。 */
const BROWSER_OWNER = /Chrome|Chromium|Edge|Brave|Safari|Firefox/i;

/** v2：在 id/owner/name 之外多输出 layer 与窗口 bounds，用于「按面积挑最大的浏览器窗口」。 */
const WINID_SOURCE = `#include <CoreGraphics/CoreGraphics.h>
#include <stdio.h>
#include <string.h>
int main(void) {
    CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (!list) return 1;
    for (CFIndex i = 0; i < CFArrayGetCount(list); i++) {
        CFDictionaryRef w = CFArrayGetValueAtIndex(list, i);
        CFNumberRef num = CFDictionaryGetValue(w, kCGWindowNumber);
        CFNumberRef layerRef = CFDictionaryGetValue(w, kCGWindowLayer);
        CFStringRef owner = CFDictionaryGetValue(w, kCGWindowOwnerName);
        CFStringRef name = CFDictionaryGetValue(w, kCGWindowName);
        int n = -1, layer = 0;
        if (num) CFNumberGetValue(num, kCFNumberIntType, &n);
        if (layerRef) CFNumberGetValue(layerRef, kCFNumberIntType, &layer);
        double x = 0, y = 0, wd = 0, ht = 0;
        CFDictionaryRef bounds = CFDictionaryGetValue(w, kCGWindowBounds);
        if (bounds) {
            CGRect rect;
            if (CGRectMakeWithDictionaryRepresentation(bounds, &rect)) { x = rect.origin.x; y = rect.origin.y; wd = rect.size.width; ht = rect.size.height; }
        }
        char ob[256] = {0}, nb[512] = {0};
        if (owner) CFStringGetCString(owner, ob, sizeof(ob), kCFStringEncodingUTF8);
        if (name) CFStringGetCString(name, nb, sizeof(nb), kCFStringEncodingUTF8);
        printf("%d\\t%d\\t%.0f\\t%.0f\\t%.0f\\t%.0f\\t%s\\t%s\\n", n, layer, x, y, wd, ht, ob, nb);
    }
    return 0;
}
`;

export type WallEntry = { file: string; url: string; nodeId?: string; tag?: string; bytes: number; createdAt: number };
export type CaptureErrorCode = "WINDOW_NOT_FOUND" | "SCREEN_PERMISSION" | "HELPER_UNAVAILABLE" | "CAPTURE_FAILED";
export type WindowStrategy = "title-match" | "largest-browser" | "no-title-match";
export type CaptureResult =
    | { ok: true; file: string; url: string; bytes: number; windowId: number; windowName: string; strategy: WindowStrategy }
    | { ok: false; code: CaptureErrorCode; error: string };

/** 屏幕上的一个窗口（含 bounds）。 */
export type ScreenWindow = { id: number; owner: string; layer: number; x: number; y: number; width: number; height: number; name: string };

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

/** 编译（并缓存）窗口枚举小工具；协议版本变化时重编，无 clang 时给出结构化错误。 */
async function ensureWinIdHelper() {
    try {
        const [version] = await Promise.all([readFile(HELPER_VER, "utf8"), stat(HELPER_BIN)]);
        if (version.trim() === HELPER_VERSION) return HELPER_BIN;
    } catch {
        /* 首次调用、或旧版二进制没有版本文件，都要重编 */
    }
    try {
        await mkdir(HELPER_DIR, { recursive: true });
        await writeFile(HELPER_SRC, WINID_SOURCE, "utf8");
        await run("clang", ["-O2", "-framework", "CoreGraphics", "-framework", "CoreFoundation", "-o", HELPER_BIN, HELPER_SRC], { timeout: 60_000 });
        await writeFile(HELPER_VER, HELPER_VERSION, "utf8");
        return HELPER_BIN;
    } catch (error) {
        throw Object.assign(new Error(`无法编译窗口枚举工具：${(error as Error).message}`), { captureCode: "HELPER_UNAVAILABLE" as CaptureErrorCode });
    }
}

/** 枚举屏幕上的窗口。 */
export async function listWindows(): Promise<ScreenWindow[]> {
    const helper = await ensureWinIdHelper();
    const { stdout } = await run(helper, [], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout
        .split("\n")
        .map((line) => line.split("\t"))
        .filter((parts) => parts.length >= 8 && Number(parts[0]) > 0)
        .map(([id, layer, x, y, width, height, owner, ...rest]) => ({
            id: Number(id),
            layer: Number(layer),
            x: Number(x),
            y: Number(y),
            width: Number(width),
            height: Number(height),
            owner,
            name: rest.join("\t"),
        }));
}

/**
 * 纯函数：从窗口列表里挑画布窗口。
 * 优先级：标题命中 > 面积最大的浏览器窗口。只认 layer 0（普通窗口）且尺寸像主窗口的。
 */
export function pickCaptureWindow(windows: ScreenWindow[], options: { title?: string; owner?: string; requireTitle?: boolean } = {}): {
    window: ScreenWindow | null;
    strategy: WindowStrategy;
    candidates: ScreenWindow[];
} {
    let ownerRe = BROWSER_OWNER;
    if (options.owner) {
        try {
            ownerRe = new RegExp(options.owner, "i");
        } catch {
            ownerRe = BROWSER_OWNER;
        }
    }
    const pool = windows.filter((item) => item.layer === 0 && item.width >= 320 && item.height >= 240 && ownerRe.test(item.owner));
    const byArea = (a: ScreenWindow, b: ScreenWindow) => b.width * b.height - a.width * a.height;
    const needle = String(options.title || "").trim().toLowerCase();
    const titled = needle ? pool.filter((item) => item.name.toLowerCase().includes(needle)) : [];
    // 给了标题要求「必须命中」时，宁可拒绝也不猜——抓错窗比没抓到更差。
    if (needle && !titled.length && options.requireTitle) {
        return { window: null, strategy: "no-title-match", candidates: pool.slice().sort(byArea) };
    }
    const candidates = (titled.length ? titled : pool).slice().sort(byArea);
    return { window: candidates[0] ?? null, strategy: titled.length ? "title-match" : "largest-browser", candidates };
}

/** 组合：枚举 + 挑选，供 capture 与 /agent/windows 共用。 */
export async function resolveCaptureWindow(options: { title?: string; owner?: string; requireTitle?: boolean } = {}) {
    return pickCaptureWindow(await listWindows(), options);
}

/** 找画布窗口的 id（保留旧签名，内部走同一套挑选逻辑）。 */
export async function resolveWindowId(hint?: string) {
    const { window } = await resolveCaptureWindow({ title: typeof hint === "string" ? hint : undefined });
    return window?.id ?? null;
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
export async function captureWall(options: { nodeId?: unknown; tag?: unknown; windowTitle?: unknown; requireTitle?: unknown; force?: boolean } = {}): Promise<CaptureResult> {
    const nodeId = sanitizeNodeId(options.nodeId);
    const key = nodeId || "default";
    const now = Date.now();
    if (!options.force) {
        const last = lastCaptureAt.get(key) || 0;
        if (now - last < DEDUPE_MS) return { ok: false, code: "CAPTURE_FAILED", error: "重复触发已忽略" };
    }
    const hint = typeof options.windowTitle === "string" ? options.windowTitle.trim() : "";
    let picked: Awaited<ReturnType<typeof resolveCaptureWindow>>;
    try {
        picked = await resolveCaptureWindow({ title: hint || undefined, requireTitle: options.requireTitle === true });
    } catch (error) {
        const code = (error as { captureCode?: CaptureErrorCode }).captureCode || "WINDOW_NOT_FOUND";
        return { ok: false, code, error: (error as Error).message };
    }
    const target = picked.window;
    if (!target) {
        // 把当前可见的浏览器窗口标题一并回传，便于用户判断是标题漂了还是画布没开。
        const titles = picked.candidates.map((item) => `${item.owner}：${item.name || "(无标题)"}`).join(" / ");
        if (picked.strategy === "no-title-match") {
            return { ok: false, code: "WINDOW_NOT_FOUND", error: `没有标题包含「${hint}」的浏览器窗口；当前可见：${titles || "无"}` };
        }
        return { ok: false, code: "WINDOW_NOT_FOUND", error: `未找到可截图的浏览器窗口；当前可见：${titles || "无"}` };
    }
    await mkdir(WALL_DIR, { recursive: true });
    const file = wallFileName(now, nodeId);
    const shotPath = path.join(WALL_DIR, file);
    try {
        await run("/usr/sbin/screencapture", ["-x", "-l", String(target.id), shotPath], { timeout: 20_000 });
    } catch (error) {
        return { ok: false, code: "CAPTURE_FAILED", error: (error as Error).message };
    }
    let bytes = 0;
    try {
        bytes = (await stat(shotPath)).size;
    } catch {
        return { ok: false, code: "CAPTURE_FAILED", error: "截图未生成" };
    }
    if (bytes < MIN_CAPTURE_BYTES) {
        await unlink(shotPath).catch(() => undefined);
        return { ok: false, code: "SCREEN_PERMISSION", error: "截图为空，疑似缺少屏幕录制权限" };
    }
    lastCaptureAt.set(key, now);
    await pruneWall();
    return { ok: true, file, url: `/agent/wall/${encodeURIComponent(file)}`, bytes, windowId: target.id, windowName: target.name, strategy: picked.strategy };
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
