// M6: repo node. Binds a repository registered with the canvas-agent /repos API and renders a
// compact summary (name, branch, dirty marker, last commit). The binding lives in node metadata
// (metadata.repo), the same way M5 keeps metadata.code; refreshing pulls /repo/status.
import { useCallback, useEffect, useState } from "react";

import { AlertCircle, FolderGit2, GitBranch, Loader2, RefreshCw, Unplug } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { baseName } from "@/lib/canvas/code-node-utils";
import { formatCommitSummary, isAbsoluteRepoPath, readRepoMetadata, repoDisplayName, repoMetadataPatch } from "@/lib/canvas/repo-node-utils";
import { createAgentRepo, fetchAgentRepoStatus, fetchAgentRepos, type AgentRepoSummary } from "@/services/api/canvas-agent";
import { useAgentStore } from "@/stores/use-agent-store";
import type { CanvasNodeContext, CanvasNodeDefinition } from "@/types/canvas-plugin";

export const REPO_NODE_TYPE = "repo";

const CONTROL_CLASS = "shrink-0 rounded border border-stone-300 bg-transparent px-1.5 py-1 text-[11px] text-stone-600 hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800";

type RepoStatus = "connecting" | "ready" | "error";

function errorMessage(cause: unknown) {
    return cause instanceof Error ? cause.message : String(cause);
}

function RepoNodeView({ ctx }: { ctx: CanvasNodeContext }) {
    const { t } = useTranslation();
    const agentUrl = useAgentStore((state) => state.url);
    const agentToken = useAgentStore((state) => state.token);
    const state = readRepoMetadata(ctx.node.metadata);
    const hasAgent = Boolean(agentUrl && agentToken);

    const [repos, setRepos] = useState<AgentRepoSummary[]>([]);
    const [reposStatus, setReposStatus] = useState<RepoStatus>("connecting");
    const [reposError, setReposError] = useState("");
    const [manualPath, setManualPath] = useState("");
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState("");
    const [statusBusy, setStatusBusy] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);

    const repoId = state.repoId;

    // Repo list backs the unbound picker.
    useEffect(() => {
        if (!hasAgent) {
            setRepos([]);
            setReposStatus("error");
            setReposError(i18n.t("canvas.repo.notConnected"));
            return;
        }
        let alive = true;
        setReposStatus("connecting");
        setReposError("");
        fetchAgentRepos(agentUrl, agentToken)
            .then((response) => {
                if (!alive) return;
                setRepos(response.repos || []);
                setReposStatus("ready");
            })
            .catch((cause) => {
                if (!alive) return;
                setRepos([]);
                setReposStatus("error");
                setReposError(errorMessage(cause));
            });
        return () => {
            alive = false;
        };
    }, [agentUrl, agentToken, hasAgent, refreshKey]);

    // Bound repos pull their summary (branch/dirty/last commit) from /repo/status.
    useEffect(() => {
        if (!hasAgent || !repoId) return;
        let alive = true;
        setStatusBusy(true);
        setNotice("");
        fetchAgentRepoStatus(agentUrl, agentToken, { repoId })
            .then((response) => {
                if (!alive) return;
                const current = readRepoMetadata(ctx.node.metadata);
                ctx.updateMetadata({
                    repo: repoMetadataPatch(current, {
                        repoId,
                        name: response.name || current.name,
                        path: response.path || current.path,
                        isGit: Boolean(response.isGit),
                        branch: response.branch || "",
                        dirty: Boolean(response.dirty),
                        lastCommit: formatCommitSummary(response.lastCommit) || current.lastCommit,
                    }),
                });
            })
            .catch((cause) => {
                if (alive) setNotice(errorMessage(cause));
            })
            .finally(() => {
                if (alive) setStatusBusy(false);
            });
        return () => {
            alive = false;
        };
        // ctx is intentionally excluded: metadata writes would otherwise retrigger this fetch loop.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agentUrl, agentToken, hasAgent, repoId, refreshKey]);

    const updateState = useCallback(
        (patch: Parameters<typeof repoMetadataPatch>[1]) => {
            ctx.updateMetadata({ repo: repoMetadataPatch(state, patch) });
        },
        [ctx, state],
    );

    const bindRepo = useCallback(
        (repo: { id: string; name?: string; path?: string; isGit?: boolean; branch?: string }) => {
            setNotice("");
            setManualPath("");
            updateState({ repoId: repo.id, name: repo.name || baseName(repo.path || ""), path: repo.path || "", isGit: Boolean(repo.isGit), branch: repo.branch || "" });
        },
        [updateState],
    );

    const unbindRepo = useCallback(() => {
        setNotice("");
        updateState({ repoId: "", name: "", path: "", isGit: false, branch: "", dirty: false, lastCommit: "" });
    }, [updateState]);

    const submitManualRepo = useCallback(async () => {
        const path = manualPath.trim();
        if (!isAbsoluteRepoPath(path)) {
            setNotice(i18n.t("canvas.repo.absolutePathRequired"));
            return;
        }
        if (!hasAgent) {
            setNotice(i18n.t("canvas.repo.notConnected"));
            return;
        }
        setBusy(true);
        setNotice("");
        try {
            const response = await createAgentRepo(agentUrl, agentToken, { path });
            const repo = response.repo;
            if (!repo) throw new Error(i18n.t("canvas.repo.registerFailed"));
            setRepos((prev) => (prev.some((item) => item.id === repo.id) ? prev : [...prev, repo]));
            bindRepo(repo);
        } catch (cause) {
            setNotice(errorMessage(cause));
        } finally {
            setBusy(false);
        }
    }, [agentToken, agentUrl, bindRepo, hasAgent, manualPath]);

    const displayName = repoDisplayName(state);

    return (
        <div className="flex h-full w-full flex-col overflow-hidden bg-white text-stone-700 dark:bg-stone-900 dark:text-stone-200">
            <div className="flex shrink-0 items-center gap-1.5 border-b border-stone-200 px-2 py-1.5 dark:border-stone-800">
                <FolderGit2 className="size-3.5 shrink-0 text-stone-500 dark:text-stone-400" />
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{repoId ? displayName : t("canvas.repo.bindTitle")}</span>
                {statusBusy ? <Loader2 className="size-3 animate-spin text-stone-400" /> : null}
                {repoId ? (
                    <>
                        <button type="button" onClick={() => setRefreshKey((value) => value + 1)} title={t("canvas.repo.refresh")} className={CONTROL_CLASS}>
                            <RefreshCw className="size-3.5" />
                        </button>
                        <button type="button" onClick={unbindRepo} title={t("canvas.repo.switchRepo")} className={`${CONTROL_CLASS} flex items-center gap-1`}>
                            <Unplug className="size-3.5" />
                        </button>
                    </>
                ) : null}
            </div>

            {!repoId ? (
                <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
                    <div className="w-full max-w-sm space-y-2">
                        <select
                            value=""
                            onChange={(event) => {
                                const repo = repos.find((item) => item.id === event.target.value);
                                if (repo) bindRepo(repo);
                            }}
                            disabled={reposStatus !== "ready" || !repos.length}
                            className={`${CONTROL_CLASS} w-full`}
                        >
                            <option value="">{reposStatus === "connecting" ? t("canvas.repo.loadingRepos") : t("canvas.repo.selectRepo")}</option>
                            {repos.map((repo) => (
                                <option key={repo.id} value={repo.id}>
                                    {repo.name} · {repo.path}
                                </option>
                            ))}
                        </select>
                        <div className="flex items-center gap-1.5">
                            <input
                                value={manualPath}
                                onChange={(event) => setManualPath(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") void submitManualRepo();
                                }}
                                placeholder={t("canvas.repo.manualPathPlaceholder")}
                                className="min-w-0 flex-1 rounded border border-stone-300 bg-transparent px-1.5 py-1 text-[11px] outline-none dark:border-stone-700"
                            />
                            <button type="button" onClick={() => void submitManualRepo()} disabled={busy || !hasAgent} className={CONTROL_CLASS}>
                                {busy ? t("canvas.repo.registering") : t("canvas.repo.register")}
                            </button>
                        </div>
                        {notice ? <div className="text-[11px] text-red-500">{notice}</div> : null}
                        {reposError ? <div className="text-[11px] text-red-500">{reposError}</div> : null}
                    </div>
                </div>
            ) : (
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
                    <div className="flex items-center gap-1.5">
                        <span className="min-w-0 truncate text-sm font-semibold">{displayName}</span>
                        <span
                            className="size-2 shrink-0 rounded-full"
                            title={state.dirty ? t("canvas.repo.dirty") : t("canvas.repo.clean")}
                            style={{ background: state.dirty ? "#f97316" : "#22c55e" }}
                        />
                        {state.branch ? (
                            <span className="flex shrink-0 items-center gap-0.5 rounded bg-stone-100 px-1 py-0.5 text-[10px] text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                                <GitBranch className="size-3" />
                                {state.branch}
                            </span>
                        ) : null}
                    </div>
                    <div className="truncate text-[11px] text-stone-400 dark:text-stone-500" title={state.path}>
                        {state.path || repoId}
                    </div>
                    <div className="truncate text-[11px]" title={state.lastCommit}>
                        {state.lastCommit || t("canvas.repo.noCommit")}
                    </div>
                    {notice ? (
                        <div className="flex items-center gap-1 text-[11px] text-red-500">
                            <AlertCircle className="size-3.5 shrink-0" />
                            <span className="truncate" title={notice}>
                                {notice}
                            </span>
                        </div>
                    ) : null}
                </div>
            )}
        </div>
    );
}

export function repoNodeDefinition(): CanvasNodeDefinition {
    return {
        type: REPO_NODE_TYPE,
        title: i18n.t("canvas.nodeTypes.repo"),
        icon: <FolderGit2 className="size-4" />,
        description: i18n.t("canvas.repo.description"),
        minimapColor: "#14b8a6",
        defaultSize: { width: 340, height: 220 },
        defaultMetadata: { repo: {} },
        hidePanel: true,
        Content: ({ ctx }) => <RepoNodeView ctx={ctx} />,
    };
}

let registered = false;
export function registerRepoNode() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions([repoNodeDefinition()], "builtin");
}
