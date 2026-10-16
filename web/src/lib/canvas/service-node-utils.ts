// M6: pure helpers for the service node. The health URL builder and port normalization are the
// testable core; the probe itself lives in the node component (browser fetch).
import type { CanvasNodeServiceMetadata, CanvasNodeServiceStatus } from "@/types/canvas";

export const SERVICE_PROBE_TIMEOUT_MS = 3000;
export const SERVICE_DEFAULT_HEALTH_PATH = "/";

export const SERVICE_STATUSES: CanvasNodeServiceStatus[] = ["probing", "ready", "failed"];

// Normalized service binding read from node metadata; `port` is null when absent or invalid.
export type ServiceNodeState = {
    name: string;
    port: number | null;
    healthPath: string;
    status: CanvasNodeServiceStatus;
};

function normalizeText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

// Accepts an integer in 1..65535, either as a number or a numeric string; anything else is null.
export function normalizePort(value: unknown): number | null {
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
    return parsed;
}

export function readServiceMetadata(metadata?: { service?: CanvasNodeServiceMetadata } | null): ServiceNodeState {
    const service = metadata?.service;
    const status = service?.status && SERVICE_STATUSES.includes(service.status) ? service.status : "probing";
    return {
        name: normalizeText(service?.name),
        port: normalizePort(service?.port),
        healthPath: normalizeText(service?.healthPath),
        status,
    };
}

// Builds metadata.service written back through ctx.updateMetadata, dropping empties.
export function serviceMetadataPatch(current: ServiceNodeState, patch: Partial<ServiceNodeState> = {}): CanvasNodeServiceMetadata {
    const next: ServiceNodeState = { ...current, ...patch };
    return {
        name: next.name || undefined,
        port: normalizePort(next.port) ?? undefined,
        healthPath: next.healthPath || undefined,
        status: SERVICE_STATUSES.includes(next.status) ? next.status : undefined,
    };
}

// Probe target on the loopback interface; the health path is normalized to a leading slash and
// defaults to "/" so a node with only a port is still probeable. No port -> no URL.
export function buildHealthUrl(port: number | null | undefined, healthPath?: string): string {
    const normalizedPort = normalizePort(port);
    if (normalizedPort == null) return "";
    const rawPath = normalizeText(healthPath) || SERVICE_DEFAULT_HEALTH_PATH;
    const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    return `http://127.0.0.1:${normalizedPort}${path}`;
}
