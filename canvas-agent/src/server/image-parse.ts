import type { CanvasAgentConfig } from "../config.js";

/** 本地图片解析服务默认地址（tools/image-parse，默认端口 17410）。 */
export const DEFAULT_IMAGE_PARSE_URL = "http://127.0.0.1:17410";
/** 版面分析 + OCR 较慢，桥侧转发超时放宽到 60s。 */
export const IMAGE_PARSE_TIMEOUT_MS = 60_000;
/** base64 图片很大，/image/parse 请求体上限至少 32MB。 */
export const IMAGE_PARSE_BODY_LIMIT = "40mb";
/** 上游错误响应文本回传前截断，避免把超大错误体转发给网页。 */
const ERROR_TEXT_LIMIT = 2_000;

export type UpstreamSuccess = { ok: true; status: number; contentType: string | null; text: string };
export type UpstreamFailure = { ok: false; error: string };
export type UpstreamResult = UpstreamSuccess | UpstreamFailure;
export type UpstreamRequest = { method: "GET" | "POST"; path: string; body?: Buffer; contentType?: string };

/** 读取配置里的解析服务地址，未配置或为空时回退默认值，并去掉末尾斜杠。 */
export function resolveImageParseUrl(config: CanvasAgentConfig) {
    const configured = String(config.imageParseUrl || "").trim();
    return stripTrailingSlash(configured || DEFAULT_IMAGE_PARSE_URL);
}

/** 读取转发超时（毫秒），允许用环境变量覆盖以便测试；非法值回退默认 60s。 */
export function imageParseTimeoutMs() {
    const raw = Number(process.env.CANVAS_IMAGE_PARSE_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : IMAGE_PARSE_TIMEOUT_MS;
}

/** 截断上游返回文本，超长时保留前 ERROR_TEXT_LIMIT 个字符并追加省略号。 */
export function truncateUpstreamText(text: string) {
    return text.length > ERROR_TEXT_LIMIT ? `${text.slice(0, ERROR_TEXT_LIMIT)}…` : text;
}

/** 向解析服务转发一次请求，把连接失败/超时收敛为结果对象而不是抛错。 */
export async function requestUpstream(baseUrl: string, request: UpstreamRequest, timeoutMs = imageParseTimeoutMs()): Promise<UpstreamResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    try {
        const headers: Record<string, string> = {};
        if (request.contentType) headers["content-type"] = request.contentType;
        const response = await fetch(`${baseUrl}${request.path}`, {
            method: request.method,
            headers,
            body: request.body ? new Uint8Array(request.body) : undefined,
            signal: controller.signal,
        });
        return { ok: true, status: response.status, contentType: response.headers.get("content-type"), text: await response.text() };
    } catch (error) {
        return { ok: false, error: timedOut ? `解析服务响应超时（${timeoutMs}ms）` : `解析服务不可达：${baseUrl}（${describeError(error)}）` };
    } finally {
        clearTimeout(timer);
    }
}

/** 提取错误描述，优先 Error.message。 */
function describeError(error: unknown) {
    if (error instanceof Error) return error.message || error.name;
    return String(error);
}

/** 去掉地址末尾的斜杠，便于安全拼接子路径。 */
function stripTrailingSlash(value: string) {
    return value.replace(/\/+$/, "");
}
