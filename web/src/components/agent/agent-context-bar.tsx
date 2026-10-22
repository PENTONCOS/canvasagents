import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip } from "antd";

import { buildContextSections, contextSignature, type ContextSection } from "@/lib/agent/context-bar";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { useAgentStore } from "@/stores/use-agent-store";
import { useDeliveryStore } from "@/stores/use-delivery-store";

/**
 * C2: 上下文条（参考产品修 Bug 面板顶部那一行：需求 / 原型 / 设计 B / 验收标准）。
 *
 * 为什么不直接 useAgentStore((s) => s.canvasContext)：拖动节点时快照每帧都在变，
 * 订阅它会让这个组件跟着每帧重渲染。面板本身也刻意避开了订阅 canvasContext。
 * 这里改成命令式订阅 + 签名比较，只在「分类/数量/状态」真的变了才 setState。
 */
function readSections(): ContextSection[] {
    const agent = useAgentStore.getState();
    const delivery = useDeliveryStore.getState();
    return buildContextSections({
        nodes: agent.canvasContext?.snapshot?.nodes ?? [],
        acceptance: delivery.acceptance,
        designs: delivery.designs,
    });
}

export function AgentContextBar({ theme }: { theme: CanvasTheme }) {
    const { t } = useTranslation();
    const [sections, setSections] = useState<ContextSection[]>(readSections);

    useEffect(() => {
        const sync = () => {
            setSections((previous) => {
                const next = readSections();
                return contextSignature(previous) === contextSignature(next) ? previous : next;
            });
        };
        const unsubscribeAgent = useAgentStore.subscribe(sync);
        const unsubscribeDelivery = useDeliveryStore.subscribe(sync);
        sync();
        return () => {
            unsubscribeAgent();
            unsubscribeDelivery();
        };
    }, []);

    if (sections.length === 0) return null;

    return (
        <div
            role="status"
            aria-label={t("agent.contextBar.title")}
            className="thin-scrollbar mx-3 mt-2 flex shrink-0 items-center gap-1.5 overflow-x-auto pb-1"
        >
            {sections.map((section) => {
                const label = t(`agent.contextBar.kind.${section.kind}`);
                const detail =
                    section.kind === "acceptance" && section.total
                        ? t("agent.contextBar.acPassing", { passing: section.passing ?? 0, total: section.total })
                        : section.kind === "design" && section.selected
                            ? t("agent.contextBar.designSelected", { count: section.selected })
                            : "";
                return (
                    <Tooltip key={section.kind} title={section.titles.join("、")}>
                        <span
                            className="shrink-0 rounded-md border px-2 py-0.5 text-[11px] leading-4"
                            style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.muted }}
                        >
                            {label} {section.count}
                            {detail ? ` · ${detail}` : ""}
                        </span>
                    </Tooltip>
                );
            })}
        </div>
    );
}
