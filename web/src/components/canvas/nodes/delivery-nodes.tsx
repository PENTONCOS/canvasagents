import { useState } from "react";
import { Bug, ClipboardList, FlaskConical, Play, Route, Server, SquareCheck, SquareDashed } from "lucide-react";
import { useTranslation } from "react-i18next";

import { NODE_SPECS } from "@/constant/canvas";
import { applyDeployment, planRollback } from "@/lib/delivery/deploy-plan";
import { useAgentStore } from "@/stores/use-agent-store";
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
        // A4: 需求便签有自己的节点实现（requirement-node.tsx），不在这里注册。
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

// M4: 环境面板。URL/版本/部署历史全部落在实体上，节点 metadata 只留展示值。
// 部署走桥端「跑命令 + 健康检查」，回滚由前端按 history 决定目标版本——桥端不猜。
function EnvironmentPanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const { t } = useTranslation();
    const meta = ctx.node.metadata || {};
    const environments = useDeliveryStore((state) => state.environments);
    const agentUrl = useAgentStore((state) => state.url);
    const agentToken = useAgentStore((state) => state.token);
    const envId = meta.envId || Object.values(environments).find((env) => env.nodeId === ctx.node.id)?.id || "";
    const env = envId ? environments[envId] : undefined;
    const [name, setName] = useState(env?.name || meta.envName || "staging");
    const [url, setUrl] = useState(env?.url || meta.url || "");
    const [version, setVersion] = useState(env?.version || "");
    const [command, setCommand] = useState("");
    const [cwd, setCwd] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const history = env?.history || [];

    const persist = (patch: Partial<typeof env> & Record<string, unknown>) => {
        const store = useDeliveryStore.getState();
        const id = envId || nextEntityId(Object.keys(store.environments), "ENV");
        const base = store.environments[id] || { id, name: name.trim() || "staging", url: url.trim(), status: "unknown" as const, nodeId: ctx.node.id };
        store.upsertEnvironment({ ...base, ...patch, id, nodeId: ctx.node.id } as never);
        ctx.updateMetadata({ envId: id, envName: name.trim() || "staging", url: patch.url ?? url.trim(), envVersion: patch.version ?? version });
        return id;
    };

    const save = () => {
        persist({ name: name.trim() || "staging", url: url.trim(), version: version.trim() || undefined });
        onClose();
    };

    const deploy = async () => {
        if (!command.trim()) return setError(t("canvas.node.delivery.envCommandRequired"));
        setBusy(true);
        setError("");
        try {
            const response = await fetch(`${agentUrl.replace(/\/$/, "")}/delivery/deploy`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-canvas-agent-token": agentToken },
                body: JSON.stringify({ command: command.trim(), cwd: cwd.trim(), url: url.trim(), timeoutMs: 120000 }),
            });
            const data = (await response.json()) as { ok?: boolean; status?: string; health?: { status?: number }; command?: { output?: string } };
            // 命令成功但健康检查失败也算部署失败：能跑完不等于服务可用。
            const status = data?.status === "healthy" ? "healthy" : "unhealthy";
            const applied = applyDeployment(env || {}, { version: version.trim() || "unversioned", url: url.trim(), status });
            persist({ ...applied, name: name.trim() || "staging" });
            if (!data?.ok) setError(`${t("canvas.node.delivery.envDeployFailed")}${data?.health?.status ? ` (HTTP ${data.health.status})` : ""}`);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    const rollback = () => {
        const plan = planRollback(history);
        if (!plan.previous) return setError(t("canvas.node.delivery.envNoHistory"));
        // 回滚不产生新的部署记录：把上一条换到队首即可，否则历史里会出现两条一模一样的版本。
        setVersion(plan.previous.version);
        setUrl(plan.previous.url);
        persist({
            version: plan.previous.version,
            url: plan.previous.url,
            status: plan.previous.status,
            deployedAt: plan.previous.deployedAt,
            history: plan.nextHistory,
            name: name.trim() || "staging",
        });
        setError("");
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
                    <input className="h-8 rounded-lg border border-black/10 px-2 text-xs text-[#242529] outline-none focus:border-[#3b82f6]" placeholder="https://staging.example.com" value={url} onChange={(event) => setUrl(event.target.value)} data-env-url />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-[#6b7280]">
                    {t("canvas.node.delivery.envVersion")}
                    <input className="h-8 rounded-lg border border-black/10 px-2 text-xs text-[#242529] outline-none focus:border-[#3b82f6]" placeholder="v0.1.0" value={version} onChange={(event) => setVersion(event.target.value)} data-env-version />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-[#6b7280]">
                    {t("canvas.node.delivery.envCommand")}
                    <input className="h-8 rounded-lg border border-black/10 px-2 text-xs text-[#242529] outline-none focus:border-[#3b82f6]" placeholder="pnpm run deploy" value={command} onChange={(event) => setCommand(event.target.value)} data-env-command />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-[#6b7280]">
                    {t("canvas.node.delivery.envCwd")}
                    <input className="h-8 rounded-lg border border-black/10 px-2 text-xs text-[#242529] outline-none focus:border-[#3b82f6]" placeholder="/path/to/repo" value={cwd} onChange={(event) => setCwd(event.target.value)} data-env-cwd />
                </label>
            </div>
            {error ? <p className="mt-2 text-[11px] text-[#ef4444]" data-env-error>{error}</p> : null}
            <div className="mt-3 flex items-center gap-2 text-[10px] text-[#6b7280]">
                <span className="inline-flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full" style={{ background: env?.status === "healthy" ? "#22c55e" : env?.status === "unhealthy" ? "#ef4444" : "#94a3b8" }} />
                    {env?.status || "unknown"}
                </span>
                <span>{t("canvas.node.delivery.envHistory", { count: history.length })}</span>
            </div>
            {history.length > 0 ? (
                <ul className="mt-1 max-h-24 overflow-y-auto text-[10px] text-[#6b7280]" data-env-history>
                    {history.map((item) => (
                        <li key={`${item.version}-${item.deployedAt}`} className="flex justify-between gap-2">
                            <span className="truncate">{item.version}</span>
                            <span>{item.status}</span>
                        </li>
                    ))}
                </ul>
            ) : null}
            <div className="mt-3 flex justify-end gap-2">
                <button type="button" className="h-8 rounded-lg px-3 text-xs text-[#6b7280] hover:bg-[#f0f0f1]" onClick={onClose}>
                    {t("canvas.node.delivery.cancel")}
                </button>
                <button type="button" className="h-8 rounded-lg border border-[#e5e7eb] px-3 text-xs text-[#242529] disabled:opacity-40" disabled={history.length < 2 || busy} onClick={rollback} data-env-rollback>
                    {t("canvas.node.delivery.envRollback")}
                </button>
                <button type="button" className="h-8 rounded-lg border border-[#e5e7eb] px-3 text-xs text-[#242529] disabled:opacity-40" disabled={busy} onClick={() => void deploy()} data-env-deploy>
                    {busy ? t("canvas.node.delivery.envDeploying") : t("canvas.node.delivery.envDeploy")}
                </button>
                <button type="button" className="h-8 rounded-lg bg-[#242529] px-3 text-xs font-medium text-white" onClick={save} data-env-save>
                    {t("canvas.node.delivery.save")}
                </button>
            </div>
        </div>
    );
}
