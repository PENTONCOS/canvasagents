// M6: pure helpers for the repo node. Reuses the code node's path rules so "absolute path"
// means the same thing in both nodes, and keeps metadata normalization testable off-DOM.
import type { CanvasNodeRepoMetadata } from "@/types/canvas";
import { baseName, isAbsoluteRepoPath } from "@/lib/canvas/code-node-utils";

export { isAbsoluteRepoPath };

// Normalized repo binding read from node metadata; every field has a safe default.
export type RepoNodeState = {
    repoId: string;
    name: string;
    path: string;
    isGit: boolean;
    branch: string;
    dirty: boolean;
    lastCommit: string;
};

function normalizeText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

export function readRepoMetadata(metadata?: { repo?: CanvasNodeRepoMetadata } | null): RepoNodeState {
    const repo = metadata?.repo;
    return {
        repoId: normalizeText(repo?.repoId),
        name: normalizeText(repo?.name),
        path: normalizeText(repo?.path),
        isGit: Boolean(repo?.isGit),
        branch: normalizeText(repo?.branch),
        dirty: Boolean(repo?.dirty),
        lastCommit: normalizeText(repo?.lastCommit),
    };
}

// Builds metadata.repo written back through ctx.updateMetadata. Empty strings become undefined
// so an unbound node round-trips without leaking "" into the serialized canvas.
export function repoMetadataPatch(current: RepoNodeState, patch: Partial<RepoNodeState> = {}): CanvasNodeRepoMetadata {
    const next: RepoNodeState = { ...current, ...patch };
    return {
        repoId: next.repoId || undefined,
        name: next.name || undefined,
        path: next.path || undefined,
        isGit: next.isGit || undefined,
        branch: next.branch || undefined,
        dirty: next.dirty || undefined,
        lastCommit: next.lastCommit || undefined,
    };
}

// Display name: the registered name wins, otherwise the last path segment, otherwise the id.
export function repoDisplayName(state: Pick<RepoNodeState, "name" | "path" | "repoId">): string {
    return normalizeText(state.name) || baseName(state.path) || normalizeText(state.repoId);
}

// Compacts an agent /repo/status lastCommit object into the single string the node stores.
export function formatCommitSummary(commit?: { sha?: string; subject?: string } | null): string {
    const sha = normalizeText(commit?.sha);
    const subject = normalizeText(commit?.subject);
    if (!sha) return subject;
    return `${sha.slice(0, 7)}${subject ? ` ${subject}` : ""}`;
}
