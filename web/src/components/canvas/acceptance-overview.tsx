import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "antd";

import type { CanvasTheme } from "@/lib/canvas-theme";
import { AC_STATUS_COLOR, acStatusLabelKey } from "@/lib/delivery/ac-status";
import { buildAcceptanceOverview } from "@/lib/delivery/acceptance-overview";
import { useDeliveryStore } from "@/stores/use-delivery-store";
import { AC_LAYER_ORDER, type AcTestLayer } from "@/types/delivery";

/**
 * F1 验收一览：对齐参考产品的「用户故事 → 验收标准 → 怎么验」三列矩阵。
 * 侧栏太窄，所以放在宽弹窗里；侧栏只留入口。
 */
const LAYER_KEY: Record<AcTestLayer, string> = {
    unit: "canvas.acOverview.layerUnit",
    component: "canvas.acOverview.layerComponent",
    daemon: "canvas.acOverview.layerDaemon",
    e2e: "canvas.acOverview.layerE2e",
    manual: "canvas.acOverview.layerManual",
};

export function AcceptanceOverviewModal({ open, theme, onClose, onFocusNode }: {
    open: boolean;
    theme: CanvasTheme;
    onClose: () => void;
    onFocusNode: (nodeId: string) => void;
}) {
    const { t } = useTranslation();
    const journeys = useDeliveryStore((state) => state.journeys);
    const steps = useDeliveryStore((state) => state.steps);
    const acceptance = useDeliveryStore((state) => state.acceptance);
    const testCases = useDeliveryStore((state) => state.testCases);
    const bugs = useDeliveryStore((state) => state.bugs);

    const overview = useMemo(
        () => buildAcceptanceOverview({ journeys, steps, acceptance, testCases, bugs }),
        [journeys, steps, acceptance, testCases, bugs],
    );

    const cellStyle = { color: theme.node.muted } as const;

    return (
        <Modal open={open} onCancel={onClose} footer={null} width={1080} title={t("canvas.acOverview.title")} destroyOnHidden>
            <div className="max-h-[70vh] overflow-y-auto pr-1" data-testid="acceptance-overview">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]" style={cellStyle}>
                    <span>{t("canvas.acOverview.totals", { count: overview.totalAcs, unproven: overview.unprovenAcs })}</span>
                    {overview.failingAcs > 0 ? (
                        <span style={{ color: AC_STATUS_COLOR.failing }} data-testid="ac-overview-failing">
                            {t("canvas.acOverview.failing", { count: overview.failingAcs })}
                        </span>
                    ) : null}
                    {AC_LAYER_ORDER.map((layer) => (
                        <span key={layer} className="rounded border px-1.5 py-0.5" style={{ borderColor: theme.node.stroke, background: theme.node.fill }} data-layer={layer}>
                            {t(LAYER_KEY[layer])} {overview.layerCounts[layer]}
                        </span>
                    ))}
                </div>

                {overview.rows.length === 0 ? (
                    <div className="px-2 py-6 text-xs" style={cellStyle} data-testid="ac-overview-empty">
                        {t("canvas.acOverview.empty")}
                    </div>
                ) : (
                    <>
                        <div className="grid grid-cols-[1.05fr_1fr_1fr] gap-3 border-b pb-1 text-[11px] font-medium" style={{ ...cellStyle, borderColor: theme.node.stroke }}>
                            <span>{t("canvas.acOverview.story")}</span>
                            <span>{t("canvas.acOverview.ac")}</span>
                            <span>{t("canvas.acOverview.how")}</span>
                        </div>
                        {overview.rows.map((row) => (
                            <div key={row.key} className="grid grid-cols-[1.05fr_1fr_1fr] gap-3 border-b py-2" style={{ borderColor: `${theme.node.stroke}66` }} data-row={row.key}>
                                <div className="min-w-0 text-xs">
                                    {row.storyId ? (
                                        <div className="font-medium" style={{ color: theme.node.text }}>
                                            <span className="mr-1 font-mono text-[11px]" style={cellStyle}>{row.storyId}</span>
                                            {row.storyTitle || t("canvas.acOverview.unassigned")}
                                        </div>
                                    ) : (
                                        <div className="font-medium" style={{ color: theme.node.text }}>{t("canvas.acOverview.unassigned")}</div>
                                    )}
                                    {row.journeyTitle && row.journeyTitle !== row.storyTitle ? (
                                        <div className="mt-0.5 text-[11px]" style={cellStyle}>{row.journeyTitle}</div>
                                    ) : null}
                                </div>

                                <div className="flex min-w-0 flex-col gap-1.5">
                                    {row.acs.map((ac) => (
                                        <button
                                            key={ac.id}
                                            type="button"
                                            onClick={() => ac.nodeId && onFocusNode(ac.nodeId)}
                                            className="flex items-start gap-1.5 rounded px-1 py-0.5 text-left text-[11px]"
                                            style={{ background: theme.node.fill, color: theme.node.text }}
                                            data-ac-id={ac.id}
                                            data-ac-status={ac.status}
                                        >
                                            <span className="mt-1 size-1.5 shrink-0 rounded-full" style={{ background: AC_STATUS_COLOR[ac.status] }} />
                                            <span className="min-w-0 flex-1">
                                                <span className="font-medium">{ac.id}</span>{" "}
                                                <span style={{ color: AC_STATUS_COLOR[ac.status] }}>{t(acStatusLabelKey(ac.status))}</span>
                                                <span className="block" style={cellStyle}>{ac.statement}</span>
                                            </span>
                                        </button>
                                    ))}
                                </div>

                                <div className="flex min-w-0 flex-col gap-1.5">
                                    {row.acs.map((ac) => {
                                        const filled = AC_LAYER_ORDER.filter((layer) => ac.layers[layer].length > 0);
                                        return (
                                            <div key={ac.id} className="flex flex-wrap items-center gap-1 text-[10px]" data-verify-for={ac.id}>
                                                {filled.map((layer) => (
                                                    <span key={layer} className="rounded border px-1" style={{ borderColor: theme.node.stroke, color: theme.node.text }} title={ac.layers[layer].join("、")}>
                                                        {t(LAYER_KEY[layer])} {ac.layers[layer].length}
                                                    </span>
                                                ))}
                                                {ac.unproven ? (
                                                    <span className="rounded px-1" style={{ background: "rgba(239,68,68,0.14)", color: AC_STATUS_COLOR.failing }} data-unproven="true">
                                                        {t("canvas.acOverview.unproven")}
                                                    </span>
                                                ) : null}
                                                {ac.bugs.map((bugId) => (
                                                    <span key={bugId} className="rounded px-1" style={{ background: "rgba(239,68,68,0.14)", color: AC_STATUS_COLOR.failing }} data-bug-id={bugId}>
                                                        {bugId}
                                                    </span>
                                                ))}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </>
                )}
            </div>
        </Modal>
    );
}
