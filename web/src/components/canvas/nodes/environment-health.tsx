// G3: 环境节点的健康状态视图与探测循环。
//
// 分工：取数与状态机在 lib/delivery/health-probe（纯函数，有单测），这里只负责
// 「什么时候探测」和「怎么画」。循环只活在面板里：面板挂载即探测一次、之后每
// ENV_PROBE_INTERVAL_MS 一次，卸载立刻 abort 并清掉定时器，绝不留后台轮询。
import { useCallback, useEffect, useState } from "react";

import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
    ENV_HEALTH_COLOR,
    ENV_PROBE_INTERVAL_MS,
    envHealthFromProbe,
    envHealthLabelKey,
    formatHttpStatus,
    formatProbeClock,
    probeEnvironmentHealth,
    readEnvHealth,
    type EnvHealthSnapshot,
    type EnvProbeTarget,
} from "@/lib/delivery/health-probe";
import type { CanvasNodeMetadata } from "@/types/canvas";

/** 探测失败原因翻成人话；HTTP 4xx/5xx 的错误本身就是 "HTTP 503"，直接显示。 */
export function probeErrorText(t: (key: string) => string, outcome: { error?: string; failure?: string } | null): string {
    if (!outcome?.error) return "";
    if (outcome.failure === "no-target") return t("canvas.node.delivery.envHealth.noTarget");
    if (outcome.failure === "timeout") return t("canvas.node.delivery.envHealth.timeout");
    return outcome.error;
}

/**
 * 面板里的探测循环。initial 是 metadata 里上一次的结果（刷新后先显示旧值，再被新结果覆盖）。
 * recheck 会重启整条循环：abort 掉在飞的那次，立刻重来，之后继续按节奏轮询。
 */
export function useEnvHealthProbe(target: EnvProbeTarget, initial: EnvHealthSnapshot | null) {
    const [health, setHealth] = useState<EnvHealthSnapshot | null>(initial);
    const [probing, setProbing] = useState(false);
    const [round, setRound] = useState(0);
    const url = target.url;

    useEffect(() => {
        let disposed = false;
        let timer: number | undefined;
        let controller: AbortController | null = null;
        const tick = async () => {
            controller = new AbortController();
            setProbing(true);
            const outcome = await probeEnvironmentHealth(url, { signal: controller.signal });
            if (disposed) return;
            setHealth(envHealthFromProbe(outcome));
            setProbing(false);
            timer = window.setTimeout(() => void tick(), ENV_PROBE_INTERVAL_MS);
        };
        void tick();
        return () => {
            disposed = true;
            controller?.abort();
            if (timer) window.clearTimeout(timer);
        };
    }, [url, round]);

    const recheck = useCallback(() => setRound((value) => value + 1), []);
    return { health, probing, recheck };
}

/** 画布节点上的徽标：只读 metadata，不在这里发请求（探测归面板）。 */
export function EnvironmentHealthBadge({ metadata }: { metadata?: CanvasNodeMetadata }) {
    const { t } = useTranslation();
    const health = readEnvHealth(metadata);
    const status = health?.status ?? "probing";
    const checkedAt = formatProbeClock(health?.checkedAt);
    const code = formatHttpStatus(health?.httpStatus);
    const title = health?.error || (checkedAt ? `${t("canvas.node.delivery.envHealth.lastChecked")} ${checkedAt}` : t("canvas.node.delivery.envHealth.neverChecked"));
    return (
        <span
            data-env-health-badge={status}
            title={title}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
            style={{ background: `${ENV_HEALTH_COLOR[status]}22`, color: ENV_HEALTH_COLOR[status] }}
        >
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: ENV_HEALTH_COLOR[status] }} />
            {t(envHealthLabelKey(status))}
            {code ? <span data-env-health-badge-code>{code.replace("HTTP ", "")}</span> : null}
        </span>
    );
}

/** 面板里的健康行：状态点 + 文案 + 最近探测时间 + 状态码 + 复检按钮 + 失败原因。 */
export function EnvironmentHealthRow({ target, health, probing, onRecheck }: { target: EnvProbeTarget; health: EnvHealthSnapshot | null; probing: boolean; onRecheck: () => void }) {
    const { t } = useTranslation();
    const status = probing ? "probing" : health?.status ?? "probing";
    const checkedAt = formatProbeClock(health?.checkedAt);
    const code = formatHttpStatus(health?.httpStatus);
    const failure = !probing && health?.status === "unhealthy" ? (health.httpStatus ? "bad-status" : health.error === "no-target" ? "no-target" : health.error === "timeout" ? "timeout" : "network") : undefined;
    const reason = status === "unhealthy" ? probeErrorText(t, { error: health?.error, failure }) : "";
    return (
        <div className="mt-2 rounded-lg border border-black/10 px-2 py-1.5 text-[10px] text-[#6b7280]">
            <div className="flex items-center gap-2">
                <span data-env-health-status={status} className="inline-flex items-center gap-1 font-medium" style={{ color: ENV_HEALTH_COLOR[status] }} title={reason || t("canvas.node.delivery.envHealth.title")}>
                    <span className="h-2 w-2 rounded-full" style={{ background: ENV_HEALTH_COLOR[status] }} />
                    {t(envHealthLabelKey(status))}
                </span>
                {code ? <span data-env-health-code className="rounded bg-[#f0f0f1] px-1 py-0.5 font-medium text-[#242529]">{code}</span> : null}
                <span data-env-health-at className="ml-auto" title={target.url}>
                    {checkedAt ? `${t("canvas.node.delivery.envHealth.lastChecked")} ${checkedAt}` : t("canvas.node.delivery.envHealth.neverChecked")}
                </span>
                <button type="button" className="inline-flex h-5 items-center gap-1 rounded border border-[#e5e7eb] px-1.5 text-[10px] text-[#242529] disabled:opacity-40" onClick={onRecheck} disabled={probing} data-env-recheck title={t("canvas.node.delivery.envHealth.recheck")}>
                    <RefreshCw className="size-3" />
                    {t("canvas.node.delivery.envHealth.recheck")}
                </button>
            </div>
            {reason ? (
                <div className="mt-1 truncate text-[#ef4444]" data-env-health-error title={reason}>
                    {reason}
                </div>
            ) : null}
        </div>
    );
}
