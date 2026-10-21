import { useState } from "react";
import { Bug, ClipboardList, FlaskConical, Play, Route, Server, SquareCheck, SquareDashed } from "lucide-react";
import { useTranslation } from "react-i18next";

import { NODE_SPECS } from "@/constant/canvas";
import { useDeliveryStore } from "@/stores/use-delivery-store";
import { CanvasNodeType } from "@/types/canvas";
import type { CanvasNodeContext, CanvasNodeDefinition } from "@/types/canvas-plugin";
import { nextEntityId } from "@/types/delivery";

// M0: delivery-domain node definitions (dev plan §1.2). Rendering uses the shared
// DeliveryNodeContent renderer in canvas-node; full editing arrives with per-node Panels in M1.
// Execution-state nodes (testcase/bug/run/environment) are created by the delivery flow, not
// the create menu, so they opt out via showInCreateMenu: false.

const iconClass = "size-4";

const DELIVERY_ICON: Partial<Record<CanvasNodeType, React.ReactNode>> = {
    [CanvasNodeType.Requirement]: <ClipboardList className={iconClass} />,
    [CanvasNodeType.Journey]: <Route className={iconClass} />,
    [CanvasNodeType.JourneyStep]: <SquareDashed className={iconClass} />,
    [CanvasNodeType.Design]: <SquareCheck className={iconClass} />,
    [CanvasNodeType.Acceptance]: <FlaskConical className={iconClass} />,
    [CanvasNodeType.TestCase]: <FlaskConical className={iconClass} />,
    [CanvasNodeType.Bug]: <Bug className={iconClass} />,
    [CanvasNodeType.Environment]: <Server className={iconClass} />,
    [CanvasNodeType.Run]: <Play className={iconClass} />,
};

const DELIVERY_MINIMAP: Partial<Record<CanvasNodeType, string>> = {
    [CanvasNodeType.Requirement]: "#f59e0b",
    [CanvasNodeType.Journey]: "#0ea5e9",
    [CanvasNodeType.JourneyStep]: "#38bdf8",
    [CanvasNodeType.Design]: "#8b5cf6",
    [CanvasNodeType.Acceptance]: "#22c55e",
    [CanvasNodeType.TestCase]: "#4ade80",
    [CanvasNodeType.Bug]: "#ef4444",
    [CanvasNodeType.Environment]: "#64748b",
    [CanvasNodeType.Run]: "#eab308",
};

const NOT_IN_CREATE_MENU: CanvasNodeType[] = [CanvasNodeType.TestCase, CanvasNodeType.Bug, CanvasNodeType.Run];

export const DELIVERY_DEFINITIONS: CanvasNodeDefinition[] = (
    [
        CanvasNodeType.Requirement,
        CanvasNodeType.Journey,
        CanvasNodeType.JourneyStep,
        CanvasNodeType.Design,
        CanvasNodeType.Acceptance,
        CanvasNodeType.TestCase,
        CanvasNodeType.Bug,
        CanvasNodeType.Environment,
        CanvasNodeType.Run,
    ] as CanvasNodeType[]
).map((type) => ({
    type,
    title: NODE_SPECS[type].title,
    icon: DELIVERY_ICON[type],
    minimapColor: DELIVERY_MINIMAP[type],
    showInCreateMenu: !NOT_IN_CREATE_MENU.includes(type),
    defaultSize: { width: NODE_SPECS[type].width, height: NODE_SPECS[type].height },
    defaultMetadata: NODE_SPECS[type].metadata,
    // 环境面板是唯一有编辑需求的交付节点：URL 和版本必须能改，其余交付节点靠 Agent 写入。
    ...(type === CanvasNodeType.Environment ? { Panel: EnvironmentPanel, autoOpenPanel: true } : {}),
}));

// M3: 环境面板。环境的 URL/版本改的是实体，节点 metadata 只留 envId 与展示值，
// 这样侧栏、Agent 快照、画布三处读到的是同一份数据。
function EnvironmentPanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const { t } = useTranslation();
    const meta = ctx.node.metadata || {};
    const environments = useDeliveryStore((state) => state.environments);
    const envId = meta.envId || Object.values(environments).find((env) => env.nodeId === ctx.node.id)?.id || "";
    const env = envId ? environments[envId] : undefined;
    const [name, setName] = useState(env?.name || meta.envName || "staging");
    const [url, setUrl] = useState(env?.url || meta.url || "");
    const [version, setVersion] = useState(env?.version || "");

    const save = () => {
        const store = useDeliveryStore.getState();
        const id = envId || nextEntityId(Object.keys(store.environments), "ENV");
        store.upsertEnvironment({ id, name: name.trim() || "staging", url: url.trim(), version: version.trim() || undefined, status: env?.status || "unknown", deployedAt: env?.deployedAt, nodeId: ctx.node.id });
        ctx.updateMetadata({ envId: id, envName: name.trim() || "staging", url: url.trim() });
        onClose();
    };

    return (
        <div className="rounded-2xl border border-black/10 bg-white p-4 text-[#242529] shadow-[0_18px_48px_rgba(15,23,42,.18)]" onMouseDown={(event) => event.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-semibold">{t("canvas.node.delivery.envPanelTitle")}</span>
                <span className="rounded bg-[#f0f0f1] px-1.5 py-0.5 text-[10px] font-medium text-[#6b7280]">{envId || t("canvas.node.delivery.envNew")}</span>
            </div>
            <div className="grid grid-cols-1 gap-2">
                <label className="flex flex-col gap-1 text-[11px] text-[#6b7280]">
                    {t("canvas.node.delivery.envName")}
                    <input className="h-8 rounded-lg border border-black/10 px-2 text-xs text-[#242529] outline-none focus:border-[#3b82f6]" value={name} onChange={(event) => setName(event.target.value)} />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-[#6b7280]">
                    {t("canvas.node.delivery.envUrl")}
                    <input className="h-8 rounded-lg border border-black/10 px-2 text-xs text-[#242529] outline-none focus:border-[#3b82f6]" placeholder="https://staging.example.com" value={url} onChange={(event) => setUrl(event.target.value)} />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-[#6b7280]">
                    {t("canvas.node.delivery.envVersion")}
                    <input className="h-8 rounded-lg border border-black/10 px-2 text-xs text-[#242529] outline-none focus:border-[#3b82f6]" placeholder="v0.1.0" value={version} onChange={(event) => setVersion(event.target.value)} />
                </label>
            </div>
            <div className="mt-3 flex justify-end gap-2">
                <button type="button" className="h-8 rounded-lg px-3 text-xs text-[#6b7280] hover:bg-[#f0f0f1]" onClick={onClose}>
                    {t("canvas.node.delivery.cancel")}
                </button>
                <button type="button" className="h-8 rounded-lg bg-[#242529] px-3 text-xs font-medium text-white" onClick={save} data-env-save>
                    {t("canvas.node.delivery.save")}
                </button>
            </div>
        </div>
    );
}
