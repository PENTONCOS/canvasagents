// "Edit this image in PS": the overlay that opens the embedded PS-mode editor for the image node the
// user clicked. Saving hands the exported bitmap back to the caller as a data URL; the caller writes
// it to that same node (see lib/canvas/canvas-node-ps-edit), so this dialog never creates a node.
// The iframe plumbing is the shared bridge hook, so a blocked/slow frame surfaces the same error and
// retry affordances as the standalone editor node.
import { useEffect, useState } from "react";
import { AlertCircle, Loader2, RefreshCw, Save } from "lucide-react";
import { Button, Modal, Space } from "antd";
import { useTranslation } from "react-i18next";

import { useEditorBridge } from "@/components/canvas/use-editor-bridge";
import { EDITOR_ENGINE_NAME, EDITOR_ENGINE_VERSION, EDITOR_IFRAME_SRC } from "@/lib/canvas/editor-bridge";

export function CanvasNodePsEditDialog({
    open,
    source,
    engineVersion,
    onSave,
    onClose,
}: {
    open: boolean;
    source: string;
    engineVersion?: string;
    onSave: (dataUrl: string) => void | Promise<void>;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const [saving, setSaving] = useState(false);
    const { iframeRef, reloadKey, status, error, notice, busy, handleFrameLoad, reload, openImage, exportImage } = useEditorBridge({
        source,
        onExport: async (dataUrl) => {
            setSaving(true);
            try {
                await onSave(dataUrl);
            } finally {
                setSaving(false);
            }
        },
    });

    // Once the frame answers the handshake, push the node's image in automatically: the user clicked
    // "edit in PS" on that image, so there is nothing else to pick. `openImage` is identity-stable
    // unless the source itself changes (see use-editor-bridge), so this runs once per ready frame and
    // never reloads the editor behind the user's back while they edit.
    useEffect(() => {
        if (!open || status !== "ready") return;
        void openImage();
    }, [open, status, openImage]);

    const version = engineVersion || EDITOR_ENGINE_VERSION;

    return (
        <Modal
            title={t("canvas.imageTools.psEdit")}
            open={open}
            centered
            width={1080}
            onCancel={onClose}
            destroyOnHidden
            footer={
                <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 flex-1 truncate text-left text-xs opacity-60">{status === "ready" ? t("canvas.editor.engine", { engine: EDITOR_ENGINE_NAME, version }) : t("canvas.editor.connecting")}</span>
                    <Space>
                        <Button icon={<RefreshCw className="size-4" />} onClick={reload}>
                            {t("canvas.editor.retry")}
                        </Button>
                        <Button onClick={onClose}>{t("common.close")}</Button>
                        <Button type="primary" icon={<Save className="size-4" />} loading={saving || busy} disabled={status !== "ready"} onClick={() => void exportImage()}>
                            {t("canvas.editor.saveBack")}
                        </Button>
                    </Space>
                </div>
            }
        >
            <div className="relative h-[min(68vh,640px)] min-h-[360px] overflow-hidden rounded-lg bg-stone-100 dark:bg-stone-950">
                <iframe key={reloadKey} ref={iframeRef} src={EDITOR_IFRAME_SRC} title={t("canvas.imageTools.psEdit")} onLoad={handleFrameLoad} className="h-full w-full border-0 bg-white" />

                {notice ? (
                    <div className="pointer-events-none absolute inset-x-2 bottom-2 rounded border border-stone-300 bg-white/90 px-2 py-1 text-[11px] text-stone-500 dark:border-stone-700 dark:bg-stone-900/90 dark:text-stone-400">{notice}</div>
                ) : null}

                {status === "connecting" && !error ? (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-white/70 text-xs text-stone-500 dark:bg-stone-900/70 dark:text-stone-400">
                        <Loader2 className="size-4 animate-spin" />
                        {t("canvas.editor.connecting")}
                    </div>
                ) : null}

                {status === "error" && error ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white/90 px-4 text-center dark:bg-stone-900/90">
                        <span className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-300">
                            <AlertCircle className="size-4 shrink-0" />
                            <span className="min-w-0 max-w-[520px] break-words" title={error}>
                                {error || t("canvas.editor.bridgeUnavailable")}
                            </span>
                        </span>
                        <Button size="small" icon={<RefreshCw className="size-3.5" />} onClick={reload}>
                            {t("canvas.editor.retry")}
                        </Button>
                    </div>
                ) : null}
            </div>
        </Modal>
    );
}
