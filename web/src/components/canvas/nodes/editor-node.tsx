// Phase 3: professional PS-mode editor node. Embeds the self-hosted miniPaint build in a
// same-origin iframe and talks to a small script injected into that frame via postMessage
// (see lib/canvas/editor-bridge). Opening loads metadata.content into the editor; saving pulls the
// edited canvas back out as an artifact (node content / image data URL) while keeping any existing
// structure layer (metadata.regions) intact.
import { AlertCircle, Hand, ImagePlus, Loader2, Move, PenTool, RefreshCw, Save } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { useEditorBridge } from "@/components/canvas/use-editor-bridge";
import { EDITOR_ENGINE_NAME, EDITOR_ENGINE_VERSION, EDITOR_IFRAME_SRC, buildEditorSavePatch } from "@/lib/canvas/editor-bridge";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import type { CanvasNodeContext, CanvasNodeDefinition } from "@/types/canvas-plugin";

export const EDITOR_NODE_TYPE = "editor";

const STATUS_CLASS = "shrink-0 rounded border border-stone-300 bg-transparent px-1.5 py-1 text-[11px] text-stone-600 hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800";

function EditorView({ ctx }: { ctx: CanvasNodeContext }) {
    const { t } = useTranslation();
    // The interaction toggle gates iframe pointer events so canvas drag/zoom still works.
    const interactive = Boolean(ctx.node.metadata?.interactive);
    const source = ctx.node.metadata?.content || "";
    const engineVersion = ctx.node.metadata?.editor?.version || EDITOR_ENGINE_VERSION;
    // Artifact (node content) + structure (regions kept, parse timestamp bumped).
    const { iframeRef, reloadKey, status, error, notice, busy, handleFrameLoad, reload, openImage, exportImage } = useEditorBridge({
        source,
        onExport: (dataUrl, savedAt) => ctx.updateMetadata(buildEditorSavePatch(ctx.node.metadata, dataUrl, savedAt)),
    });

    const statusText = status === "ready" ? "" : status === "connecting" ? t("canvas.editor.connecting") : "";

    return (
        <div className="flex h-full w-full flex-col overflow-hidden bg-white text-stone-700 dark:bg-stone-900 dark:text-stone-200">
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-stone-200 px-2 py-1.5 dark:border-stone-800">
                <PenTool className="size-3.5 shrink-0 text-stone-500 dark:text-stone-400" />
                <span className="shrink-0 rounded bg-stone-100 px-1 py-0.5 text-[10px] text-stone-600 dark:bg-stone-800 dark:text-stone-300" title={t("canvas.editor.engine", { engine: EDITOR_ENGINE_NAME, version: engineVersion })}>
                    {t("canvas.editor.engine", { engine: EDITOR_ENGINE_NAME, version: engineVersion })}
                </span>
                {statusText ? (
                    <span className="flex shrink-0 items-center gap-1 text-[10px] text-stone-500 dark:text-stone-400">
                        <Loader2 className="size-3 animate-spin" />
                        {statusText}
                    </span>
                ) : null}
                <span className="min-w-0 flex-1" />
                <button type="button" onClick={() => void openImage()} disabled={busy || status !== "ready"} title={t("canvas.editor.openImage")} className={`${STATUS_CLASS} flex items-center gap-1`}>
                    <ImagePlus className="size-3.5" />
                    {t("canvas.editor.openImage")}
                </button>
                <button type="button" onClick={() => void exportImage()} disabled={busy || status !== "ready"} title={t("canvas.editor.saveBack")} className={`${STATUS_CLASS} flex items-center gap-1`}>
                    <Save className="size-3.5" />
                    {t("canvas.editor.saveBack")}
                </button>
                <button type="button" onClick={reload} title={t("canvas.editor.retry")} className={STATUS_CLASS}>
                    <RefreshCw className="size-3.5" />
                </button>
            </div>

            {notice ? <div className="shrink-0 border-b border-stone-200 px-2 py-1 text-[11px] text-stone-500 dark:border-stone-800 dark:text-stone-400">{notice}</div> : null}

            <div className="relative min-h-0 flex-1 bg-stone-100 dark:bg-stone-950">
                <iframe
                    key={reloadKey}
                    ref={iframeRef}
                    src={EDITOR_IFRAME_SRC}
                    title={t("canvas.nodeTypes.editor")}
                    onLoad={handleFrameLoad}
                    className="h-full w-full border-0 bg-white"
                    style={{ pointerEvents: interactive ? "auto" : "none" }}
                />

                {!source ? (
                    <div className="pointer-events-none absolute inset-x-2 top-2 flex items-center gap-1.5 rounded border border-stone-300 bg-white/85 px-2 py-1 text-[11px] text-stone-500 dark:border-stone-700 dark:bg-stone-900/85 dark:text-stone-400">
                        <ImagePlus className="size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{t("canvas.editor.empty")}</span>
                    </div>
                ) : null}

                {status === "error" && error ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/90 px-4 text-center dark:bg-stone-900/90">
                        <span className="flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-300">
                            <AlertCircle className="size-3.5 shrink-0" />
                            <span className="min-w-0 truncate" title={error}>
                                {error || t("canvas.editor.bridgeUnavailable")}
                            </span>
                        </span>
                        <button type="button" onClick={reload} className={`${STATUS_CLASS} flex items-center gap-1`}>
                            <RefreshCw className="size-3.5" />
                            {t("canvas.editor.retry")}
                        </button>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

export function editorNodeDefinition(): CanvasNodeDefinition {
    return {
        type: EDITOR_NODE_TYPE,
        title: i18n.t("canvas.nodeTypes.editor"),
        icon: <PenTool className="size-4" />,
        description: i18n.t("canvas.editor.description"),
        minimapColor: "#7c3aed",
        defaultSize: { width: 900, height: 620 },
        defaultMetadata: { editor: { engine: EDITOR_ENGINE_NAME, version: EDITOR_ENGINE_VERSION } },
        hidePanel: true,
        // The host's interaction toggle keys off metadata.content; the editor gates its own iframe
        // pointer events through metadata.interactive so the node stays draggable when idle.
        interactionToggle: true,
        toolbar: (ctx) => {
            const interactive = Boolean(ctx.node.metadata?.interactive);
            return [
                {
                    id: "editor-interaction-toggle",
                    title: i18n.t(interactive ? "canvas.plugins.interactiveTitle" : "canvas.plugins.movableTitle"),
                    label: i18n.t(interactive ? "canvas.plugins.move" : "canvas.plugins.interact"),
                    icon: interactive ? <Move className="size-3.5" /> : <Hand className="size-3.5" />,
                    active: interactive,
                    onClick: () => ctx.updateMetadata({ interactive: !interactive }),
                },
            ];
        },
        Content: ({ ctx }) => <EditorView ctx={ctx} />,
    };
}

let registered = false;
export function registerEditorNode() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions([editorNodeDefinition()], "builtin");
}
