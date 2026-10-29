import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { APP_ID } from "@/constant/brand";
import i18n from "@/i18n";
import { localForageStorage } from "@/lib/localforage-storage";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { planProjectGroups, type CanvasProjectGroup } from "@/lib/canvas/canvas-projects";
import type { CanvasAssistantSession, CanvasConnection, CanvasJournalEntry, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type { CanvasProjectGroup };

export type CanvasProject = {
    id: string;
    title: string;
    // 所属项目（I1 项目层）。可选：旧数据没有这一层，迁移时补默认项目。
    groupId?: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    // Canvas Journal: append-only operation log. Optional so existing projects stay valid; it rides
    // along with the whole project through persist with no extra plumbing.
    journal?: CanvasJournalEntry[];
};

export type CanvasDeletedProject = {
    id: string;
    deletedAt: string;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    groups: CanvasProjectGroup[];
    deletedProjects: CanvasDeletedProject[];
    createProject: (title?: string, groupId?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[], deletedProjects?: CanvasDeletedProject[], groups?: CanvasProjectGroup[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport" | "journal" | "groupId">>) => void;
    createGroup: (title?: string) => string;
    renameGroup: (id: string, title: string) => void;
    /** 只有空项目能删；项目里还有画布时返回 false，绝不连带删画布。 */
    deleteGroup: (id: string) => boolean;
    moveProjectToGroup: (projectId: string, groupId: string) => void;
    /** 迁移旧数据：补默认项目、修正指向不存在项目的 groupId。幂等。 */
    normalizeGroups: () => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = `${APP_ID}:canvas_store`;
type PersistedCanvasState = Pick<CanvasStore, "projects" | "deletedProjects" | "groups">;
const NEW_GROUP_TITLE = () => i18n.t("canvas.group.defaultTitle");
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;

// 紧急备份：只在 pagehide（刷新/关闭/跳走）时写一次 localStorage。
// localForage 是异步的，去抖窗口里刷新会丢写入；但常驻镜像会盖掉测试预置的数据，
// 所以备份只在「主存储读不到 / 读出来是空库」时兜底。
const CANVAS_BACKUP_KEY = `${APP_ID}:canvas_store:backup`;
type BackupValue = StorageValue<PersistedCanvasState> & { savedAt?: number };

function readBackup(): BackupValue | null {
    try {
        const raw = window.localStorage.getItem(CANVAS_BACKUP_KEY);
        return raw ? (JSON.parse(raw) as BackupValue) : null;
    } catch {
        return null;
    }
}

const canvasStorage: PersistStorage<PersistedCanvasState> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (value) {
            const parsed = JSON.parse(value) as StorageValue<PersistedCanvasState>;
            // 主存储是空库、备份里有内容 → 用备份（上次刷新时还没落盘的那一版）。
            const backup = readBackup();
            if (backup && (parsed.state?.projects?.length || 0) === 0 && (backup.state?.projects?.length || 0) > 0) {
                queuedPersistState = backup.state;
                return backup;
            }
            queuedPersistState = parsed.state;
            return parsed;
        }
        const backup = readBackup();
        if (backup?.state) {
            queuedPersistState = backup.state;
            return backup;
        }
        return null;
    },
    setItem: (name, value) => {
        const nextState = value.state;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects && queuedPersistState.deletedProjects === nextState.deletedProjects && queuedPersistState.groups === nextState.groups) return;
        queuedPersistState = nextState;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            void localForageStorage.setItem(name, JSON.stringify(value));
        }, 400);
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

// 防丢：页面被刷新/关闭时把还没落盘的那一次写掉。
// 之前只靠 400ms 去抖，导致「建完项目立刻进画布/刷新」会丢写入（实测可复现）。
if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => {
        if (!queuedPersistState) return;
        const snapshot: BackupValue = { state: queuedPersistState, version: 1, savedAt: Date.now() };
        try {
            window.localStorage.setItem(CANVAS_BACKUP_KEY, JSON.stringify(snapshot));
        } catch {
            // 配额满就只靠 IndexedDB，最坏情况是丢掉最后 400ms 的写入。
        }
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
            void localForageStorage.setItem(CANVAS_STORE_KEY, JSON.stringify(snapshot));
        }
    });
}

/** 取第一个项目归入；一个都没有时建一个默认项目（旧数据首次落库走这条）。 */
function ensureGroup(groups: CanvasProjectGroup[], now: string): { groups: CanvasProjectGroup[]; groupId: string } {
    const existing = groups[0]?.id;
    if (existing) return { groups, groupId: existing };
    const id = nanoid();
    return { groups: [{ id, title: NEW_GROUP_TITLE(), createdAt: now, updatedAt: now }], groupId: id };
}

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            groups: [],
            deletedProjects: [],
            createProject: (title = i18n.t("canvas.project.untitled"), groupId) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const state = get();
                const ensured = groupId && state.groups.some((group) => group.id === groupId) ? { groups: state.groups, groupId } : ensureGroup(state.groups, now);
                const project: CanvasProject = {
                    id,
                    title,
                    groupId: ensured.groupId,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                };
                set({ projects: [project, ...state.projects], groups: ensured.groups });
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const state = get();
                const ensured = ensureGroup(state.groups, now);
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || i18n.t("canvas.project.imported"),
                    groupId: ensured.groupId,
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                };
                set({ projects: [project, ...state.projects], groups: ensured.groups });
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
                })),
            deleteProjects: (ids) =>
                set((state) => {
                    const now = new Date().toISOString();
                    const removing = new Set(ids);
                    const projects = state.projects.filter((project) => !removing.has(project.id));
                    const deletedProjects = [...state.deletedProjects.filter((item) => !removing.has(item.id)), ...ids.map((id) => ({ id, deletedAt: now }))];
                    return { projects, deletedProjects };
                }),
            replaceProjects: (projects, deletedProjects = [], groups) =>
                set((state) => ({ projects, deletedProjects, groups: groups ?? state.groups })),
            updateProject: (id, patch) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project)),
                })),
            createGroup: (title = i18n.t("canvas.group.defaultTitle")) => {
                const now = new Date().toISOString();
                const id = nanoid();
                set((state) => ({ groups: [...state.groups, { id, title: title.trim() || i18n.t("canvas.group.defaultTitle"), createdAt: now, updatedAt: now }] }));
                return id;
            },
            renameGroup: (id, title) =>
                set((state) => ({
                    groups: state.groups.map((group) => (group.id === id ? { ...group, title: title.trim() || group.title, updatedAt: new Date().toISOString() } : group)),
                })),
            deleteGroup: (id) => {
                const state = get();
                if (state.projects.some((project) => project.groupId === id)) return false;
                set((current) => ({ groups: current.groups.filter((group) => group.id !== id) }));
                return true;
            },
            moveProjectToGroup: (projectId, groupId) =>
                set((state) => {
                    if (!state.groups.some((group) => group.id === groupId)) return state;
                    return { projects: state.projects.map((project) => (project.id === projectId ? { ...project, groupId, updatedAt: new Date().toISOString() } : project)) };
                }),
            normalizeGroups: () =>
                set((state) => {
                    const now = new Date().toISOString();
                    const plan = planProjectGroups(state.projects, state.groups, { now, defaultTitle: i18n.t("canvas.group.defaultTitle"), newId: () => nanoid() });
                    if (plan.canvases === state.projects && plan.groups === state.groups) return state;
                    return { projects: plan.canvases, groups: plan.groups };
                }),
        }),
        {
            name: CANVAS_STORE_KEY,
            version: 1,
            storage: canvasStorage,
            // v0 → v1：画布之上加一层项目。旧数据没有 groups / groupId，必须在这里补上，
            // 否则列表页会一个项目都没有、画布全成孤儿。
            migrate: (persisted, version) => {
                const state = (persisted || {}) as Partial<PersistedCanvasState>;
                if (version >= 1) return state as PersistedCanvasState;
                const now = new Date().toISOString();
                const plan = planProjectGroups(state.projects || [], state.groups || [], { now, defaultTitle: i18n.t("canvas.group.defaultTitle"), newId: () => nanoid() });
                return { projects: plan.canvases, groups: plan.groups, deletedProjects: state.deletedProjects || [] } as PersistedCanvasState;
            },
            partialize: (state) =>
                ({
                    projects: state.projects,
                    groups: state.groups,
                    deletedProjects: state.deletedProjects,
                }) as PersistedCanvasState,
            onRehydrateStorage: () => () => {
                // migrate 只对旧版本生效，所以每次 hydrate 再收一次口，保证幂等。
                useCanvasStore.getState().normalizeGroups();
                useCanvasStore.setState({ hydrated: true });
            },
        },
    ),
);
