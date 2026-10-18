import { useCallback, useEffect, useState } from "react";
import { App, Button, Empty, Tooltip } from "antd";
import { Camera, ExternalLink, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { fetchAgentWall, requestAgentCapture, resolveAgentWallFileUrl, type AgentWallItem } from "@/services/api/canvas-agent";

/** G3 产物墙：展示桥自动截取的画布快照，支持手动补一张。 */
export function AgentWallView({ theme, endpoint, token, connected }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; endpoint: string; token: string; connected: boolean }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [items, setItems] = useState<AgentWallItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [capturing, setCapturing] = useState(false);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        if (!connected || !endpoint || !token) return;
        setLoading(true);
        try {
            const response = await fetchAgentWall(endpoint, token);
            setItems(response.items || []);
            setError("");
        } catch {
            setError(t("agent.wall.loadFailed"));
        } finally {
            setLoading(false);
        }
    }, [connected, endpoint, token, t]);

    useEffect(() => {
        void load();
    }, [load]);

    const capture = useCallback(async () => {
        if (!connected || capturing) return;
        setCapturing(true);
        try {
            const response = await requestAgentCapture(endpoint, token, { force: true });
            if (response.ok) {
                message.success(t("agent.wall.captured"));
                await load();
            } else if (response.code === "SCREEN_PERMISSION") {
                message.warning(t("agent.wall.needPermission"));
            } else if (response.code === "WINDOW_NOT_FOUND") {
                // 桥会带出「当前可见的浏览器窗口标题」，直接透出便于用户判断是标题漂了还是画布没开。
                message.warning(response.error ? `${t("agent.wall.noWindow")}\n${response.error}` : t("agent.wall.noWindow"));
            } else if (response.code === "HELPER_UNAVAILABLE") {
                message.warning(t("agent.wall.noHelper"));
            } else {
                message.warning(t("agent.wall.captureFailed"));
            }
        } catch {
            message.error(t("agent.wall.captureFailed"));
        } finally {
            setCapturing(false);
        }
    }, [capturing, connected, endpoint, token, load, message, t]);

    const open = useCallback(
        (item: AgentWallItem) => {
            const url = resolveAgentWallFileUrl(endpoint, token, item.file);
            if (url) window.open(url, "_blank", "noopener,noreferrer");
        },
        [endpoint, token],
    );

    return (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
            <div className="flex items-center justify-between gap-2 pb-3 text-xs" style={{ color: theme.node.muted }}>
                <span>{items.length ? t("agent.wall.count", { count: items.length }) : t("agent.wall.title")}</span>
                <div className="flex shrink-0 items-center gap-1">
                    <Tooltip title={t("agent.wall.capture")} placement="bottom">
                        <Button size="small" type="text" className="!h-7 !w-7 !min-w-7 !px-0" aria-label={t("agent.wall.capture")} disabled={!connected} loading={capturing} icon={<Camera className="size-3.5" />} onClick={() => void capture()} />
                    </Tooltip>
                    <Tooltip title={t("agent.wall.refresh")} placement="bottom">
                        <Button size="small" type="text" className="!h-7 !w-7 !min-w-7 !px-0" aria-label={t("agent.wall.refresh")} disabled={!connected} loading={loading} icon={<RefreshCw className="size-3.5" />} onClick={() => void load()} />
                    </Tooltip>
                </div>
            </div>
            {error ? (
                <div className="py-8 text-center text-xs" style={{ color: theme.node.muted }}>
                    {error}
                </div>
            ) : !items.length ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span className="text-xs" style={{ color: theme.node.muted }}>{connected ? t("agent.wall.empty") : t("agent.status.disconnected")}</span>} />
            ) : (
                <div className="grid grid-cols-2 gap-2 @min-[520px]:grid-cols-3">
                    {items.map((item) => {
                        const src = resolveAgentWallFileUrl(endpoint, token, item.file);
                        return (
                            <button key={item.file} type="button" className="group relative aspect-[4/3] overflow-hidden rounded-md border" style={{ borderColor: theme.node.stroke }} title={new Date(item.createdAt).toLocaleString()} onClick={() => open(item)}>
                                {src ? <img src={src} alt={item.nodeId || item.file} className="size-full object-cover" loading="lazy" /> : null}
                                <span className="absolute inset-x-0 bottom-0 hidden items-center justify-between gap-1 bg-black/60 px-1.5 py-1 text-[10px] text-white group-hover:flex">
                                    <span className="truncate">{new Date(item.createdAt).toLocaleTimeString()}</span>
                                    <ExternalLink className="size-3 shrink-0" />
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
