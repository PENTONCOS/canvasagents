// Shared parse orchestration for the image structure layer (M7). Drives one canvas node's
// metadata.regions: runs /image/parse through the agent bridge and writes region edits back.
// The pure logic lives in image-regions-utils.ts and the bridge payload in image-regions-source.ts,
// so this hook only owns async state plus the metadata round trip.
import { useCallback, useRef, useState } from "react";

import i18n from "@/i18n";
import { normalizeRegions, patchRegion, regionsToExport } from "@/lib/canvas/image-regions-utils";
import { buildParseBody } from "@/lib/canvas/image-regions-source";
import { parseImageRegions } from "@/services/api/canvas-agent";
import { useAgentStore } from "@/stores/use-agent-store";
import type { CanvasImageRegion, CanvasNodeRegionsMetadata } from "@/types/canvas";
import type { CanvasNodeContext } from "@/types/canvas-plugin";

export type ImageRegionsStatus = "idle" | "parsing" | "ready" | "error";

function errorMessage(cause: unknown) {
    return cause instanceof Error ? cause.message : String(cause);
}

// `ctx` may be null when the canvas has no plugin host; the hook stays callable and inert then.
export function useImageRegions(ctx: CanvasNodeContext | null, source: string) {
    const agentUrl = useAgentStore((state) => state.url);
    const agentToken = useAgentStore((state) => state.token);
    const hasAgent = Boolean(agentUrl && agentToken);

    const meta = ctx?.node.metadata?.regions;
    const regions = meta?.regions ?? [];
    const selectedId = meta?.selectedRegionId ?? "";

    const [status, setStatus] = useState<ImageRegionsStatus>(regions.length ? "ready" : "idle");
    const [error, setError] = useState("");
    const [elapsedMs, setElapsedMs] = useState<number | null>(null);

    const metaRef = useRef(meta);
    metaRef.current = meta;

    const write = useCallback(
        (next: CanvasNodeRegionsMetadata) => {
            ctx?.updateMetadata({ regions: next });
        },
        [ctx],
    );

    const select = useCallback(
        (regionId: string) => {
            const base = metaRef.current ?? {};
            write({ ...base, selectedRegionId: regionId || undefined });
        },
        [write],
    );

    const update = useCallback(
        (regionId: string, patch: Partial<CanvasImageRegion>) => {
            write(patchRegion(metaRef.current, regionId, patch));
        },
        [write],
    );

    const parse = useCallback(async () => {
        if (!source) {
            setStatus("error");
            setError(i18n.t("canvas.regions.noSource"));
            return;
        }
        if (!hasAgent) {
            setStatus("error");
            setError(i18n.t("canvas.regions.notConnected"));
            return;
        }
        setStatus("parsing");
        setError("");
        const startedAt = Date.now();
        try {
            const body = await buildParseBody(source);
            const response = await parseImageRegions(agentUrl, agentToken, body);
            const parsed = normalizeRegions(response, response.width, response.height);
            const width = response.width && response.width > 0 ? Math.round(response.width) : 0;
            const height = response.height && response.height > 0 ? Math.round(response.height) : 0;
            write({ source, width, height, engine: response.engine || "", parsedAt: Date.now(), regions: parsed, selectedRegionId: undefined });
            setElapsedMs(Date.now() - startedAt);
            setStatus("ready");
        } catch (cause) {
            setStatus("error");
            setError(errorMessage(cause));
        }
    }, [agentToken, agentUrl, hasAgent, source, write]);

    const exportJson = useCallback(() => regionsToExport(metaRef.current), []);

    return { meta, regions, selectedId, status, error, elapsedMs, hasAgent, canParse: Boolean(source), parse, select, update, exportJson };
}
