import type { VerifyReportEvent } from "@/lib/delivery/verify-report";

/**
 * E2: 订阅桥端 `delivery_verify` 事件（走既有 `/events` SSE，不另开通道）。
 *
 * 网页上的「跑测试」是 HTTP 调用，响应里已经带了同一份摘要；事件流是第二条到达路径
 * （多窗口 / 重连 / 桥端主动跑），两条路径最终都进 store 的 applyVerifyReport，
 * 按 reportId 去重，所以先后到达都只记一轮。
 */

const EVENT_NAME = "delivery_verify";
let clientSequence = 0;

/** 事件体只认结构化摘要：缺 cases / status 的载荷直接丢弃，不猜。 */
export function parseVerifyEvent(data: string): VerifyReportEvent | null {
    try {
        const value = JSON.parse(data) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        const event = value as VerifyReportEvent;
        if (event.type && event.type !== EVENT_NAME) return null;
        if (event.status !== "parsed" && event.status !== "skipped" && event.status !== "parse-error") return null;
        if (!Array.isArray(event.cases)) return null;
        return event;
    } catch {
        // 事件体不是 JSON：丢弃即可，轮次仍可由 HTTP 响应路径落地。
        return null;
    }
}

export function subscribeVerifyEvents(
    options: { url: string; token: string },
    listener: (event: VerifyReportEvent) => void,
): () => void {
    const base = options.url.trim().replace(/\/$/, "");
    if (!base || typeof EventSource === "undefined") return () => {};
    clientSequence += 1;
    // 独立 clientId：不覆盖 Agent 面板已注册的客户端，桥端会向所有网页广播。
    const clientId = `delivery-${Date.now().toString(36)}-${clientSequence}`;
    const source = new EventSource(`${base}/events?token=${encodeURIComponent(options.token)}&clientId=${encodeURIComponent(clientId)}`);
    const handler = (event: MessageEvent<string>) => {
        const parsed = parseVerifyEvent(typeof event.data === "string" ? event.data : "");
        if (parsed) listener(parsed);
    };
    source.addEventListener(EVENT_NAME, handler as EventListener);
    return () => {
        source.removeEventListener(EVENT_NAME, handler as EventListener);
        source.close();
    };
}
