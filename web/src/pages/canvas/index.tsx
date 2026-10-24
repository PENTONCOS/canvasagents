import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button } from "antd";
import { Download, FileUp, FolderPlus, Pencil, Plus, Trash2, X, Check } from "lucide-react";
import { useTranslation } from "react-i18next";

import { readZip } from "@/lib/zip";
import { setMediaBlob } from "@/services/file-storage";
import { setImageBlob } from "@/services/image-storage";
import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "@/components/canvas/canvas-project-card";
import type { CanvasExportFile } from "@/types/canvas-export";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { groupCanvases } from "@/lib/canvas/canvas-projects";
import { hasAgentUrlBootstrap } from "@/lib/agent/agent-url-bootstrap";

export default function CanvasPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const inputRef = useRef<HTMLInputElement>(null);
    const autoOpenRef = useRef(false);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const groups = useCanvasStore((state) => state.groups);
    const createProject = useCanvasStore((state) => state.createProject);
    const importProject = useCanvasStore((state) => state.importProject);
    const createGroup = useCanvasStore((state) => state.createGroup);
    const renameGroup = useCanvasStore((state) => state.renameGroup);
    const deleteGroup = useCanvasStore((state) => state.deleteGroup);
    const moveProjectToGroup = useCanvasStore((state) => state.moveProjectToGroup);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    // 项目名就地编辑：只存「正在改哪个项目」和草稿，不落库直到确认。
    const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
    const [groupDraft, setGroupDraft] = useState("");

    const mode = searchParams.get("mode");
    const agentMode = mode === "new" || mode === "recent" || mode === "choose";
    const agentQuery = agentMode ? `?${searchParams.toString()}` : "";
    const buckets = useMemo(() => groupCanvases(projects, groups), [groups, projects]);
    const groupOptions = useMemo(() => groups.map((group) => ({ id: group.id, title: group.title })), [groups]);

    const enterProject = (id: string) => {
        const agentHash = hasAgentUrlBootstrap(window.location.hash) ? window.location.hash : "";
        navigate(`/canvas/${id}${agentQuery}${agentHash}`, { replace: Boolean(agentHash) });
    };
    const createAndEnter = (groupId?: string) => enterProject(createProject(t("canvas.defaultTitle", { count: projects.length + 1 }), groupId));
    const importCanvas = async (file?: File) => {
        if (!file) return;
        try {
            const zip = await readZip(file);
            const projectFile = zip.get("projects.json");
            if (!projectFile) throw new Error("missing projects.json");
            const data = JSON.parse(await projectFile.text()) as CanvasExportFile;
            await Promise.all(
                data.projects.flatMap((project) =>
                    project.files.map(async (item) => {
                        const blob = zip.get(item.path);
                        if (!blob) return;
                        const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
                        await (item.storageKey.startsWith("image:") ? setImageBlob(item.storageKey, typedBlob) : setMediaBlob(item.storageKey, typedBlob));
                    }),
                ),
            );
            data.projects.forEach((item) => importProject(item.project));
            message.success(t("canvas.imported", { count: data.projects.length }));
        } catch {
            message.error(t("canvas.importFailed"));
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    useEffect(() => {
        if (!hydrated || autoOpenRef.current || (mode !== "new" && mode !== "recent")) return;
        autoOpenRef.current = true;
        enterProject(mode === "new" ? createProject(t("canvas.defaultTitle", { count: projects.length + 1 })) : projects[0]?.id || createProject(t("canvas.defaultTitle", { count: projects.length + 1 })));
    }, [createProject, hydrated, mode, projects, t]);

    const startRenameGroup = (id: string, title: string) => {
        setRenamingGroupId(id);
        setGroupDraft(title);
    };
    const finishRenameGroup = () => {
        if (renamingGroupId) renameGroup(renamingGroupId, groupDraft);
        setRenamingGroupId(null);
    };
    const removeGroup = (id: string) => {
        // 非空项目拒绝删除：删项目连带删画布必须是显式的画布删除动作，不能藏在这里。
        if (!deleteGroup(id)) message.warning(t("canvas.group.deleteBlocked"));
    };

    if (hydrated && (mode === "new" || mode === "recent")) return <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">{t("canvas.opening")}</main>;

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <p className="text-xs text-stone-500">{t("canvas.library")}</p>
                        <h1 className="mt-3 text-3xl font-semibold">{t("canvas.title")}</h1>
                    </div>
                    <div className="flex items-center gap-2">
                        {selectedIds.length ? (
                            <>
                                <Button disabled={!hydrated} icon={<Download className="size-4" />} onClick={() => void exportCanvasProjects(projects.filter((project) => selectedIds.includes(project.id)), `${t("canvas.title")}-${selectedIds.length}`)}>
                                    {t("canvas.exportSelected")}
                                </Button>
                                <Button disabled={!hydrated} onClick={() => setDeleteIds(selectedIds)}>
                                    {t("canvas.deleteSelected")}
                                </Button>
                            </>
                        ) : null}
                        {projects.length ? (
                            <Button disabled={!hydrated} onClick={() => setDeleteIds(projects.map((project) => project.id))}>
                                {t("canvas.deleteAll")}
                            </Button>
                        ) : null}
                        <Button disabled={!hydrated} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
                            {t("canvas.import")}
                        </Button>
                        <Button disabled={!hydrated} icon={<FolderPlus className="size-4" />} onClick={() => startRenameGroup(createGroup(), t("canvas.group.untitled"))}>
                            {t("canvas.group.newProject")}
                        </Button>
                        <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={() => createAndEnter()}>
                            {t("canvas.create")}
                        </Button>
                    </div>
                </header>

                {!hydrated ? (
                    <section className="flex min-h-[360px] items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">{t("canvas.loading")}</section>
                ) : buckets.buckets.length || buckets.orphans.length ? (
                    <div className="flex flex-col gap-10">
                        {buckets.buckets.map((bucket) => (
                            <section key={bucket.group.id} data-project-id={bucket.group.id} className="flex flex-col gap-4">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div className="flex min-w-0 items-center gap-2">
                                        {renamingGroupId === bucket.group.id ? (
                                            <>
                                                <input
                                                    value={groupDraft}
                                                    autoFocus
                                                    onChange={(event) => setGroupDraft(event.target.value)}
                                                    onKeyDown={(event) => {
                                                        if (event.key === "Enter") finishRenameGroup();
                                                        if (event.key === "Escape") setRenamingGroupId(null);
                                                    }}
                                                    className="min-w-0 rounded-md border border-stone-300 bg-transparent px-2 py-1 text-lg font-semibold outline-none dark:border-stone-600"
                                                    aria-label={t("canvas.group.rename")}
                                                />
                                                <Button type="text" size="small" shape="circle" icon={<Check className="size-4" />} onClick={finishRenameGroup} aria-label={t("common.save")} />
                                                <Button type="text" size="small" shape="circle" icon={<X className="size-4" />} onClick={() => setRenamingGroupId(null)} aria-label={t("common.cancel")} />
                                            </>
                                        ) : (
                                            <>
                                                <button type="button" className="min-w-0 cursor-pointer text-left text-lg font-semibold" onDoubleClick={() => startRenameGroup(bucket.group.id, bucket.group.title)} title={t("canvas.group.renameHint")}>
                                                    {bucket.group.title}
                                                </button>
                                                <span className="text-xs text-stone-500">{t("canvas.group.canvasCount", { count: bucket.canvases.length })}</span>
                                                <Button type="text" size="small" shape="circle" icon={<Pencil className="size-3.5" />} onClick={() => startRenameGroup(bucket.group.id, bucket.group.title)} aria-label={t("canvas.group.rename")} />
                                                <Button type="text" size="small" shape="circle" icon={<Trash2 className="size-3.5" />} onClick={() => removeGroup(bucket.group.id)} aria-label={t("canvas.group.delete")} />
                                            </>
                                        )}
                                    </div>
                                    <Button size="small" icon={<Plus className="size-3.5" />} onClick={() => createAndEnter(bucket.group.id)}>
                                        {t("canvas.group.newCanvas")}
                                    </Button>
                                </div>
                                {bucket.canvases.length ? (
                                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                                        {bucket.canvases.map((project) => (
                                            <CanvasProjectCard key={project.id} project={project} groupOptions={groupOptions} onMove={(groupId) => moveProjectToGroup(project.id, groupId)} />
                                        ))}
                                    </div>
                                ) : (
                                    <div className="flex min-h-36 flex-col items-center justify-center rounded-2xl border border-dashed border-stone-300 text-center dark:border-stone-700">
                                        <p className="text-sm font-medium">{t("canvas.group.empty")}</p>
                                        <p className="mt-2 text-xs text-stone-500">{t("canvas.group.emptyHint")}</p>
                                        <Button className="mt-4" size="small" icon={<Plus className="size-3.5" />} onClick={() => createAndEnter(bucket.group.id)}>
                                            {t("canvas.group.newCanvas")}
                                        </Button>
                                    </div>
                                )}
                            </section>
                        ))}
                        {buckets.orphans.length ? (
                            <section className="flex flex-col gap-4">
                                <h2 className="text-lg font-semibold">{t("canvas.group.untitled")}</h2>
                                <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                                    {buckets.orphans.map((project) => (
                                        <CanvasProjectCard key={project.id} project={project} groupOptions={groupOptions} onMove={(groupId) => moveProjectToGroup(project.id, groupId)} />
                                    ))}
                                </div>
                            </section>
                        ) : null}
                    </div>
                ) : (
                    <section className="flex min-h-[360px] flex-col items-center justify-center border-y border-stone-200 text-center dark:border-stone-800">
                        <h2 className="text-xl font-medium">{t("canvas.empty")}</h2>
                        <p className="mt-3 text-sm text-stone-500">{t("canvas.emptyDescription")}</p>
                        <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={() => createAndEnter()}>
                            {t("canvas.create")}
                        </Button>
                    </section>
                )}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
        </main>
    );
}
