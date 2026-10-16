// M5: code browser node. Binds a repository registered with the canvas-agent /repos API and
// renders a lazy file tree plus read-only file and unified-diff views. The binding lives in
// node metadata (metadata.code), the same way M2 keeps terminalSession and M4 keeps preview.
// Scope is deliberately read-only: no editing, no saving, no agent writes.
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";
import CodeMirror from "@uiw/react-codemirror";
import { AlertCircle, ChevronDown, ChevronRight, FileCode, Folder, FolderGit2, FolderOpen, GitBranch, GitCompare, Loader2, RefreshCw, Unplug } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import {
    CODE_ROOT_PATH,
    baseName,
    codeMetadataPatch,
    detectLanguageName,
    diffStats,
    formatBytes,
    isAbsoluteRepoPath,
    mergeTreeEntries,
    parseUnifiedDiff,
    readCodeMetadata,
    repoRelativePath,
    scopeTreeEntries,
    type CodeDiffLineKind,
    type CodeRepoSummary,
    type CodeTreeEntry,
    type CodeViewState,
} from "@/lib/canvas/code-node-utils";import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { createAgentRepo, fetchAgentRepoDiff, fetchAgentRepoFile, fetchAgentRepos, fetchAgentRepoTree } from "@/services/api/canvas-agent";
import { useAgentStore } from "@/stores/use-agent-store";
import type { CanvasNodeCodeView } from "@/types/canvas";
import type { CanvasNodeContext, CanvasNodeDefinition } from "@/types/canvas-plugin";

export const CODE_NODE_TYPE = "code";

const TREE_REQUEST_DEPTH = 1;
const CONTROL_CLASS = "shrink-0 rounded border border-stone-300 bg-transparent px-1.5 py-1 text-[11px] text-stone-600 hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800";

type CodeStatus = "connecting" | "ready" | "error";
type CodeFileState = { path: string; content: string; size?: number; truncated?: boolean };

function isDarkMode() {
    return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

function errorMessage(cause: unknown) {
    return cause instanceof Error ? cause.message : String(cause);
}

// The agent owns path semantics; the node only normalizes separators so tree keys stay stable.
function statusColor(status: CodeStatus) {
    if (status === "ready") return "#22c55e";
    if (status === "error") return "#ef4444";
    return "#a8a29e";
}

function statusLabelKey(status: CodeStatus) {
    if (status === "ready") return "canvas.code.statusReady";
    if (status === "error") return "canvas.code.statusError";
    return "canvas.code.statusConnecting";
}

function diffLineClass(kind: CodeDiffLineKind) {
    if (kind === "add") return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    if (kind === "del") return "bg-red-500/10 text-red-700 dark:text-red-300";
    if (kind === "hunk") return "bg-sky-500/10 text-sky-700 dark:text-sky-300";
    if (kind === "meta") return "text-stone-400 dark:text-stone-500";
    return "text-stone-700 dark:text-stone-200";
}

type TreeLevelProps = {
    dir: string;
    depth: number;
    treeByDir: Record<string, CodeTreeEntry[]>;
    expanded: string[];
    loadingDirs: string[];
    activePath: string;
    emptyLabel: string;
    onToggleDir: (dir: string) => void;
    onOpenFile: (path: string) => void;
};

// Renders one directory level; expanded directories render their children recursively so the
// tree reflects the agent's lazy depth-1 responses without pre-fetching the whole repository.
function CodeTreeLevel({ dir, depth, treeByDir, expanded, loadingDirs, activePath, emptyLabel, onToggleDir, onOpenFile }: TreeLevelProps) {
    const entries = treeByDir[dir] || [];
    if (!entries.length) {
        if (depth > 0) return null;
        return <div className="px-3 py-2 text-[11px] text-stone-400 dark:text-stone-500">{emptyLabel}</div>;
    }
    return (
        <div>
            {entries.map((entry) => {
                const isDir = entry.type === "dir";
                const isOpen = expanded.includes(entry.path);
                const isActive = !isDir && entry.path === activePath;
                const isLoading = loadingDirs.includes(entry.path);
                return (
                    <Fragment key={entry.path}>
                        <button
                            type="button"
                            onClick={() => (isDir ? onToggleDir(entry.path) : onOpenFile(entry.path))}
                            title={entry.path}
                            style={{ paddingLeft: 6 + depth * 12 }}
                            className={`flex w-full items-center gap-1 py-[3px] pr-2 text-left text-[11px] leading-4 hover:bg-stone-100 dark:hover:bg-stone-800 ${isActive ? "bg-sky-500/10 text-sky-700 dark:text-sky-300" : "text-stone-700 dark:text-stone-200"}`}
                        >
                            {isDir ? isOpen ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" /> : <span className="size-3 shrink-0" />}
                            {isDir ? <Folder className="size-3.5 shrink-0 text-amber-500 dark:text-amber-400" /> : <FileCode className="size-3.5 shrink-0 text-stone-400 dark:text-stone-500" />}
                            <span className="truncate">{entry.name}</span>
                            {isLoading ? <Loader2 className="size-3 shrink-0 animate-spin text-stone-400" /> : null}
                        </button>
                        {isDir && isOpen ? (
                            <CodeTreeLevel
                                dir={entry.path}
                                depth={depth + 1}
                                treeByDir={treeByDir}
                                expanded={expanded}
                                loadingDirs={loadingDirs}
                                activePath={activePath}
                                emptyLabel={emptyLabel}
                                onToggleDir={onToggleDir}
                                onOpenFile={onOpenFile}
                            />
                        ) : null}
                    </Fragment>
                );
            })}
        </div>
    );
}

function Placeholder({ children }: { children: ReactNode }) {
    return <div className="flex h-full w-full items-center justify-center px-4 py-3 text-center text-[11px] text-stone-400 dark:text-stone-500">{children}</div>;
}

function CodeBrowserView({ ctx }: { ctx: CanvasNodeContext }) {
    const { t } = useTranslation();
    const agentUrl = useAgentStore((state) => state.url);
    const agentToken = useAgentStore((state) => state.token);

    const state = readCodeMetadata(ctx.node.metadata);
    const { repoId, activePath, view } = state;
    const hasAgent = Boolean(agentUrl && agentToken);

    const [repos, setRepos] = useState<CodeRepoSummary[]>([]);
    const [reposStatus, setReposStatus] = useState<CodeStatus>("connecting");
    const [reposError, setReposError] = useState("");
    const [manualPath, setManualPath] = useState("");
    const [bindBusy, setBindBusy] = useState(false);
    const [bindError, setBindError] = useState("");

    const [treeByDir, setTreeByDir] = useState<Record<string, CodeTreeEntry[]>>({});
    const [expanded, setExpanded] = useState<string[]>([]);
    const [loadingDirs, setLoadingDirs] = useState<string[]>([]);
    const [treeStatus, setTreeStatus] = useState<CodeStatus>("connecting");
    const [treeError, setTreeError] = useState("");
    const [treeTruncated, setTreeTruncated] = useState(false);

    const [file, setFile] = useState<CodeFileState | null>(null);
    const [fileStatus, setFileStatus] = useState<CodeStatus>("connecting");
    const [fileError, setFileError] = useState("");

    const [diffText, setDiffText] = useState("");
    const [diffPath, setDiffPath] = useState("");
    const [diffStatus, setDiffStatus] = useState<CodeStatus>("connecting");
    const [diffError, setDiffError] = useState("");

    const [languageExtension, setLanguageExtension] = useState<Extension[]>([]);
    const [refreshKey, setRefreshKey] = useState(0);

    // Repo list backs both the first-run picker and the toolbar switcher.
    useEffect(() => {
        if (!hasAgent) {
            setRepos([]);
            setReposStatus("error");
            setReposError(i18n.t("canvas.code.notConnected"));
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

    // Root listing. Lazy depth-1 requests keep large repositories cheap to browse.
    useEffect(() => {
        if (!repoId || !hasAgent) return;
        let alive = true;
        setTreeStatus("connecting");
        setTreeError("");
        setTreeByDir({});
        setExpanded([]);
        setLoadingDirs([]);
        fetchAgentRepoTree(agentUrl, agentToken, { repoId, depth: TREE_REQUEST_DEPTH })
            .then((response) => {
                if (!alive) return;
                const entries = scopeTreeEntries(response.entries || [], CODE_ROOT_PATH);
                setTreeByDir({ [CODE_ROOT_PATH]: mergeTreeEntries(entries) });
                setTreeTruncated(Boolean(response.truncated));
                setTreeStatus("ready");
            })
            .catch((cause) => {
                if (!alive) return;
                setTreeByDir({});
                setTreeStatus("error");
                setTreeError(errorMessage(cause));
            });
        return () => {
            alive = false;
        };
    }, [repoId, agentUrl, agentToken, hasAgent, refreshKey]);

    // File and diff payloads for the active path and view.
    useEffect(() => {
        if (!repoId || !hasAgent || view === "tree") return;
        if (view === "file" && !activePath) return;
        let alive = true;
        if (view === "file") {
            setFileStatus("connecting");
            setFileError("");
            fetchAgentRepoFile(agentUrl, agentToken, { repoId, path: activePath })
                .then((response) => {
                    if (!alive) return;
                    setFile({ path: response.path || activePath, content: response.content || "", size: response.size, truncated: response.truncated });
                    setFileStatus("ready");
                })
                .catch((cause) => {
                    if (!alive) return;
                    setFile(null);
                    setFileStatus("error");
                    setFileError(errorMessage(cause));
                });
        } else {
            setDiffStatus("connecting");
            setDiffError("");
            fetchAgentRepoDiff(agentUrl, agentToken, { repoId, path: activePath || undefined })
                .then((response) => {
                    if (!alive) return;
                    setDiffText(response.diff || "");
                    setDiffPath(response.path || activePath);
                    setDiffStatus("ready");
                })
                .catch((cause) => {
                    if (!alive) return;
                    setDiffText("");
                    setDiffPath("");
                    setDiffStatus("error");
                    setDiffError(errorMessage(cause));
                });
        }
        return () => {
            alive = false;
        };
    }, [repoId, activePath, view, agentUrl, agentToken, hasAgent, refreshKey]);

    // Language support resolves by filename through CodeMirror's own matcher; unknown files
    // simply render as plain text.
    useEffect(() => {
        const path = file?.path || "";
        if (!path) {
            setLanguageExtension([]);
            return;
        }
        let alive = true;
        const description = LanguageDescription.matchFilename(languages, baseName(path));
        if (!description) {
            setLanguageExtension([]);
            return;
        }
        description
            .load()
            .then((support) => {
                if (alive) setLanguageExtension([support]);
            })
            .catch(() => {
                if (alive) setLanguageExtension([]);
            });
        return () => {
            alive = false;
        };
    }, [file?.path]);

    const updateState = useCallback(
        (patch: Partial<CodeViewState>) => {
            ctx.updateMetadata({ code: codeMetadataPatch(state, patch) });
        },
        [ctx, state],
    );

    const bindRepo = useCallback(
        (repo: CodeRepoSummary) => {
            setBindError("");
            setManualPath("");
            updateState({ repoId: repo.id, rootPath: repo.path, activePath: "", view: "tree" });
        },
        [updateState],
    );

    const unbindRepo = useCallback(() => {
        setBindError("");
        setTreeByDir({});
        setExpanded([]);
        setLoadingDirs([]);
        setFile(null);
        setDiffText("");
        updateState({ repoId: "", rootPath: "", activePath: "", view: "tree" });
    }, [updateState]);

    const submitManualRepo = useCallback(async () => {
        const path = manualPath.trim();
        if (!isAbsoluteRepoPath(path)) {
            setBindError(i18n.t("canvas.code.absolutePathRequired"));
            return;
        }
        if (!hasAgent) {
            setBindError(i18n.t("canvas.code.notConnected"));
            return;
        }
        setBindBusy(true);
        setBindError("");
        try {
            const response = await createAgentRepo(agentUrl, agentToken, { path });
            const repo = response.repo;
            if (!repo) throw new Error(i18n.t("canvas.code.registerFailed"));
            setRepos((prev) => (prev.some((item) => item.id === repo.id) ? prev : [...prev, repo]));
            bindRepo(repo);
        } catch (cause) {
            setBindError(errorMessage(cause));
        } finally {
            setBindBusy(false);
        }
    }, [agentUrl, agentToken, bindRepo, hasAgent, manualPath]);

    const toggleDir = useCallback(
        async (dir: string) => {
            const path = repoRelativePath(dir);
            if (expanded.includes(path)) {
                setExpanded((prev) => prev.filter((item) => item !== path));
                return;
            }
            setExpanded((prev) => [...prev, path]);
            if (treeByDir[path] || loadingDirs.includes(path) || !hasAgent) return;
            setLoadingDirs((prev) => [...prev, path]);
            try {
                const response = await fetchAgentRepoTree(agentUrl, agentToken, { repoId, path, depth: TREE_REQUEST_DEPTH });
                const entries = scopeTreeEntries(response.entries || [], path);
                setTreeByDir((prev) => ({ ...prev, [path]: mergeTreeEntries(entries) }));
            } catch (cause) {
                setTreeError(errorMessage(cause));
                setTreeStatus("error");
            } finally {
                setLoadingDirs((prev) => prev.filter((item) => item !== path));
            }
        },
        [agentToken, agentUrl, expanded, hasAgent, loadingDirs, repoId, treeByDir],
    );

    const openFile = useCallback(
        (path: string) => {
            updateState({ activePath: repoRelativePath(path), view: "file" });
        },
        [updateState],
    );

    const diffLines = useMemo(() => parseUnifiedDiff(diffText), [diffText]);
    const stats = useMemo(() => diffStats(diffLines), [diffLines]);

    const activeRepo = repos.find((repo) => repo.id === repoId);
    const viewStatus: CodeStatus = view === "diff" ? diffStatus : view === "file" && activePath ? fileStatus : treeStatus;
    const viewError = view === "diff" ? diffError : view === "file" && activePath ? fileError : treeError;
    const status: CodeStatus = hasAgent ? (repoId ? viewStatus : reposStatus) : "error";
    const statusMessage = hasAgent ? (repoId ? viewError : reposError) : i18n.t("canvas.code.notConnected");
    const languageName = file ? detectLanguageName(file.path) : "";

    return (
        <div className="flex h-full w-full flex-col overflow-hidden bg-white text-stone-700 dark:bg-stone-900 dark:text-stone-200">
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-stone-200 px-2 py-1.5 dark:border-stone-800">
                <span className="size-2 shrink-0 rounded-full" style={{ background: statusColor(status) }} title={statusMessage || t(statusLabelKey(status))} />
                <span className="shrink-0 text-[11px] text-stone-500 dark:text-stone-400">{t(statusLabelKey(status))}</span>
                {repoId ? (
                    <>
                        <span className="flex min-w-0 items-center gap-1 truncate text-[11px] font-medium text-stone-700 dark:text-stone-100">
                            <FolderGit2 className="size-3.5 shrink-0" />
                            <span className="truncate">{activeRepo?.name || repoId}</span>
                        </span>
                        {activeRepo?.branch || activeRepo?.isGit ? (
                            <span className="flex shrink-0 items-center gap-0.5 rounded bg-stone-100 px-1 py-0.5 text-[10px] text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                                <GitBranch className="size-3" />
                                {activeRepo?.branch || t("canvas.code.gitRepo")}
                            </span>
                        ) : null}
                    </>
                ) : null}
                <span className="min-w-0 flex-1" />
                <span className="flex shrink-0 items-center overflow-hidden rounded border border-stone-300 dark:border-stone-700">
                    <button
                        type="button"
                        onClick={() => updateState({ view: "file" })}
                        disabled={!repoId}
                        title={t("canvas.code.viewFile")}
                        className={`flex items-center gap-1 px-1.5 py-1 text-[11px] disabled:opacity-50 ${view === "diff" ? "text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800" : "bg-stone-200 text-stone-800 dark:bg-stone-700 dark:text-stone-100"}`}
                    >
                        <FileCode className="size-3.5" />
                        {t("canvas.code.viewFile")}
                    </button>
                    <button
                        type="button"
                        onClick={() => updateState({ view: "diff" })}
                        disabled={!repoId}
                        title={t("canvas.code.viewDiff")}
                        className={`flex items-center gap-1 border-l border-stone-300 px-1.5 py-1 text-[11px] disabled:opacity-50 dark:border-stone-700 ${view === "diff" ? "bg-stone-200 text-stone-800 dark:bg-stone-700 dark:text-stone-100" : "text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"}`}
                    >
                        <GitCompare className="size-3.5" />
                        {t("canvas.code.viewDiff")}
                    </button>
                </span>
                <button type="button" onClick={() => setRefreshKey((value) => value + 1)} disabled={!repoId} title={t("canvas.code.refresh")} className={CONTROL_CLASS}>
                    <RefreshCw className="size-3.5" />
                </button>
                {repoId ? (
                    <button type="button" onClick={unbindRepo} title={t("canvas.code.switchRepo")} className={`${CONTROL_CLASS} flex items-center gap-1`}>
                        <Unplug className="size-3.5" />
                        {t("canvas.code.switchRepo")}
                    </button>
                ) : null}
                {reposStatus === "error" && reposError ? <AlertCircle className="size-3.5 shrink-0 text-red-500" /> : null}
            </div>

            {!repoId ? (
                <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
                    <div className="w-full max-w-sm space-y-2">
                        <div className="text-[11px] font-medium text-stone-700 dark:text-stone-100">{t("canvas.code.bindTitle")}</div>
                        <select
                            value=""
                            onChange={(event) => {
                                const repo = repos.find((item) => item.id === event.target.value);
                                if (repo) bindRepo(repo);
                            }}
                            disabled={reposStatus !== "ready" || !repos.length}
                            className={`${CONTROL_CLASS} w-full`}
                        >
                            <option value="">{reposStatus === "connecting" ? t("canvas.code.loadingRepos") : t("canvas.code.selectRepo")}</option>
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
                                placeholder={t("canvas.code.manualPathPlaceholder")}
                                className="min-w-0 flex-1 rounded border border-stone-300 bg-transparent px-1.5 py-1 text-[11px] text-stone-700 outline-none dark:border-stone-700 dark:text-stone-200"
                            />
                            <button type="button" onClick={() => void submitManualRepo()} disabled={bindBusy || !hasAgent} className={CONTROL_CLASS}>
                                {bindBusy ? t("canvas.code.registering") : t("canvas.code.register")}
                            </button>
                        </div>
                        {bindError ? <div className="text-[11px] text-red-500">{bindError}</div> : null}
                        {reposError ? <div className="text-[11px] text-red-500">{reposError}</div> : null}
                    </div>
                </div>
            ) : (
                <div className="flex min-h-0 flex-1 overflow-hidden">
                    <div className="flex w-[210px] shrink-0 flex-col overflow-hidden border-r border-stone-200 dark:border-stone-800">
                        <div className="flex shrink-0 items-center gap-1 border-b border-stone-200 px-2 py-1 text-[10px] text-stone-400 dark:border-stone-800 dark:text-stone-500">
                            <Folder className="size-3" />
                            <span className="truncate" title={state.rootPath}>
                                {activeRepo?.name || state.rootPath || repoId}
                            </span>
                            {treeTruncated ? <span className="shrink-0 text-amber-600 dark:text-amber-400">{t("canvas.code.truncated")}</span> : null}
                        </div>
                        <div className="min-h-0 flex-1 overflow-auto py-1">
                            {treeStatus === "connecting" ? (
                                <Placeholder>
                                    <span className="flex items-center gap-1.5">
                                        <Loader2 className="size-3 animate-spin" />
                                        {t("canvas.code.loadingTree")}
                                    </span>
                                </Placeholder>
                            ) : treeStatus === "error" ? (
                                <Placeholder>
                                    <span className="space-y-1">
                                        <span className="block text-red-500">{treeError || t("canvas.code.statusError")}</span>
                                        <button type="button" onClick={() => setRefreshKey((value) => value + 1)} className={CONTROL_CLASS}>
                                            {t("canvas.code.retry")}
                                        </button>
                                    </span>
                                </Placeholder>
                            ) : (
                                <CodeTreeLevel
                                    dir={CODE_ROOT_PATH}
                                    depth={0}
                                    treeByDir={treeByDir}
                                    expanded={expanded}
                                    loadingDirs={loadingDirs}
                                    activePath={activePath}
                                    emptyLabel={t("canvas.code.emptyTree")}
                                    onToggleDir={(dir) => void toggleDir(dir)}
                                    onOpenFile={openFile}
                                />
                            )}
                        </div>
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                        {view === "diff" ? (
                            <>
                                <div className="flex shrink-0 items-center gap-2 border-b border-stone-200 px-2 py-1 text-[10px] text-stone-500 dark:border-stone-800 dark:text-stone-400">
                                    <GitCompare className="size-3 shrink-0" />
                                    <span className="truncate" title={diffPath}>
                                        {diffPath || t("canvas.code.diffWholeRepo")}
                                    </span>
                                    <span className="ml-auto shrink-0 text-emerald-600 dark:text-emerald-400">+{stats.added}</span>
                                    <span className="shrink-0 text-red-600 dark:text-red-400">-{stats.removed}</span>
                                </div>
                                <div className="min-h-0 flex-1 overflow-auto bg-stone-50 font-mono text-[11px] leading-5 dark:bg-stone-950">
                                    {diffStatus === "connecting" ? (
                                        <Placeholder>
                                            <span className="flex items-center gap-1.5">
                                                <Loader2 className="size-3 animate-spin" />
                                                {t("canvas.code.loadingDiff")}
                                            </span>
                                        </Placeholder>
                                    ) : diffStatus === "error" ? (
                                        <Placeholder>
                                            <span className="space-y-1">
                                                <span className="block text-red-500">{diffError || t("canvas.code.statusError")}</span>
                                                <button type="button" onClick={() => setRefreshKey((value) => value + 1)} className={CONTROL_CLASS}>
                                                    {t("canvas.code.retry")}
                                                </button>
                                            </span>
                                        </Placeholder>
                                    ) : diffLines.length ? (
                                        diffLines.map((line, index) => (
                                            <div key={`${index}-${line.kind}`} className={`whitespace-pre px-2 ${diffLineClass(line.kind)}`}>
                                                {line.text || " "}
                                            </div>
                                        ))
                                    ) : (
                                        <Placeholder>{t("canvas.code.diffEmpty")}</Placeholder>
                                    )}
                                </div>
                            </>
                        ) : view === "file" && activePath ? (
                            <>
                                <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-stone-200 px-2 py-1 text-[10px] text-stone-500 dark:border-stone-800 dark:text-stone-400">
                                    <FileCode className="size-3 shrink-0" />
                                    <span className="truncate" title={activePath}>
                                        {activePath}
                                    </span>
                                    {languageName ? <span className="shrink-0 rounded bg-stone-100 px-1 dark:bg-stone-800">{languageName}</span> : null}
                                    {file?.size != null ? <span className="shrink-0">{formatBytes(file.size)}</span> : null}
                                    {file?.truncated ? <span className="shrink-0 text-amber-600 dark:text-amber-400">{t("canvas.code.truncated")}</span> : null}
                                </div>
                                <div className="min-h-0 flex-1 overflow-hidden bg-white dark:bg-stone-950">
                                    {fileStatus === "connecting" ? (
                                        <Placeholder>
                                            <span className="flex items-center gap-1.5">
                                                <Loader2 className="size-3 animate-spin" />
                                                {t("canvas.code.loadingFile")}
                                            </span>
                                        </Placeholder>
                                    ) : fileStatus === "error" ? (
                                        <Placeholder>
                                            <span className="space-y-1">
                                                <span className="block text-red-500">{fileError || t("canvas.code.statusError")}</span>
                                                <button type="button" onClick={() => setRefreshKey((value) => value + 1)} className={CONTROL_CLASS}>
                                                    {t("canvas.code.retry")}
                                                </button>
                                            </span>
                                        </Placeholder>
                                    ) : file ? (
                                        <CodeMirror
                                            value={file.content}
                                            height="100%"
                                            editable={false}
                                            readOnly
                                            basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false, autocompletion: false, searchKeymap: false, closeBrackets: false, bracketMatching: false, indentOnInput: false }}
                                            theme={isDarkMode() ? "dark" : "light"}
                                            extensions={languageExtension}
                                            style={{ height: "100%", fontSize: 12 }}
                                            className="h-full text-[12px] [&_.cm-editor]:h-full [&_.cm-gutters]:border-none [&_.cm-scroller]:overflow-auto"
                                        />
                                    ) : (
                                        <Placeholder>{t("canvas.code.pickFile")}</Placeholder>
                                    )}
                                </div>
                            </>
                        ) : (
                            <Placeholder>{t("canvas.code.pickFile")}</Placeholder>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

export function codeNodeDefinition(): CanvasNodeDefinition {
    return {
        type: CODE_NODE_TYPE,
        title: i18n.t("canvas.nodeTypes.code"),
        icon: <FileCode className="size-4" />,
        description: i18n.t("canvas.code.description"),
        minimapColor: "#8b5cf6",
        defaultSize: { width: 780, height: 520 },
        defaultMetadata: { code: { view: "tree" } },
        hasSourceHandle: false,
        hidePanel: true,
        // The tree, the viewer and the diff pane all need pointer events, so the node stays
        // interactive; the canvas still owns drag and resize handles around the content.
        Content: ({ ctx }) => <CodeBrowserView ctx={ctx} />,
    };
}

let registered = false;
export function registerCodeNode() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions([codeNodeDefinition()], "builtin");
}
