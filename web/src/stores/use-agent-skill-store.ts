import { create } from "zustand";
import i18n from "@/i18n";

import { fetchCodexSkills, type AgentSkillDraft, type AgentSkillSummary } from "@/services/api/canvas-agent";
import { useAgentStore } from "@/stores/use-agent-store";
import { SKILL_BINDINGS_STORAGE_KEY, forgetWindow, normalizeBindings, toggleSkill, type SkillBindings } from "@/lib/agent/skill-bindings";

let loadSequence = 0;

type AgentSkillStore = {
    skills: AgentSkillSummary[];
    selectedSkill: AgentSkillSummary | null;
    selectionRevision: number;
    connectionRevision: number;
    autoPrompt: string;
    draft: AgentSkillDraft | null;
    generatingSource: "conversation" | "canvas" | null;
    loading: boolean;
    loaded: boolean;
    errors: string[];
    /** 窗口 → 已装技能（M5 技能市场）。 */
    bindings: SkillBindings;
    toggleWindowSkill: (windowId: string, name: string) => void;
    forgetWindowBindings: (windowId: string) => void;
    loadSkills: (endpoint: string, token: string, forceReload?: boolean) => Promise<void>;
    selectSkill: (skill: AgentSkillSummary | null, prompt?: string) => void;
    clearSelection: (expectedRevision?: number) => void;
    setDraft: (draft: AgentSkillDraft | null) => void;
    setGeneratingSource: (source: "conversation" | "canvas" | null) => void;
    reset: () => void;
};

export const useAgentSkillStore = create<AgentSkillStore>((set, get) => ({
    skills: [],
    selectedSkill: null,
    selectionRevision: 0,
    connectionRevision: 0,
    autoPrompt: "",
    draft: null,
    generatingSource: null,
    loading: false,
    loaded: false,
    errors: [],
    bindings: readBindings(),
    toggleWindowSkill: (windowId, name) => {
        const next = toggleSkill(get().bindings, windowId, name);
        if (next === get().bindings) return;
        writeBindings(next);
        set({ bindings: next });
    },
    forgetWindowBindings: (windowId) => {
        const next = forgetWindow(get().bindings, windowId);
        if (next === get().bindings) return;
        writeBindings(next);
        set({ bindings: next });
    },
    loadSkills: async (endpoint, token, forceReload = false) => {
        const sequence = ++loadSequence;
        set({ loading: true });
        try {
            const response = await fetchCodexSkills(endpoint, token, forceReload);
            if (sequence !== loadSequence) return;
            const skills = response.data || [];
            const current = get();
            const selected = current.selectedSkill;
            const selectedSkill = selected ? skills.find((item) => item.name === selected.name && item.path === selected.path && item.enabled) || null : null;
            const selectionChanged = Boolean(selected && !selectedSkill);
            if (selectionChanged) clearSelectedSkillPrompt(current);
            const autoPrompt = selectedSkill
                ? replaceAutoPrompt(current.autoPrompt, selectedSkill.interface?.defaultPrompt?.trim() || `$${selectedSkill.name}`, false)
                : "";
            set({ skills, selectedSkill, autoPrompt, selectionRevision: current.selectionRevision + (selectionChanged ? 1 : 0), loading: false, loaded: true, errors: (response.errors || []).map(skillErrorText) });
        } catch (error) {
            if (sequence !== loadSequence) return;
            set({ loading: false, loaded: true, errors: [error instanceof Error ? error.message : i18n.t("agent.state.skillReadFailed")] });
        }
    },
    selectSkill: (selectedSkill, prompt) => {
        const current = get();
        const agent = useAgentStore.getState();
        const marker = selectedSkill ? `$${selectedSkill.name}` : "";
        const previousMarker = current.selectedSkill ? `$${current.selectedSkill.name}` : "";
        let nextPrompt = prompt;
        let autoPrompt = "";
        if (nextPrompt === undefined && selectedSkill) {
            const defaultPrompt = selectedSkill.interface?.defaultPrompt?.trim() || marker;
            if (!agent.prompt.trim() || Boolean(current.autoPrompt && agent.prompt === current.autoPrompt)) {
                nextPrompt = defaultPrompt;
                autoPrompt = defaultPrompt;
            } else if (previousMarker && agent.prompt.includes(previousMarker)) {
                nextPrompt = agent.prompt.replace(previousMarker, marker);
            } else {
                nextPrompt = agent.prompt.includes(marker) ? agent.prompt : `${agent.prompt}${/\s$/.test(agent.prompt) ? "" : " "}${marker}`;
            }
        }
        if (nextPrompt !== undefined && agent.prompt !== nextPrompt) agent.setAgentState({ prompt: nextPrompt });
        set({ selectedSkill, autoPrompt, selectionRevision: current.selectionRevision + 1 });
    },
    clearSelection: (expectedRevision) => {
        const current = get();
        if (expectedRevision !== undefined && expectedRevision !== current.selectionRevision) return;
        clearSelectedSkillPrompt(current);
        set({ selectedSkill: null, autoPrompt: "", selectionRevision: current.selectionRevision + 1 });
    },
    setDraft: (draft) => set({ draft }),
    setGeneratingSource: (generatingSource) => set({ generatingSource }),
    reset: () => {
        loadSequence += 1;
        const current = get();
        clearSelectedSkillPrompt(current);
        set({ skills: [], selectedSkill: null, selectionRevision: current.selectionRevision + 1, connectionRevision: current.connectionRevision + 1, autoPrompt: "", draft: null, generatingSource: null, loading: false, loaded: false, errors: [] });
    },
}));

function replaceAutoPrompt(previous: string, next: string, fillEmpty: boolean) {
    const agent = useAgentStore.getState();
    const ownsPrompt = Boolean(previous && agent.prompt === previous);
    if (!ownsPrompt && !(fillEmpty && !agent.prompt.trim())) return "";
    if (agent.prompt !== next) agent.setAgentState({ prompt: next });
    return next;
}

function clearSelectedSkillPrompt(selection: Pick<AgentSkillStore, "selectedSkill" | "autoPrompt">) {
    const agent = useAgentStore.getState();
    if (selection.autoPrompt && agent.prompt === selection.autoPrompt) {
        agent.setAgentState({ prompt: "" });
        return;
    }
    if (!selection.selectedSkill) return;
    const marker = `$${selection.selectedSkill.name}`;
    if (agent.prompt.includes(marker)) agent.setAgentState({ prompt: agent.prompt.replace(marker, "") });
}

function readBindings(): SkillBindings {
    try {
        const raw = localStorage.getItem(SKILL_BINDINGS_STORAGE_KEY);
        return raw ? normalizeBindings(JSON.parse(raw)) : {};
    } catch {
        // 坏 JSON / 隐私模式：退回空绑定，不阻塞技能面板。
        return {};
    }
}

function writeBindings(bindings: SkillBindings) {
    try {
        localStorage.setItem(SKILL_BINDINGS_STORAGE_KEY, JSON.stringify(bindings));
    } catch {
        // 写不进去只影响下次打开，不影响本次会话。
    }
}

function skillErrorText(value: unknown) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return i18n.t("agent.state.skillParseFailed");
    const item = value as { path?: unknown; error?: unknown; message?: unknown };
    const message = typeof item.error === "string" ? item.error : typeof item.message === "string" ? item.message : i18n.t("agent.state.skillParseFailed");
    return typeof item.path === "string" ? `${item.path}：${message}` : message;
}
