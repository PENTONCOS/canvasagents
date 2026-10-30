import { Fragment, memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { App, Empty, Input, Popconfirm, Select, Spin, Tag } from "antd";
import { useQuery } from "@tanstack/react-query";
import { History, ChevronDown, BookOpen, Check, ChevronRight, Download, Eye, FileText, Image as ImageIcon, LayoutGrid, ListChecks, Music2, Plus, Rows3, Search, Settings2, Square, Trash2, Type, Video } from "lucide-react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";

import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { AC_STATUS_COLOR, acStatusLabelKey, countAcByStatus } from "@/lib/delivery/ac-status";
import { acAnchor } from "@/lib/delivery/ac-testcase";
import { AcceptanceOverviewModal } from "./acceptance-overview";
import { createOrchestrator, reduceOrchestrator, replayOrchestrator } from "@/lib/delivery/orchestrator";
import { RUN_STATUS_COLOR, runStatusLabelKey } from "@/lib/delivery/run-status";
import { acResultsFromVerify, roundFromVerify, type VerifyPayload } from "@/lib/delivery/verify-plan";
import { subscribeVerifyEvents } from "@/lib/delivery/verify-events";
import {
    acResultsFromVerifyReport,
    roundFromVerifyReport,
    summaryFromVerifyPayload,
    verifySummaryParts,
    type VerifyReportEvent,
    type VerifyReportSummary,
} from "@/lib/delivery/verify-report";
import { exportCanvasNodes } from "@/lib/canvas/canvas-export";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { cn } from "@/lib/utils";
import { PromptDetailDialog } from "@/pages/prompts/components/prompt-detail-dialog";
import { fetchSourcePrompts, type Prompt } from "@/services/api/prompts";
import { uploadMediaFile } from "@/services/file-storage";
import { previewUrlFor, subscribeImagePreviews, getImagePreviewRevision, uploadImage } from "@/services/image-storage";
import { useAssetStore, type Asset, type AssetKind } from "@/stores/use-asset-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useDeliveryStore } from "@/stores/use-delivery-store";
import { usePromptSourceStore } from "@/stores/use-prompt-source-store";
import { CANVAS_SIDE_PANEL_MAX_WIDTH, CANVAS_SIDE_PANEL_MIN_WIDTH, CANVAS_SIDE_PANEL_MOTION_MS, useCanvasSidePanelStore } from "@/stores/use-canvas-side-panel-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCompactViewport } from "@/lib/use-compact-viewport";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { toWindowTabLabel } from "@/lib/agent/agent-windows";
import { nextEntityId, type AcceptanceCriterion, type DeliveryRunRound, type DeliveryTestCase, type Journey } from "@/types/delivery";

import type { InsertAssetPayload } from "./asset-picker-modal";

const PANEL_MOTION_SECONDS = CANVAS_SIDE_PANEL_MOTION_MS / 1000;
const PANEL_EASE = [0.22, 1, 0.36, 1] as const;
// 轮次状态比运行状态多一个 skipped（跑了但判不了）；不给它红色，避免把「没法判」画成「失败」。
const ROUND_STATUS_COLOR: Record<DeliveryRunRound["status"], string> = { ...RUN_STATUS_COLOR, skipped: "#94a3b8" };

type PanelTab = "canvas" | "assets" | "prompts" | "acceptance" | "runs";

type Props = {
    nodes: CanvasNodeData[];
    selectedNodeIds: Set<string>;
    onFocusNode: (nodeId: string) => void;
    onPreviewNode: (nodeId: string) => void;
    onHoverNode: (nodeId: string | null) => void;
    onInsertAsset: (payload: InsertAssetPayload) => void;
    /** D3: AC 正文改动直接落实体，同时同步画布节点上的展示文案。 */
    onAcStatementChange: (acId: string, statement: string) => void;
    /** D3: 把 AC 交给 Agent 生成用例——走既有投喂预览层，不另开通道。 */
    onGenerateTestCases: (acId: string, targetWindowId?: string) => void;
    /** WO-03: 按规则直接生成分层用例（不需要连 Agent），落成用例实体。 */
    onPlanTestCases: (acId: string) => void;
};

const NODE_TYPE_ICON: Record<string, typeof Square> = {
    [CanvasNodeType.Image]: ImageIcon,
    [CanvasNodeType.Video]: Video,
    [CanvasNodeType.Audio]: Music2,
    [CanvasNodeType.Text]: Type,
    [CanvasNodeType.Config]: Settings2,
    [CanvasNodeType.Group]: Square,
};

const STATUS_COLOR: Record<string, string> = {
    success: "#22c55e",
    loading: "#f59e0b",
    error: "#ef4444",
    idle: "transparent",
};

export function CanvasSidePanel({ nodes, selectedNodeIds, onFocusNode, onPreviewNode, onHoverNode, onInsertAsset, onAcStatementChange, onGenerateTestCases, onPlanTestCases }: Props) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [tab, setTab] = useState<PanelTab>("canvas");
    const width = useCanvasSidePanelStore((state) => state.width);
    // WO-05: 窄屏下侧栏变成覆盖层（占满屏宽），不再挤压画布。
    const compact = useCompactViewport();
    const panelOpen = useCanvasSidePanelStore((state) => state.panelOpen);
    const panelMounted = useCanvasSidePanelStore((state) => state.panelMounted);
    const panelClosing = useCanvasSidePanelStore((state) => state.panelClosing);
    const setWidth = useCanvasSidePanelStore((state) => state.setWidth);
    const [resizing, setResizing] = useState(false);

    const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        let nextWidth = startWidth;
        const onMove = (moveEvent: PointerEvent) => {
            nextWidth = Math.min(CANVAS_SIDE_PANEL_MAX_WIDTH, Math.max(CANVAS_SIDE_PANEL_MIN_WIDTH, startWidth + moveEvent.clientX - startX));
            setWidth(nextWidth);
        };
        const onUp = () => {
            localStorage.setItem("canvas-side-panel-width", String(nextWidth));
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            setResizing(false);
        };
        setResizing(true);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    if (!panelMounted) return null;

    return (
        <motion.div
            className={compact ? "absolute inset-y-0 left-0 z-[80] flex h-full shrink-0" : "relative z-[60] flex h-full shrink-0"}
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: panelOpen ? (compact ? "100%" : width + 1) : 0, opacity: panelOpen ? 1 : 0 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: PANEL_EASE }}
            style={{ overflow: "clip", pointerEvents: panelClosing ? "none" : undefined }}
        >
            <motion.aside
                className="relative flex h-full shrink-0 flex-col overflow-hidden border-r"
                initial={{ x: -48 }}
                animate={{ x: panelClosing ? -28 : 0 }}
                transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: PANEL_EASE }}
                style={{ width: compact ? "100%" : width, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                data-canvas-no-zoom
            >
                <div className="flex items-center gap-5 px-4 pt-3.5">
                    <TabButton label={t("canvas.sidePanel.canvas")} active={tab === "canvas"} theme={theme} onClick={() => setTab("canvas")} />
                    <TabButton label={t("canvas.sidePanel.assets")} active={tab === "assets"} theme={theme} onClick={() => setTab("assets")} />
                    <TabButton label={t("canvas.sidePanel.prompts")} active={tab === "prompts"} theme={theme} onClick={() => setTab("prompts")} />
                    <TabButton label={t("canvas.sidePanel.acceptance")} active={tab === "acceptance"} theme={theme} onClick={() => setTab("acceptance")} />
                    <TabButton label={t("canvas.sidePanel.runs")} active={tab === "runs"} theme={theme} onClick={() => setTab("runs")} />
                </div>
                <div className="mt-2 min-h-0 flex-1 overflow-hidden">
                    {tab === "canvas" ? (
                        <CanvasNodesTab nodes={nodes} selectedNodeIds={selectedNodeIds} onFocusNode={onFocusNode} onPreviewNode={onPreviewNode} onHoverNode={onHoverNode} theme={theme} />
                    ) : tab === "assets" ? (
                        <CanvasAssetsTab onInsert={onInsertAsset} theme={theme} />
                    ) : tab === "prompts" ? (
                        <CanvasPromptsTab onInsert={onInsertAsset} theme={theme} />
                    ) : tab === "acceptance" ? (
                        <DeliveryAcceptanceTab theme={theme} onFocusNode={onFocusNode} onAcStatementChange={onAcStatementChange} onGenerateTestCases={onGenerateTestCases} onPlanTestCases={onPlanTestCases} />
                    ) : (
                        <DeliveryRunsTab nodes={nodes} theme={theme} onFocusNode={onFocusNode} />
                    )}
                </div>
                <button type="button" className="absolute inset-y-0 right-0 z-40 w-4 translate-x-1/2 cursor-col-resize" onPointerDown={startResize} aria-label={t("canvas.sidePanel.resize")} />
            </motion.aside>
        </motion.div>
    );
}

function TabButton({ label, active, theme, onClick }: { label: string; active: boolean; theme: CanvasTheme; onClick: () => void }) {
    return (
        <button type="button" onClick={onClick} className="relative pb-1.5 text-sm font-semibold transition-opacity" style={{ color: theme.node.text, opacity: active ? 1 : 0.45 }}>
            {label}
            {active ? <motion.span layoutId="sidePanelTabIndicator" className="absolute inset-x-0 -bottom-px h-0.5 rounded-full" style={{ background: theme.toolbar.activeText }} transition={{ type: "spring", stiffness: 500, damping: 34 }} /> : null}
        </button>
    );
}

// M2: 验收标签页。状态色与画布节点徽章共用 AC_STATUS_COLOR，保证两处一致。
// D3: 每条 AC 下面直接挂用例（数量 + 列表），能从 AC 新建用例（锚点自动生成），
// 也能把这条 AC 连同旅程/步骤交给 Agent 生成用例——生成提示词同样走投喂预览层。
function DeliveryAcceptanceTab({
    theme,
    onFocusNode,
    onAcStatementChange,
    onGenerateTestCases,
    onPlanTestCases,
}: {
    theme: CanvasTheme;
    onFocusNode: (nodeId: string) => void;
    onAcStatementChange: (acId: string, statement: string) => void;
    onGenerateTestCases: (acId: string, targetWindowId?: string) => void;
    onPlanTestCases: (acId: string) => void;
}) {
    const { t } = useTranslation();
    const acceptance = useDeliveryStore((state) => state.acceptance);
    const testCases = useDeliveryStore((state) => state.testCases);
    const journeys = useDeliveryStore((state) => state.journeys);
    const windows = useAgentStore((state) => state.windows);
    const activeWindowId = useAgentStore((state) => state.activeWindowId);
    const items = useMemo(() => Object.values(acceptance).sort((a, b) => a.id.localeCompare(b.id)), [acceptance]);
    const counts = useMemo(() => countAcByStatus(items.map((item) => item.status)), [items]);
    // 用例按 acId 归堆一次，侧栏每条 AC 只做一次查表，不重复扫全量。
    const casesByAc = useMemo(() => {
        const map = new Map<string, DeliveryTestCase[]>();
        for (const testCase of Object.values(testCases)) {
            const bucket = map.get(testCase.acId);
            if (bucket) bucket.push(testCase);
            else map.set(testCase.acId, [testCase]);
        }
        for (const bucket of map.values()) bucket.sort((a, b) => a.id.localeCompare(b.id));
        return map;
    }, [testCases]);
    const journeyList = useMemo(() => Object.values(journeys).sort((a, b) => a.id.localeCompare(b.id)), [journeys]);
    const [overviewOpen, setOverviewOpen] = useState(false);
    // 投喂目标窗默认当前窗；目标窗被关掉时回落，避免预览指向一个不存在的窗。
    const [targetWindowId, setTargetWindowId] = useState(activeWindowId);
    const target = windows.some((window) => window.id === targetWindowId) ? targetWindowId : activeWindowId;

    if (items.length === 0) {
        return (
            <div className="px-4 py-6 text-xs" style={{ color: theme.node.muted }} data-testid="acceptance-empty">
                {t("canvas.sidePanel.acEmpty")}
            </div>
        );
    }

    return (
        <div className="h-full overflow-y-auto px-3 pb-4" data-testid="acceptance-list">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-2 text-[11px]" style={{ color: theme.node.muted }}>
                <span>{t("canvas.sidePanel.acTotal", { count: items.length })}</span>
                <span style={{ color: AC_STATUS_COLOR.passing }}>{t("canvas.sidePanel.acPassing", { count: counts.passing })}</span>
                <span style={{ color: AC_STATUS_COLOR.failing }}>{t("canvas.sidePanel.acFailing", { count: counts.failing })}</span>
                <button
                    type="button"
                    className="ml-auto rounded border px-1.5 py-0.5 text-[11px] transition-opacity hover:opacity-80"
                    style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                    onClick={() => setOverviewOpen(true)}
                    data-testid="acceptance-overview-open"
                >
                    {t("canvas.acOverview.open")}
                </button>
            </div>
            {windows.length > 0 ? (
                <label className="mb-1 flex items-center gap-1 px-1 text-[10px]" style={{ color: theme.node.muted }}>
                    <span>{t("canvas.sidePanel.acGenTarget")}</span>
                    <select
                        className="h-6 min-w-0 flex-1 rounded border px-1 text-[10px]"
                        style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.text }}
                        value={target}
                        onChange={(event) => setTargetWindowId(event.target.value)}
                        data-testid="ac-gen-target"
                    >
                        {windows.map((window, index) => (
                            <option key={window.id} value={window.id}>
                                {toWindowTabLabel(window, index)}
                            </option>
                        ))}
                    </select>
                </label>
            ) : null}
            {items.map((item) => (
                <AcCard
                    key={item.id}
                    ac={item}
                    theme={theme}
                    cases={casesByAc.get(item.id) || []}
                    journeys={journeyList}
                    onFocusNode={onFocusNode}
                    onAcStatementChange={onAcStatementChange}
                    onGenerateTestCases={() => onGenerateTestCases(item.id, target)}
                    onPlanTestCases={() => onPlanTestCases(item.id)}
                />
            ))}
            <AcceptanceOverviewModal open={overviewOpen} theme={theme} onClose={() => setOverviewOpen(false)} onFocusNode={onFocusNode} />
        </div>
    );
}

/**
 * D3: 单条 AC 卡片。正文可改（生成用例必须读得到），用例列表、新建入口、
 * 旅程/步骤归属都在这里——AC 是这条链的主语，用例是它的证据。
 */
function AcCard({
    ac,
    theme,
    cases,
    journeys,
    onFocusNode,
    onAcStatementChange,
    onGenerateTestCases,
    onPlanTestCases,
}: {
    ac: AcceptanceCriterion;
    theme: CanvasTheme;
    cases: DeliveryTestCase[];
    journeys: Journey[];
    onFocusNode: (nodeId: string) => void;
    onAcStatementChange: (acId: string, statement: string) => void;
    onGenerateTestCases: () => void;
    onPlanTestCases: () => void;
}) {
    const { t } = useTranslation();
    const steps = useDeliveryStore((state) => state.steps);
    const createTestCaseForAc = useDeliveryStore((state) => state.createTestCaseForAc);
    const removeTestCase = useDeliveryStore((state) => state.removeTestCase);
    const setAcJourney = useDeliveryStore((state) => state.setAcJourney);
    const setAcStep = useDeliveryStore((state) => state.setAcStep);
    const [statementDraft, setStatementDraft] = useState(ac.statement);
    const [creating, setCreating] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");

    useEffect(() => setStatementDraft(ac.statement), [ac.statement]);

    const journeyId = (ac.journeyIds ?? [])[0] || "";
    const stepId = (ac.stepIds ?? [])[0] || "";
    const journeySteps = useMemo(
        () => Object.values(steps).filter((step) => step.journeyId === journeyId).sort((a, b) => a.order - b.order),
        [steps, journeyId],
    );
    const anchor = acAnchor(ac.id);

    const commitStatement = () => {
        const next = statementDraft.trim();
        if (next !== ac.statement) onAcStatementChange(ac.id, next);
    };

    const saveCase = () => {
        const created = createTestCaseForAc(ac.id, { title: titleDraft });
        if (!created) return;
        setTitleDraft("");
        setCreating(false);
    };

    return (
        <div className="mb-1 rounded-md px-2 py-1.5 text-xs transition-opacity" style={{ background: theme.node.fill, color: theme.node.text }} data-ac-id={ac.id} data-ac-status={ac.status}>
            <div className="flex items-start gap-2">
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: AC_STATUS_COLOR[ac.status] }} />
                <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left transition-opacity hover:opacity-80" onClick={() => ac.nodeId && onFocusNode(ac.nodeId)} data-ac-focus>
                    <span className="font-medium">{ac.id}</span>
                    <span className="rounded px-1 text-[10px]" style={{ background: `${AC_STATUS_COLOR[ac.status]}22`, color: AC_STATUS_COLOR[ac.status] }}>
                        {t(acStatusLabelKey(ac.status))}
                    </span>
                    {cases.length === 0 ? (
                        <span
                            className="shrink-0 rounded px-1 text-[10px] font-medium"
                            style={{ background: "rgba(239,68,68,0.14)", color: "#ef4444" }}
                            data-unproven="true"
                            title="这条验收标准没有任何用例，等于无法证明"
                        >
                            {t("canvas.acOverview.unproven", { defaultValue: "不可证明" })}
                        </span>
                    ) : null}
                    <span className="ml-auto shrink-0 text-[10px]" style={{ color: theme.node.muted }} data-testcase-count={cases.length}>
                        {t("canvas.sidePanel.acCases", { count: cases.length })}
                    </span>
                </button>
            </div>
            <input
                className="mt-1 w-full rounded border-0 bg-transparent px-0 py-0 text-[11px] outline-none"
                style={{ color: theme.node.muted }}
                value={statementDraft}
                placeholder={t("canvas.sidePanel.acStatementPlaceholder")}
                onChange={(event) => setStatementDraft(event.target.value)}
                onBlur={commitStatement}
                onKeyDown={(event) => {
                    if (event.key === "Enter") commitStatement();
                    if (event.key === "Escape") setStatementDraft(ac.statement);
                }}
                data-testid="ac-statement-input"
            />
            {journeys.length > 0 ? (
                <div className="mt-1 flex items-center gap-1">
                    <select
                        className="h-6 min-w-0 flex-1 rounded border px-1 text-[10px]"
                        style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.text }}
                        value={journeyId}
                        onChange={(event) => setAcJourney(ac.id, event.target.value || undefined)}
                        data-testid="ac-journey-select"
                    >
                        <option value="">{t("canvas.sidePanel.acLinkNone")}</option>
                        {journeys.map((journey) => (
                            <option key={journey.id} value={journey.id}>
                                {journey.id} {journey.title}
                            </option>
                        ))}
                    </select>
                    {journeySteps.length > 0 ? (
                        <select
                            className="h-6 min-w-0 flex-1 rounded border px-1 text-[10px]"
                            style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.text }}
                            value={stepId}
                            onChange={(event) => setAcStep(ac.id, event.target.value || undefined)}
                            data-testid="ac-step-select"
                        >
                            <option value="">{t("canvas.sidePanel.acLinkNone")}</option>
                            {journeySteps.map((step) => (
                                <option key={step.id} value={step.id}>
                                    {step.id} {step.title}
                                </option>
                            ))}
                        </select>
                    ) : null}
                </div>
            ) : null}
            <ul className="mt-1.5 space-y-0.5 border-t pt-1" style={{ borderColor: `${theme.node.stroke}66` }}>
                {cases.map((testCase) => (
                    <li key={testCase.id} className="flex items-center gap-1 text-[10px]" data-testcase-id={testCase.id}>
                        <span className="min-w-0 flex-1 truncate" title={testCase.title}>
                            {testCase.id} {testCase.title}
                        </span>
                        {/* 用例侧回指：点锚点就回到它验的那条 AC 节点，不用自己找。 */}
                        <button
                            type="button"
                            className="shrink-0 rounded border px-1 transition-opacity hover:opacity-80"
                            style={{ borderColor: theme.node.stroke, color: theme.node.muted }}
                            onClick={() => ac.nodeId && onFocusNode(ac.nodeId)}
                            data-testcase-anchor={testCase.selector || anchor}
                        >
                            {t("canvas.sidePanel.acCaseVerifies", { anchor: testCase.selector || anchor })}
                        </button>
                        <button type="button" className="shrink-0 px-0.5 transition-opacity hover:opacity-70" style={{ color: theme.node.muted }} onClick={() => removeTestCase(testCase.id)} aria-label={t("canvas.sidePanel.acCaseDelete")} data-testcase-delete>
                            ×
                        </button>
                    </li>
                ))}
            </ul>
            {creating ? (
                <div className="mt-1 flex items-center gap-1">
                    <input
                        className="h-6 min-w-0 flex-1 rounded border px-1 text-[10px]"
                        style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.text }}
                        value={titleDraft}
                        placeholder={t("canvas.sidePanel.acNewCasePlaceholder", { anchor })}
                        onChange={(event) => setTitleDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") saveCase();
                            if (event.key === "Escape") {
                                setCreating(false);
                                setTitleDraft("");
                            }
                        }}
                        autoFocus
                        data-testid="ac-new-test-input"
                    />
                    <button type="button" className="shrink-0 rounded border px-1 text-[10px] disabled:opacity-40" style={{ borderColor: theme.node.stroke, color: theme.node.text }} disabled={!titleDraft.trim()} onClick={saveCase} data-testid="ac-new-test-save">
                        {t("canvas.sidePanel.acNewCaseSave")}
                    </button>
                    <button
                        type="button"
                        className="shrink-0 px-0.5 text-[10px]"
                        style={{ color: theme.node.muted }}
                        onClick={() => {
                            setCreating(false);
                            setTitleDraft("");
                        }}
                    >
                        {t("canvas.sidePanel.acNewCaseCancel")}
                    </button>
                </div>
            ) : (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                    <button
                        type="button"
                        className="rounded border px-1.5 py-0.5 text-[10px] transition-opacity hover:opacity-80"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                        onClick={() => setCreating(true)}
                        data-testid="ac-new-test"
                    >
                        {t("canvas.sidePanel.acNewCase")}
                    </button>
                    <button
                        type="button"
                        className="rounded border px-1.5 py-0.5 text-[10px] transition-opacity hover:opacity-80"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                        onClick={onGenerateTestCases}
                        data-testid="ac-generate-tests"
                    >
                        {t("canvas.sidePanel.acGenerate")}
                    </button>
                    <button
                        type="button"
                        className="rounded border px-1.5 py-0.5 text-[10px] transition-opacity hover:opacity-80"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                        onClick={onPlanTestCases}
                        data-testid="ac-plan-tests"
                    >
                        {t("canvas.sidePanel.acPlan", { defaultValue: "按规则生成" })}
                    </button>
                    <span className="text-[10px]" style={{ color: theme.node.muted }}>
                        {anchor}
                    </span>
                </div>
            )}
        </div>
    );
}

// M4: 运行历史 + 验收执行。浏览器只发一次 /delivery/verify，跑不跑下一轮由编排器决定。
// E2/E3: 每轮结束的结果同时走 HTTP 响应与 `delivery_verify` 事件流，按 reportId 去重后落库；
// 顶部一行摘要直接读最近一轮的结构化结果，失败的 AC 可点回画布节点。
function DeliveryRunsTab({ nodes, theme, onFocusNode }: { nodes: CanvasNodeData[]; theme: CanvasTheme; onFocusNode: (nodeId: string) => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const runs = useDeliveryStore((state) => state.runs);
    const acceptance = useDeliveryStore((state) => state.acceptance);
    const replayRun = useDeliveryStore((state) => state.replayRun);
    const upsertRun = useDeliveryStore((state) => state.upsertRun);
    const applyVerifyReport = useDeliveryStore((state) => state.applyVerifyReport);
    const agentUrl = useAgentStore((state) => state.url);
    const agentToken = useAgentStore((state) => state.token);
    const items = useMemo(() => Object.values(runs).sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || "")), [runs]);
    const nodeIds = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);

    const [command, setCommand] = useState("bun test");
    const [cwd, setCwd] = useState("");
    const [reportPath, setReportPath] = useState("");
    const [reportType, setReportType] = useState<"playwright" | "vitest">("playwright");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    // 编排状态不单独存：轮次已经写进 run，按落库数据重建即可，切 tab / 刷新都不会丢进度。
    const activeRun = useMemo(() => Object.values(runs).sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""))[0], [runs]);
    const orchestrator = useMemo(() => replayOrchestrator(activeRun?.rounds || []), [activeRun]);
    const latestRound = activeRun?.rounds?.length ? activeRun.rounds[activeRun.rounds.length - 1] : undefined;
    const summaryParts = useMemo(() => (latestRound ? verifySummaryParts(latestRound) : null), [latestRound]);

    // E2 事件流：桥端每轮结束时广播结构化摘要；这里只负责落地，数字不二次计算。
    useEffect(() => {
        if (!agentUrl.trim()) return;
        return subscribeVerifyEvents({ url: agentUrl, token: agentToken }, (event: VerifyReportEvent) => {
            const state = useDeliveryStore.getState();
            const stored = state.runs;
            const sorted = Object.values(stored).sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
            const runId = (event.runId && stored[event.runId] ? event.runId : "") || sorted[0]?.id || "";
            if (!runId) return;
            const run = stored[runId];
            // 轮次编号与编排器一致：沿用请求里带来的编号，缺省时按已有轮次 +1。
            const index = event.roundIndex && event.roundIndex > 0 ? event.roundIndex : (run.rounds?.length || 0) + 1;
            const round = roundFromVerifyReport({ ...event, output: event.outputTail || event.output }, index, event.startedAt);
            state.applyVerifyReport({ runId, round, acResults: acResultsFromVerifyReport(event) });
        });
    }, [agentUrl, agentToken]);

    // 一轮一块：第一次点「运行」开一次运行，之后每次点都是同一次运行的下一轮（修完再跑）。
    const startVerify = async () => {
        if (busy) return;
        if (!command.trim()) {
            setError(t("canvas.sidePanel.verifyCommandRequired"));
            return;
        }
        if (!cwd.trim().startsWith("/")) {
            setError(t("canvas.sidePanel.verifyCwdRequired"));
            return;
        }
        setBusy(true);
        setError("");
        try {
            const at = new Date().toISOString();
            // 运行归属先定下来：桥端事件要带回同一个 runId / 轮次编号，前端才不用猜。
            const storedBefore = useDeliveryStore.getState().runs;
            const latest = Object.values(storedBefore).sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""))[0];
            let state = latest ? replayOrchestrator(latest.rounds || []) : createOrchestrator();
            let runId = latest?.id || "";
            // 上一次运行已经全绿或已升级，就开新的一次运行；否则这一轮属于同一次运行的修复循环。
            const fresh = !runId || state.phase === "passed" || state.phase === "escalated";
            if (fresh) {
                runId = nextEntityId(Object.keys(storedBefore), "RUN");
                upsertRun({ id: runId, kind: "test", command, cwd, startedAt: at, status: "running", results: [], rounds: [] });
                state = reduceOrchestrator(createOrchestrator(), { type: "start", at });
            }
            const roundIndex = (useDeliveryStore.getState().runs[runId]?.rounds?.length || 0) + 1;
            const response = await fetch(`${agentUrl.replace(/\/$/, "")}/delivery/verify`, {
                method: "POST",
                headers: { "content-type": "application/json", ...(agentToken ? { "x-canvas-agent-token": agentToken } : {}) },
                body: JSON.stringify({ command, cwd, reportPath, reportType, runId, roundIndex }),
            });
            const payload = (await response.json()) as VerifyPayload;
            // 数字来自桥端解析后的 summary；老桥端没有 summary 时才按 results 兼容推导。
            const summary = summaryFromVerifyPayload(payload);
            // 以 store 里的最新数据为准：闭包里的 runs 可能是上一次渲染的旧值（事件可能已经先到）。
            const stored = useDeliveryStore.getState().runs;
            const targetRunId = payload.runId && stored[payload.runId] ? payload.runId : runId;
            const index = payload.roundIndex && payload.roundIndex > 0 ? payload.roundIndex : ((stored[targetRunId]?.rounds?.length || 0) + 1);
            const round = roundFromVerifyReport({ ...summary, startedAt: payload.startedAt || at, finishedAt: payload.finishedAt || at, exitCode: payload.command?.exitCode ?? null, output: payload.command?.output }, index, at);
            const result = applyVerifyReport({ runId: targetRunId, round, acResults: acResultsFromVerifyReport(summary) });
            state = replayOrchestrator(useDeliveryStore.getState().runs[targetRunId]?.rounds || []);
            // 事件流先到就是重复到达：同一份报告只累计一轮，也不再重复提示。
            if (result.applied) {
                state = reduceOrchestrator(state, { type: "round", at: round.finishedAt || at, round });
                if (state.phase === "passed") message.success(t("canvas.sidePanel.verifyPassed", { count: round.passed }));
                else if (state.phase === "escalated") message.warning(t("canvas.sidePanel.verifyGuardrail", { reason: state.stopReason || "" }));
                else if (round.status === "skipped") message.info(t("canvas.sidePanel.verifySkipped"));
                else message.info(t("canvas.sidePanel.verifyFailed", { count: round.failed }));
            }
            if (payload.error) setError(String(payload.error));
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="h-full overflow-y-auto px-3 pb-4" data-testid="runs-panel">
            <div className="mb-2 rounded-md p-2" style={{ background: theme.node.fill }} data-testid="verify-form">
                <div className="mb-1 text-[11px] font-medium" style={{ color: theme.node.text }}>
                    {t("canvas.sidePanel.verifyTitle")}
                </div>
                <Input size="small" className="mb-1" value={command} onChange={(event) => setCommand(event.target.value)} placeholder={t("canvas.sidePanel.verifyCommandPlaceholder")} data-testid="verify-command" />
                <Input size="small" className="mb-1" value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder={t("canvas.sidePanel.verifyCwdPlaceholder")} data-testid="verify-cwd" />
                <Input size="small" className="mb-1" value={reportPath} onChange={(event) => setReportPath(event.target.value)} placeholder={t("canvas.sidePanel.verifyReportPlaceholder")} data-testid="verify-report" />
                <div className="flex flex-wrap items-center gap-2">
                    <Select size="small" value={reportType} onChange={(value: "playwright" | "vitest") => setReportType(value)} options={[{ value: "playwright", label: "Playwright" }, { value: "vitest", label: "Vitest" }]} style={{ width: 110 }} data-testid="verify-report-type" />
                    <button type="button" disabled={busy} onClick={() => void startVerify()} className="rounded px-2 py-1 text-[11px] disabled:opacity-50" style={{ background: theme.toolbar.activeText, color: theme.node.fill }} data-testid="verify-run">
                        {busy ? t("canvas.sidePanel.verifyRunning") : t("canvas.sidePanel.verifyRun")}
                    </button>
                </div>
                {orchestrator.stopReason ? (
                    <div className="mt-1 text-[10px]" style={{ color: RUN_STATUS_COLOR.error }} data-testid="verify-stop">
                        {orchestrator.stopReason}
                    </div>
                ) : null}
                {error ? (
                    <div className="mt-1 text-[10px]" style={{ color: RUN_STATUS_COLOR.failed }} data-testid="verify-error">
                        {error}
                    </div>
                ) : null}
            </div>
            {summaryParts && latestRound ? (
                <div
                    className="mb-2 rounded-md px-2 py-1.5 text-[11px]"
                    data-testid="verify-summary"
                    data-verify-status={summaryParts.status}
                    data-verify-round={latestRound.index}
                    style={{ background: theme.node.fill, color: theme.node.text }}
                    aria-label={t("canvas.sidePanel.verifySummaryAria")}
                >
                    <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
                        <span aria-hidden="true" className="font-semibold" style={{ color: ROUND_STATUS_COLOR[summaryParts.status] }}>
                            {summaryParts.status === "passed" ? "✓" : summaryParts.status === "failed" || summaryParts.status === "error" ? "✗" : "–"}
                        </span>
                        <span className="font-medium" style={{ color: ROUND_STATUS_COLOR[summaryParts.status] }}>
                            {t("canvas.sidePanel.verifySummaryRound", { index: latestRound.index })}
                        </span>
                        <span style={{ color: summaryParts.status === "passed" ? AC_STATUS_COLOR.passing : theme.node.muted }} data-verify-count="passed">
                            {t("canvas.sidePanel.verifySummaryPassed", { count: summaryParts.passed })}
                        </span>
                        <span style={{ color: theme.node.muted }}>·</span>
                        <span style={{ color: summaryParts.failed > 0 ? RUN_STATUS_COLOR.failed : theme.node.muted }} data-verify-count="failed">
                            {t("canvas.sidePanel.verifySummaryFailed", { count: summaryParts.failed })}
                        </span>
                        {summaryParts.skipped > 0 ? (
                            <Fragment>
                                <span style={{ color: theme.node.muted }}>·</span>
                                <span style={{ color: theme.node.muted }} data-verify-count="skipped">
                                    {t("canvas.sidePanel.verifySummarySkipped", { count: summaryParts.skipped })}
                                </span>
                            </Fragment>
                        ) : null}
                        {summaryParts.failingAcIds.length > 0 ? (
                            <span className="flex flex-wrap items-center gap-0.5" data-testid="verify-summary-failing">
                                <span style={{ color: theme.node.muted }}>(</span>
                                {summaryParts.failingAcIds.map((acId, index) => {
                                    const nodeId = acceptance[acId]?.nodeId;
                                    // 节点不存在就不给点，但 AC 仍然展示——不报错、不隐藏失败。
                                    const canFocus = Boolean(nodeId && nodeIds.has(nodeId));
                                    return (
                                        <Fragment key={acId}>
                                            {index > 0 ? <span style={{ color: theme.node.muted }}>,</span> : null}
                                            {canFocus ? (
                                                <button
                                                    type="button"
                                                    className="rounded px-0.5 font-medium underline-offset-2 hover:underline"
                                                    style={{ color: RUN_STATUS_COLOR.failed }}
                                                    title={t("canvas.sidePanel.verifySummaryJump", { acId })}
                                                    onClick={() => onFocusNode(String(nodeId))}
                                                    data-ac-chip={acId}
                                                >
                                                    {acId}
                                                </button>
                                            ) : (
                                                <span style={{ color: RUN_STATUS_COLOR.failed }} data-ac-chip={acId} data-ac-clickable="false">
                                                    {acId}
                                                </span>
                                            )}
                                        </Fragment>
                                    );
                                })}
                                <span style={{ color: theme.node.muted }}>)</span>
                            </span>
                        ) : null}
                    </div>
                    {summaryParts.unanchored > 0 ? (
                        <div className="mt-0.5" style={{ color: theme.node.muted }} data-testid="verify-summary-unanchored">
                            {t("canvas.sidePanel.verifySummaryUnanchored", { count: summaryParts.unanchored })}
                        </div>
                    ) : null}
                    {latestRound.status === "error" ? (
                        <div className="mt-0.5" style={{ color: RUN_STATUS_COLOR.error }} data-testid="verify-summary-parse-error">
                            {t("canvas.sidePanel.verifySummaryParseError")}
                        </div>
                    ) : null}
                    {latestRound.status === "skipped" ? (
                        <div className="mt-0.5" style={{ color: theme.node.muted }} data-testid="verify-summary-skipped">
                            {t("canvas.sidePanel.verifySummaryNoReport")}
                        </div>
                    ) : null}
                </div>
            ) : null}
            {items.length === 0 ? (
                <div className="px-1 py-4 text-xs" style={{ color: theme.node.muted }} data-testid="runs-empty">
                    {t("canvas.sidePanel.runEmpty")}
                </div>
            ) : (
                <div data-testid="runs-list">
                    <div className="px-1 py-2 text-[11px]" style={{ color: theme.node.muted }}>
                        {t("canvas.sidePanel.runTotal", { count: items.length })}
                    </div>
                    {items.map((run) => (
                        <div key={run.id} className="mb-1 rounded-md px-2 py-1.5 text-xs" style={{ background: theme.node.fill, color: theme.node.text }} data-run-id={run.id} data-run-status={run.status}>
                            <div className="flex items-center gap-2">
                                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: RUN_STATUS_COLOR[run.status] }} />
                                <span className="font-medium">{run.id}</span>
                                <span className="rounded px-1 text-[10px]" style={{ background: `${RUN_STATUS_COLOR[run.status]}22`, color: RUN_STATUS_COLOR[run.status] }}>
                                    {t(runStatusLabelKey(run.status))}
                                </span>
                                <span className="text-[10px]" style={{ color: theme.node.muted }}>
                                    {run.kind}
                                    {run.rounds?.length ? ` · ${t("canvas.sidePanel.runRounds", { count: run.rounds.length })}` : ""}
                                </span>
                            </div>
                            {run.rounds?.length ? (
                                <div className="mt-1 flex flex-col gap-0.5 pl-4 text-[10px]" style={{ color: theme.node.muted }}>
                                    {run.rounds.map((round) => (
                                        <span key={round.index} data-round-index={round.index} data-round-status={round.status}>
                                            #{round.index} · {round.status} · {t("canvas.sidePanel.acFailing", { count: round.failed })}
                                        </span>
                                    ))}
                                </div>
                            ) : null}
                            <div className="mt-1 flex gap-2 pl-4">
                                <button type="button" className="text-[10px] underline-offset-2 hover:underline" style={{ color: theme.node.muted }} onClick={() => {
                                        const result = replayRun(run.id);
                                        if (result.applied.length > 0) message.success(t("canvas.sidePanel.runReplayDone", { count: result.applied.length }));
                                        else message.info(t("canvas.sidePanel.runReplayNone"));
                                    }} data-run-replay>
                                    {t("canvas.sidePanel.runReplay")}
                                </button>
                                {run.nodeId ? (
                                    <button type="button" className="text-[10px] underline-offset-2 hover:underline" style={{ color: theme.node.muted }} onClick={() => onFocusNode(String(run.nodeId))}>
                                        {t("canvas.sidePanel.runFocus")}
                                    </button>
                                ) : null}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Canvas tab: list nodes and center, zoom, and select the clicked node.
// ---------------------------------------------------------------------------

const NODE_FILTER_VALUES = ["all", CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Text, CanvasNodeType.Audio, CanvasNodeType.Config, CanvasNodeType.Group];

function nodePreviewText(node: CanvasNodeData) {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt || "";
    return getNodeDefinition(node.type)?.title || node.type;
}

function CanvasNodesTab({ nodes, selectedNodeIds, onFocusNode, onPreviewNode, onHoverNode, theme }: { nodes: CanvasNodeData[]; selectedNodeIds: Set<string>; onFocusNode: (nodeId: string) => void; onPreviewNode: (nodeId: string) => void; onHoverNode: (nodeId: string | null) => void; theme: CanvasTheme }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const [keyword, setKeyword] = useState("");
    const [typeFilter, setTypeFilter] = useState<string>("all");
    const [selectMode, setSelectMode] = useState(false);
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
    const [exporting, setExporting] = useState(false);
    const nodeViewMode = useCanvasSidePanelStore((state) => state.nodeViewMode);
    const setNodeViewMode = useCanvasSidePanelStore((state) => state.setNodeViewMode);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return nodes.filter((node) => (typeFilter === "all" || node.type === typeFilter) && (!query || [node.title, node.metadata?.content, node.metadata?.prompt].filter(Boolean).join(" ").toLowerCase().includes(query)));
    }, [nodes, keyword, typeFilter]);
    const treeRows = useMemo(() => {
        const filteredIds = new Set(filtered.map((node) => node.id));
        const groups = new Set(nodes.filter((node) => node.type === CanvasNodeType.Group).map((node) => node.id));
        const children = new Map<string, CanvasNodeData[]>();
        filtered.forEach((node) => {
            const groupId = node.metadata?.groupId;
            if (groupId && groups.has(groupId)) children.set(groupId, [...(children.get(groupId) || []), node]);
        });
        return nodes.flatMap((node) => {
            if (node.metadata?.groupId && groups.has(node.metadata.groupId)) return [];
            if (node.type !== CanvasNodeType.Group) return filteredIds.has(node.id) ? [{ node, depth: 0, hasChildren: false }] : [];
            const groupChildren = children.get(node.id) || [];
            if (!filteredIds.has(node.id) && !groupChildren.length) return [];
            return [{ node, depth: 0, hasChildren: groupChildren.length > 0 }, ...(collapsedGroups.has(node.id) ? [] : groupChildren.map((child) => ({ node: child, depth: 1, hasChildren: false })))];
        });
    }, [collapsedGroups, filtered, nodes]);

    const exitSelect = () => {
        setSelectMode(false);
        setChecked(new Set());
    };
    const toggleChecked = (id: string) =>
        setChecked((prev) => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    const allChecked = filtered.length > 0 && filtered.every((node) => checked.has(node.id));
    const toggleAll = () => setChecked(allChecked ? new Set() : new Set(filtered.map((node) => node.id)));

    // Let the hover preview fade out before the canvas starts moving to the node.
    const PRESS_FOCUS_DELAY = 180;
    const focusTimerRef = useRef<number | null>(null);
    useEffect(() => () => { if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current); }, []);
    const activateNode = (node: CanvasNodeData) => {
        if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
        focusTimerRef.current = null;
        const hasPreview = (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) && Boolean(node.metadata?.content);
        if (!hasPreview) {
            onFocusNode(node.id);
            return;
        }
        onHoverNode(null);
        focusTimerRef.current = window.setTimeout(() => {
            focusTimerRef.current = null;
            onFocusNode(node.id);
        }, PRESS_FOCUS_DELAY);
    };

    const handleExport = async () => {
        const targets = nodes.filter((node) => checked.has(node.id));
        if (!targets.length) return;
        setExporting(true);
        const hide = message.loading(t("canvas.sidePanel.exporting"), 0);
        try {
            await exportCanvasNodes(targets, t("canvas.sidePanel.exportName", { count: targets.length }));
            message.success(t("canvas.sidePanel.exported", { count: targets.length }));
            exitSelect();
        } catch (error) {
            console.error(error);
            message.error(t("canvas.sidePanel.exportFailed"));
        } finally {
            hide();
            setExporting(false);
        }
    };

    return (
        <div className="flex h-full flex-col" onMouseLeave={() => onHoverNode(null)}>
            <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
                <span className="min-w-0 truncate text-xs font-medium opacity-60">{t("canvas.sidePanel.elements")}</span>
                {filtered.length ? <span className="shrink-0 text-xs opacity-35">{filtered.length}</span> : null}
                <button
                    type="button"
                    onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
                    className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-1 text-xs font-medium opacity-70 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
                    style={selectMode ? { color: theme.toolbar.activeText, opacity: 1 } : undefined}
                >
                    <ListChecks className="size-3.5" />
                    {selectMode ? t("common.cancel") : t("canvas.sidePanel.select")}
                </button>
                {selectMode ? null : <Select size="small" variant="borderless" className="w-20" value={typeFilter} onChange={setTypeFilter} options={NODE_FILTER_VALUES.map((value) => ({ value, label: value === "all" ? t("common.all") : t(`canvas.sidePanel.filter.${value}`) }))} />}
                <button
                    type="button"
                    onClick={() => setNodeViewMode(nodeViewMode === "grid" ? "list" : "grid")}
                    className="flex shrink-0 items-center rounded-md px-1.5 py-1 opacity-70 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
                    title={nodeViewMode === "grid" ? t("canvas.sidePanel.viewList") : t("canvas.sidePanel.viewGrid")}
                    aria-label={nodeViewMode === "grid" ? t("canvas.sidePanel.viewList") : t("canvas.sidePanel.viewGrid")}
                >
                    {nodeViewMode === "grid" ? <Rows3 className="size-3.5" /> : <LayoutGrid className="size-3.5" />}
                </button>
            </div>
            <div className="px-3 pb-2.5">
                <Input size="small" allowClear prefix={<Search className="size-3.5 text-stone-400" />} placeholder={t("canvas.sidePanel.searchNodes")} value={keyword} onChange={(e) => setKeyword(e.target.value)} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                {nodeViewMode === "grid" ? (
                    filtered.length ? (
                        <div className="grid gap-2 px-1 [grid-template-columns:repeat(auto-fill,minmax(88px,1fr))]">
                            {filtered.map((node) => {
                                const Icon = NODE_TYPE_ICON[node.type] || FileText;
                                const isImage = node.type === CanvasNodeType.Image && node.metadata?.content;
                                const isChecked = checked.has(node.id);
                                const active = selectMode ? isChecked : selectedNodeIds.has(node.id);
                                return (
                                    <button
                                        key={node.id}
                                        type="button"
                                        data-node-item
                                        onClick={() => (selectMode ? toggleChecked(node.id) : activateNode(node))}
                                        onMouseEnter={() => onHoverNode(node.id)}
                                        onMouseLeave={(event) => {
                                            const to = event.relatedTarget as Element | null;
                                            if (!to || !to.closest("[data-node-item]")) onHoverNode(null);
                                        }}
                                        className="group relative flex min-w-0 flex-col rounded-lg p-1 text-left transition hover:bg-black/5 dark:hover:bg-white/5"
                                        style={active ? { background: theme.toolbar.activeBg } : undefined}
                                        title={selectMode ? undefined : t("canvas.sidePanel.focusNode")}
                                    >
                                        <span className="relative grid aspect-square w-full place-items-center overflow-hidden rounded-md">
                                            {isImage ? <img src={previewUrlFor(node.metadata?.storageKey) || node.metadata?.content} alt={node.title} className="size-full object-cover" /> : <Icon className="size-6 opacity-60" />}
                                            {selectMode ? (
                                                <span className="absolute left-1 top-1">
                                                    <CheckMark checked={isChecked} theme={theme} />
                                                </span>
                                            ) : null}
                                            {node.metadata?.status && node.metadata.status !== "idle" ? <span className="absolute right-1 top-1 size-1.5 rounded-full" style={{ background: STATUS_COLOR[node.metadata.status] || "transparent" }} /> : null}
                                        </span>
                                        <span className="mt-1 block truncate text-xs font-medium leading-snug">{node.title || getNodeDefinition(node.type)?.title || t("canvas.node.untitled")}</span>
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="pt-16 text-center text-sm opacity-40">{t("canvas.sidePanel.noNodes")}</div>
                    )
                ) : treeRows.length ? (
                    <div className="space-y-1.5">
                        {treeRows.map(({ node, depth, hasChildren }) => {
                            const Icon = NODE_TYPE_ICON[node.type] || FileText;
                            const isImage = node.type === CanvasNodeType.Image && node.metadata?.content;
                            const isChecked = checked.has(node.id);
                            const active = selectMode ? isChecked : selectedNodeIds.has(node.id);
                            return (
                                <div
                                    key={node.id}
                                    data-node-item
                                    className={cn("group relative flex items-center rounded-lg transition", depth && "ml-5", active ? "" : "hover:bg-black/5 dark:hover:bg-white/5")}
                                    style={active ? { background: theme.toolbar.activeBg } : undefined}
                                    onMouseEnter={() => onHoverNode(node.id)}
                                    onMouseLeave={(event) => {
                                        const to = event.relatedTarget as Element | null;
                                        if (!to || !to.closest("[data-node-item]")) onHoverNode(null);
                                    }}
                                >
                                    {depth ? <span className="pointer-events-none absolute -left-3 top-[calc(-50%-0.4rem)] h-[calc(100%+0.4rem)] w-3 rounded-bl-md border-b border-l opacity-45" style={{ borderColor: theme.node.stroke }} /> : null}
                                    {node.type === CanvasNodeType.Group && hasChildren ? (
                                        <button type="button" onClick={() => setCollapsedGroups((prev) => (prev.has(node.id) ? new Set([...prev].filter((id) => id !== node.id)) : new Set(prev).add(node.id)))} className="ml-1 grid size-6 shrink-0 place-items-center opacity-55 transition hover:opacity-100" aria-label={node.title}>
                                            <ChevronRight className={cn("size-3.5 transition-transform", !collapsedGroups.has(node.id) && "rotate-90")} />
                                        </button>
                                    ) : null}
                                    <button type="button" onClick={() => (selectMode ? toggleChecked(node.id) : activateNode(node))} className={cn("flex min-w-0 flex-1 items-center gap-3 py-2 pr-2 text-left", node.type === CanvasNodeType.Group && hasChildren ? "pl-0" : "pl-2")} title={selectMode ? undefined : t("canvas.sidePanel.focusNode")}>
                                        {selectMode ? <CheckMark checked={isChecked} theme={theme} /> : null}
                                        <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md">
                                            {isImage ? <img src={previewUrlFor(node.metadata?.storageKey) || node.metadata?.content} alt={node.title} className="size-full object-cover" /> : <Icon className="size-5 opacity-60" />}
                                        </span>
                                        <span className="min-w-0 flex-1 space-y-0.5">
                                            <span className="block truncate text-sm font-medium leading-snug">{node.title || getNodeDefinition(node.type)?.title || t("canvas.node.untitled")}</span>
                                            <span className="block truncate text-xs leading-snug opacity-50">{nodePreviewText(node)}
<NodeTimelineSection node={node} theme={theme} /></span>
                                        </span>
                                        {node.metadata?.status && node.metadata.status !== "idle" ? <span className="size-1.5 shrink-0 rounded-full" style={{ background: STATUS_COLOR[node.metadata.status] || "transparent" }} /> : null}
                                    </button>
                                    {selectMode || !isImage ? null : (
                                        <div className="flex shrink-0 flex-col items-center gap-0.5 pr-1.5">
                                            <button type="button" onClick={() => onPreviewNode(node.id)} className="grid size-7 place-items-center rounded-md opacity-55 transition hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10" aria-label={t("canvas.sidePanel.preview")} title={t("canvas.sidePanel.preview")}>
                                                <Eye className="size-3.5" />
                                            </button>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div className="pt-16 text-center text-sm opacity-40">{t("canvas.sidePanel.noNodes")}</div>
                )}
            </div>
            {selectMode ? (
                <div className="flex items-center gap-2 border-t px-3 py-2.5" style={{ borderColor: theme.toolbar.border }}>
                    <button type="button" onClick={toggleAll} className="rounded-md px-2 py-1 text-xs font-medium opacity-70 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10">
                        {allChecked ? t("canvas.sidePanel.clearAll") : t("workbench.selectAll")}
                    </button>
                    <span className="text-xs opacity-45">{t("canvas.sidePanel.selected", { count: checked.size })}</span>
                    <button
                        type="button"
                        onClick={() => void handleExport()}
                        disabled={!checked.size || exporting}
                        className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/10"
                        style={{ color: theme.node.text }}
                    >
                        <Download className="size-3.5" />
                        {t("canvas.exportSelected")}
                    </button>
                </div>
            ) : null}
        </div>
    );
}


function formatTimelineTime(at: number) {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** M3: "What did the agent do" expandable timeline for one node in the side panel list. */
function NodeTimelineSection({ node, theme }: { node: CanvasNodeData; theme: CanvasTheme }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const timeline = node.metadata?.timeline || [];
    if (!timeline.length) return null;
    const latest = timeline[timeline.length - 1];
    return (
        <div className="mt-0.5 w-full min-w-0" onClick={(event) => event.stopPropagation()}>
            <div
                role="button"
                tabIndex={0}
                onClick={() => setOpen((value) => !value)}
                className="flex w-full cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] opacity-70 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
                style={{ color: theme.node.text }}
            >
                <History className="size-3 shrink-0" />
                <span className="min-w-0 truncate">
                    {t("canvas.sidePanel.timelineLatest", { action: t(`canvas.agentOps.${latest.kind}`, { defaultValue: latest.kind }), count: timeline.length })}
                </span>
                <ChevronDown className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")} />
            </div>
            {open ? (
                <ul className="mt-0.5 space-y-0.5 border-l pl-2 text-[11px] opacity-80" style={{ borderColor: theme.toolbar.activeBg }}>
                    {[...timeline].reverse().map((entry, index) => (
                        <li key={`${entry.at}-${index}`} className="flex items-baseline gap-1.5">
                            <span className="shrink-0 tabular-nums opacity-60">{formatTimelineTime(entry.at)}</span>
                            <span className="min-w-0 truncate" title={entry.detail || undefined}>
                                {t(`canvas.agentOps.${entry.kind}`, { defaultValue: entry.kind })}
                                {entry.detail ? ` · ${entry.detail}` : ""}
                            </span>
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}

function CheckMark({ checked, theme }: { checked: boolean; theme: CanvasTheme }) {
    return (
        <span className="grid size-4 shrink-0 place-items-center rounded border transition" style={{ borderColor: checked ? theme.toolbar.activeText : theme.node.stroke, background: checked ? theme.toolbar.activeText : "transparent" }}>
            {checked ? <Check className="size-3 text-white" /> : null}
        </span>
    );
}

// ---------------------------------------------------------------------------
// Assets tab: collapsible type groups, tag filtering, and click-to-insert.
// ---------------------------------------------------------------------------

const ASSET_GROUPS: { kind: AssetKind; icon: typeof Square }[] = [
    { kind: "image", icon: ImageIcon },
    { kind: "video", icon: Video },
    { kind: "text", icon: FileText },
];

function buildInsertPayload(asset: Asset): InsertAssetPayload {
    if (asset.kind === "text") return { kind: "text", content: asset.data.content, title: asset.title };
    if (asset.kind === "video") return { kind: "video", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height };
    return { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title };
}

const CanvasAssetsTab = memo(function CanvasAssetsTab({ onInsert, theme }: { onInsert: (payload: InsertAssetPayload) => void; theme: CanvasTheme }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const assets = useAssetStore((state) => state.assets);
    const addAsset = useAssetStore((state) => state.addAsset);
    const removeAsset = useAssetStore((state) => state.removeAsset);
    const [keyword, setKeyword] = useState("");
    const [tagFilter, setTagFilter] = useState<string>("all");
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const allTags = useMemo(() => Array.from(new Set(assets.flatMap((asset) => asset.tags || []))).slice(0, 20), [assets]);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets.filter((asset) => (tagFilter === "all" || (asset.tags || []).includes(tagFilter)) && (!query || [asset.title, ...(asset.tags || [])].join(" ").toLowerCase().includes(query)));
    }, [assets, keyword, tagFilter]);

    const groups = useMemo(() => ASSET_GROUPS.map((group) => ({ ...group, items: filtered.filter((asset) => asset.kind === group.kind) })).filter((group) => group.items.length > 0), [filtered]);

    const handleFiles = async (fileList: FileList | null) => {
        const files = Array.from(fileList || []);
        if (!files.length) return;
        setUploading(true);
        const hide = message.loading(t("canvas.sidePanel.addingAssets"), 0);
        let added = 0;
        try {
            for (const file of files) {
                if (file.type.startsWith("image/")) {
                    const image = await uploadImage(file);
                    addAsset({ kind: "image", title: file.name || t("assets.kinds.image"), coverUrl: image.url, tags: [], data: { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType } });
                    added += 1;
                } else if (file.type.startsWith("video/")) {
                    const media = await uploadMediaFile(file, "video");
                    addAsset({ kind: "video", title: file.name || t("assets.kinds.video"), coverUrl: "", tags: [], data: { url: media.url, storageKey: media.storageKey, width: media.width || 0, height: media.height || 0, bytes: media.bytes, mimeType: media.mimeType } });
                    added += 1;
                }
            }
            if (added) message.success(t("canvas.sidePanel.addedAssets", { count: added }));
            else message.warning(t("canvas.sidePanel.mediaOnly"));
        } catch (error) {
            console.error(error);
            message.error(t("canvas.sidePanel.addFailed"));
        } finally {
            hide();
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 px-3 pb-2 pt-1">
                <Input size="small" allowClear prefix={<Search className="size-3.5 text-stone-400" />} placeholder={t("canvas.sidePanel.searchAssets")} value={keyword} onChange={(e) => setKeyword(e.target.value)} />
                <button
                    type="button"
                    disabled={uploading}
                    onClick={() => fileInputRef.current?.click()}
                    className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/10"
                    style={{ color: theme.node.text }}
                >
                    <Plus className="size-3.5" />
                    {t("canvas.sidePanel.add")}
                </button>
                <input ref={fileInputRef} type="file" accept="image/*,video/*" multiple className="hidden" onChange={(e) => void handleFiles(e.target.files)} />
            </div>
            {allTags.length ? (
                <div className="flex flex-wrap gap-1.5 px-3 pb-2">
                    <Tag.CheckableTag checked={tagFilter === "all"} className={cn("prompt-filter-tag", tagFilter === "all" && "is-active")} onChange={() => setTagFilter("all")}>
                        {t("common.all")}
                    </Tag.CheckableTag>
                    {allTags.map((tag) => (
                        <Tag.CheckableTag key={tag} checked={tagFilter === tag} className={cn("prompt-filter-tag", tagFilter === tag && "is-active")} onChange={() => setTagFilter((prev) => (prev === tag ? "all" : tag))}>
                            {tag}
                        </Tag.CheckableTag>
                    ))}
                </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                {groups.length ? (
                    <div className="space-y-1">
                        {groups.map((group) => {
                            const isCollapsed = collapsed[group.kind];
                            return (
                                <div key={group.kind}>
                                    <button
                                        type="button"
                                        onClick={() => setCollapsed((prev) => ({ ...prev, [group.kind]: !prev[group.kind] }))}
                                        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-xs font-semibold opacity-75 transition hover:opacity-100"
                                    >
                                        <ChevronRight className={cn("size-3.5 transition-transform", !isCollapsed && "rotate-90")} />
                                        <group.icon className="size-3.5" />
                                        <span>{t(`assets.kinds.${group.kind}`)}</span>
                                        <span className="opacity-50">{group.items.length}</span>
                                    </button>
                                    {isCollapsed ? null : (
                                        <div className="grid grid-cols-2 gap-2 px-1 pb-2 pt-1">
                                            {group.items.map((asset) => (
                                                <AssetCard key={asset.id} asset={asset} theme={theme} onInsert={() => onInsert(buildInsertPayload(asset))} onRemove={() => (removeAsset(asset.id), message.success(t("canvas.sidePanel.assetRemoved")))} />
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.sidePanel.noAssets")} className="pt-16" />
                )}
            </div>
        </div>
    );
});

function AssetCard({ asset, theme, onInsert, onRemove }: { asset: Asset; theme: CanvasTheme; onInsert: () => void; onRemove: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="group relative aspect-square overflow-hidden rounded-xl border transition duration-200 hover:-translate-y-0.5 hover:shadow-lg" style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
            <AssetCover asset={asset} />
            <div className="absolute inset-0 flex items-center justify-center gap-2.5 opacity-0 transition duration-200 group-hover:opacity-100">
                <button
                    type="button"
                    onClick={onInsert}
                    className="grid size-8 place-items-center rounded-full bg-white/90 text-stone-700 shadow-sm backdrop-blur transition hover:bg-white hover:text-stone-900 dark:bg-black/60 dark:text-stone-100 dark:hover:bg-black/80"
                    aria-label={t("canvas.sidePanel.inserted")}
                >
                    <Plus className="size-4" />
                </button>
                <Popconfirm title={t("canvas.sidePanel.removeAssetTitle")} okText={t("canvas.sidePanel.remove")} cancelText={t("common.cancel")} okButtonProps={{ danger: true }} onConfirm={onRemove}>
                    <button
                        type="button"
                        className="grid size-8 place-items-center rounded-full bg-white/90 text-stone-700 shadow-sm backdrop-blur transition hover:bg-white hover:text-red-500 dark:bg-black/60 dark:text-stone-100 dark:hover:bg-black/80 dark:hover:text-red-400"
                        aria-label={t("canvas.sidePanel.removeAsset")}
                    >
                        <Trash2 className="size-4" />
                    </button>
                </Popconfirm>
            </div>
        </div>
    );
}

function AssetCover({ asset }: { asset: Asset }) {
    if (asset.kind === "text") return <div className="size-full overflow-hidden whitespace-pre-wrap break-words p-2.5 text-[11px] leading-snug opacity-80">{asset.data.content}</div>;
    if (asset.kind === "video") {
        if (asset.coverUrl) return <img src={asset.coverUrl} alt="" className="size-full object-cover transition duration-300 group-hover:scale-[1.04]" />;
        return <video src={`${asset.data.url}#t=0.1`} muted playsInline preload="metadata" className="size-full object-cover transition duration-300 group-hover:scale-[1.04]" />;
    }
    return <img src={asset.coverUrl || asset.data.dataUrl} alt="" className="size-full object-cover transition duration-300 group-hover:scale-[1.04]" />;
}

// ---------------------------------------------------------------------------
// Prompt library tab: collapsible source groups, lazy loading, and copy or text-node insertion actions.
// ---------------------------------------------------------------------------

const CanvasPromptsTab = memo(function CanvasPromptsTab({ onInsert, theme }: { onInsert: (payload: InsertAssetPayload) => void; theme: CanvasTheme }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const sources = usePromptSourceStore((state) => state.sources);
    const enabledSources = useMemo(() => sources.filter((source) => source.enabled), [sources]);
    const [keyword, setKeyword] = useState("");
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const [detail, setDetail] = useState<Prompt | null>(null);

    const copyPrompt = async (prompt: string) => {
        try {
            await navigator.clipboard.writeText(prompt);
            message.success(t("canvas.sidePanel.promptCopied"));
        } catch {
            message.error(t("canvas.sidePanel.copyFailed"));
        }
    };

    return (
        <div className="flex h-full flex-col">
            <div className="px-3 pb-2.5 pt-1">
                <Input size="small" allowClear prefix={<Search className="size-3.5 text-stone-400" />} placeholder={t("canvas.sidePanel.searchPrompts")} value={keyword} onChange={(e) => setKeyword(e.target.value)} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                <div className="space-y-1">
                    {enabledSources.length ? enabledSources.map((source) => (
                        <PromptSourceGroup
                            key={source.id}
                            sourceId={source.id}
                            sourceName={source.name}
                            keyword={keyword}
                            open={!!expanded[source.id]}
                            theme={theme}
                            onToggle={() => setExpanded((prev) => ({ ...prev, [source.id]: !prev[source.id] }))}
                            onInsert={onInsert}
                            onView={setDetail}
                        />
                    )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.sidePanel.noPrompts")} className="pt-12" />}
                </div>
            </div>
            <PromptDetailDialog prompt={detail} onClose={() => setDetail(null)} onCopy={(prompt) => void copyPrompt(prompt)} />
        </div>
    );
});

function PromptSourceGroup({
    sourceId,
    sourceName,
    keyword,
    open,
    theme,
    onToggle,
    onInsert,
    onView,
}: {
    sourceId: string;
    sourceName: string;
    keyword: string;
    open: boolean;
    theme: CanvasTheme;
    onToggle: () => void;
    onInsert: (payload: InsertAssetPayload) => void;
    onView: (prompt: Prompt) => void;
}) {
    const { t } = useTranslation();
    // Cache a source after its first expansion to avoid repeated requests; search results also need the data for counts.
    const showResults = open || !!keyword.trim();
    const query = useQuery({ queryKey: ["side-panel-prompts", sourceId], queryFn: () => fetchSourcePrompts(sourceId), enabled: showResults, staleTime: 1000 * 60 * 60 });

    const filtered = useMemo(() => {
        const items = query.data || [];
        const q = keyword.trim().toLowerCase();
        if (!q) return items;
        return items.filter((item) => [item.title, item.prompt, ...item.tags].join(" ").toLowerCase().includes(q));
    }, [query.data, keyword]);

    const insertPrompt = (item: Prompt) => onInsert({ kind: "text", content: item.prompt, title: item.title });

    return (
        <div>
            <button type="button" onClick={onToggle} className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-xs font-semibold opacity-75 transition hover:opacity-100">
                <ChevronRight className={cn("size-3.5 transition-transform", showResults && "rotate-90")} />
                <BookOpen className="size-3.5" />
                <span className="min-w-0 flex-1 truncate">{sourceName}</span>
                {showResults && query.isSuccess ? <span className="opacity-50">{filtered.length}</span> : null}
            </button>
            {showResults ? (
                <div className="px-1 pb-2 pt-1">
                    {query.isLoading ? (
                        <div className="flex justify-center py-6">
                            <Spin size="small" />
                        </div>
                    ) : query.isError ? (
                        <button type="button" onClick={() => void query.refetch()} className="block w-full py-4 text-center text-xs text-red-500 opacity-80 transition hover:opacity-100">
                            {t("canvas.sidePanel.loadFailedRetry")}
                        </button>
                    ) : filtered.length ? (
                        <div className="space-y-1.5">
                            {filtered.map((item) => (
                                <PromptRow key={item.id} item={item} theme={theme} onInsert={() => insertPrompt(item)} onView={() => onView(item)} />
                            ))}
                        </div>
                    ) : (
                        <div className="py-4 text-center text-xs opacity-40">{keyword.trim() ? t("canvas.sidePanel.noMatchingPrompts") : t("canvas.sidePanel.sourceEmpty")}</div>
                    )}
                </div>
            ) : null}
        </div>
    );
}

function PromptRow({ item, theme, onInsert, onView }: { item: Prompt; theme: CanvasTheme; onInsert: () => void; onView: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="group relative flex items-center gap-2.5 rounded-lg px-2 py-2 transition hover:bg-black/5 dark:hover:bg-white/5">
            {item.coverUrl ? (
                <img src={item.coverUrl} alt="" className="size-10 shrink-0 rounded-md object-cover" loading="lazy" />
            ) : (
                <span className="grid size-10 shrink-0 place-items-center rounded-md" style={{ background: theme.node.panel }}>
                    <FileText className="size-4 opacity-50" />
                </span>
            )}
            <button type="button" onClick={onView} className="min-w-0 flex-1 text-left">
                <div className="truncate text-sm font-medium leading-snug">{item.title}</div>
                <div className="mt-0.5 truncate text-xs leading-snug opacity-50">{item.prompt}</div>
            </button>
            <div className="flex shrink-0 flex-col items-center gap-0.5">
                <button type="button" onClick={onView} className="grid size-6 place-items-center rounded-md opacity-60 transition hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10" aria-label={t("canvas.sidePanel.viewDetails")} title={t("canvas.sidePanel.viewDetails")}>
                    <Eye className="size-3.5" />
                </button>
                <button
                    type="button"
                    onClick={onInsert}
                    className="grid size-6 place-items-center rounded-md opacity-60 transition hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
                    style={{ color: theme.toolbar.activeText }}
                    aria-label={t("canvas.sidePanel.inserted")}
                    title={t("canvas.sidePanel.inserted")}
                >
                    <Plus className="size-3.5" />
                </button>
            </div>
        </div>
    );
}
