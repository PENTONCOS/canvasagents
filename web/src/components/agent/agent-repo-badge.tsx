// G8：Agent 面板头部的「同步最新代码」徽标。
// 数据源是画布上的 repo 节点（分支 / 脏标记 / 最近提交），只读展示；点击 → 定位到该 repo 节点。
// 画布 snapshot 在拖拽/缩放时会高频刷新，所以这里用 imperative subscribe + 签名比对，
// 只有 repo 摘要真的变了才 setState，避免每次 viewport 变化都重渲染面板头。
import { useEffect, useState } from "react";

import { Button, Tooltip } from "antd";
import { GitBranch } from "lucide-react";
import { useTranslation } from "react-i18next";

import { REPO_NODE_TYPE } from "@/components/canvas/nodes/repo-node";
import { readRepoMetadata, repoDisplayName } from "@/lib/canvas/repo-node-utils";
import { useAgentStore } from "@/stores/use-agent-store";

type RepoBadgeSummary = { nodeId: string; name: string; branch: string; dirty: boolean; lastCommit: string };

function readSummary(): RepoBadgeSummary | null {
    const nodes = useAgentStore.getState().canvasContext?.snapshot.nodes || [];
    const node = nodes.find((item) => item.type === REPO_NODE_TYPE);
    if (!node) return null;
    const state = readRepoMetadata(node.metadata);
    // 未绑定仓库的空白 repo 节点不算数，不显示徽标。
    if (!state.repoId && !state.path) return null;
    return { nodeId: node.id, name: repoDisplayName(state), branch: state.branch, dirty: state.dirty, lastCommit: state.lastCommit };
}

function signatureOf(summary: RepoBadgeSummary | null) {
    return summary ? [summary.nodeId, summary.name, summary.branch, String(summary.dirty), summary.lastCommit].join("\u0000") : "";
}

export function AgentRepoBadge() {
    const { t } = useTranslation();
    const [summary, setSummary] = useState<RepoBadgeSummary | null>(readSummary);

    useEffect(() => {
        let last = signatureOf(readSummary());
        return useAgentStore.subscribe(() => {
            const next = readSummary();
            const signature = signatureOf(next);
            if (signature === last) return;
            last = signature;
            setSummary(next);
        });
    }, []);

    if (!summary) return null;

    const title = [t("agent.repo.badgeTooltip", { name: summary.name }), summary.branch ? t("agent.repo.branch", { branch: summary.branch }) : "", summary.dirty ? t("agent.repo.dirty") : t("agent.repo.clean"), summary.lastCommit || t("canvas.repo.noCommit"), t("agent.repo.locateHint")].filter(Boolean).join("\n");

    return (
        <Tooltip title={<span className="whitespace-pre-line">{title}</span>} placement="bottom">
            <Button
                size="small"
                type="text"
                className="!h-8 !w-8 !min-w-8 !px-0 @min-[560px]:!w-auto @min-[560px]:!min-w-0 @min-[560px]:!px-[7px]"
                aria-label={t("agent.repo.badgeLabel")}
                onClick={() => useAgentStore.getState().canvasContext?.focusNode?.(summary.nodeId)}
            >
                <span className="inline-flex items-center gap-1">
                    <GitBranch className="size-3.5" />
                    <span className="hidden max-w-[8rem] truncate @min-[560px]:inline">{summary.branch || summary.name}</span>
                    {summary.dirty ? <span className="size-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden /> : null}
                </span>
            </Button>
        </Tooltip>
    );
}
