// M6: edge inspector. Selecting an edge opens this right-hand panel so its semantics (type,
// label, http/db contract) can be edited. Writes go straight back into the canvas connection
// state through `onChange`, matching how node metadata is updated.
import { useEffect, useState } from "react";

import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CANVAS_EDGE_TYPES, edgeConnectionPatch, edgeTypeLabelKey, readEdgeConnection, type EdgeContract, type EdgeView } from "@/lib/canvas/canvas-edge-utils";
import type { CanvasConnection, CanvasEdgeType } from "@/types/canvas";

type Props = {
    connection: CanvasConnection;
    fromTitle: string;
    toTitle: string;
    onChange: (patch: Pick<CanvasConnection, "type" | "label" | "metadata">) => void;
    onClose: () => void;
};

const FIELD_CLASS = "w-full rounded border border-stone-300 bg-transparent px-1.5 py-1 text-[11px] outline-none focus:border-stone-400 dark:border-stone-700";

export function CanvasConnectionPanel({ connection, fromTitle, toTitle, onChange, onClose }: Props) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<EdgeView>(() => readEdgeConnection(connection));

    // Resync only when a different edge is selected; per-keystroke writes must not clobber the draft.
    useEffect(() => {
        setDraft(readEdgeConnection(connection));
    }, [connection.id]);

    const commit = (next: EdgeView) => {
        setDraft(next);
        onChange(edgeConnectionPatch(next));
    };

    const updateContract = (patch: Partial<EdgeContract>) => {
        commit({ ...draft, contract: { ...draft.contract, ...patch } });
    };

    const contractFields: { key: keyof EdgeContract; labelKey: string }[] = [
        { key: "method", labelKey: "canvas.edge.method" },
        { key: "path", labelKey: "canvas.edge.path" },
        { key: "request", labelKey: "canvas.edge.request" },
        { key: "response", labelKey: "canvas.edge.response" },
        { key: "notes", labelKey: "canvas.edge.notes" },
    ];

    return (
        <div
            className="absolute right-4 top-20 z-[85] w-[300px] overflow-hidden rounded-xl border bg-white text-stone-700 shadow-xl dark:bg-stone-900 dark:text-stone-200"
            style={{ borderColor: "rgba(120,120,120,.28)" }}
            data-canvas-no-zoom
        >
            <div className="flex items-center gap-2 border-b border-stone-200 px-3 py-2 dark:border-stone-800">
                <span className="min-w-0 flex-1 truncate text-xs font-semibold" title={`${fromTitle} → ${toTitle}`}>
                    {t("canvas.edge.title")}
                </span>
                <button type="button" onClick={onClose} title={t("canvas.edge.close")} className="shrink-0 rounded p-0.5 text-stone-500 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800">
                    <X className="size-3.5" />
                </button>
            </div>
            <div className="space-y-2 px-3 py-2">
                <div className="truncate text-[10px] text-stone-400 dark:text-stone-500" title={`${fromTitle} → ${toTitle}`}>
                    {fromTitle} → {toTitle}
                </div>
                <label className="block space-y-1">
                    <span className="block text-[10px] text-stone-500 dark:text-stone-400">{t("canvas.edge.type")}</span>
                    <select
                        value={draft.type}
                        onChange={(event) => commit({ ...draft, type: event.target.value as CanvasEdgeType })}
                        className={FIELD_CLASS}
                    >
                        {CANVAS_EDGE_TYPES.map((type) => (
                            <option key={type} value={type}>
                                {t(edgeTypeLabelKey(type))}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="block space-y-1">
                    <span className="block text-[10px] text-stone-500 dark:text-stone-400">{t("canvas.edge.label")}</span>
                    <input
                        value={draft.label}
                        onChange={(event) => commit({ ...draft, label: event.target.value })}
                        placeholder={t("canvas.edge.labelPlaceholder")}
                        className={FIELD_CLASS}
                    />
                </label>
                <div className="pt-1 text-[10px] font-medium text-stone-500 dark:text-stone-400">{t("canvas.edge.contract")}</div>
                {contractFields.map((field) => (
                    <label key={field.key} className="block space-y-1">
                        <span className="block text-[10px] text-stone-500 dark:text-stone-400">{t(field.labelKey)}</span>
                        {field.key === "request" || field.key === "response" || field.key === "notes" ? (
                            <textarea
                                value={draft.contract[field.key]}
                                onChange={(event) => updateContract({ [field.key]: event.target.value })}
                                rows={2}
                                className={`${FIELD_CLASS} resize-none`}
                            />
                        ) : (
                            <input value={draft.contract[field.key]} onChange={(event) => updateContract({ [field.key]: event.target.value })} className={FIELD_CLASS} />
                        )}
                    </label>
                ))}
            </div>
        </div>
    );
}
