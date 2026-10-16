// M6: pipeline stage badge. Renders a colored pill in the node header when metadata.stage is set,
// giving the requirement -> design -> code -> service -> test -> runtime pipeline a visual anchor.
import { useTranslation } from "react-i18next";

import { normalizeStage, stageColor, stageLabelKey } from "@/lib/canvas/canvas-stage-utils";

export function CanvasNodeStageBadge({ stage }: { stage: unknown }) {
    const { t } = useTranslation();
    const normalized = normalizeStage(stage);
    const labelKey = stageLabelKey(stage);
    if (!normalized || !labelKey) return null;
    const color = stageColor(normalized);
    return (
        <span
            className="pointer-events-none absolute left-2 top-2 z-[55] rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-4 shadow-sm"
            style={{ background: color, color: "#ffffff" }}
            data-canvas-node-stage={normalized}
        >
            {t(labelKey)}
        </span>
    );
}
