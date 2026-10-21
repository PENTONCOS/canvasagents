/**
 * 技能市场：给「会话窗」装技能（M5）。
 *
 * 语义：技能本身是全局的（桥端 `~/.agents/skills` 与仓库 `.agents/skills`），
 * 这里只记「哪个窗口装了哪些技能」。装上的技能在该窗口的每轮对话里以 `$name` 带进提示词，
 * 这样同一个技能可以被 A 窗用、同时不污染 B 窗。
 *
 * 纯函数 + 显式上限：不读 store、不发请求，方便单测。
 */

export const MAX_BOUND_SKILLS = 8;
export const SKILL_BINDINGS_STORAGE_KEY = "canvasagents.agent.skill-bindings";

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type SkillBindings = Record<string, string[]>;

function cleanName(name: unknown): string {
    return typeof name === "string" ? name.trim() : "";
}

/** 只保留合法技能名，去重并保序。 */
export function normalizeSkillNames(names: unknown): string[] {
    if (!Array.isArray(names)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of names) {
        const name = cleanName(raw);
        if (!skillNamePattern.test(name) || seen.has(name)) continue;
        seen.add(name);
        result.push(name);
        if (result.length >= MAX_BOUND_SKILLS) break;
    }
    return result;
}

/** 反序列化：坏数据（null/字符串/数组）一律当空，不让 UI 崩在 .map 上。 */
export function normalizeBindings(input: unknown): SkillBindings {
    if (!input || typeof input !== "object" || Array.isArray(input)) return {};
    const result: SkillBindings = {};
    for (const [windowId, names] of Object.entries(input as Record<string, unknown>)) {
        if (!windowId) continue;
        const cleaned = normalizeSkillNames(names);
        if (cleaned.length) result[windowId] = cleaned;
    }
    return result;
}

export function boundSkills(bindings: SkillBindings, windowId: string): string[] {
    return bindings[windowId] || [];
}

export function isSkillBound(bindings: SkillBindings, windowId: string, name: string): boolean {
    return boundSkills(bindings, windowId).includes(cleanName(name));
}

/**
 * 绑定；已满或已存在时原样返回（引用相等），调用方可用它判断是否需要重渲染。
 */
export function bindSkill(bindings: SkillBindings, windowId: string, name: string): SkillBindings {
    const skill = cleanName(name);
    if (!windowId || !skillNamePattern.test(skill)) return bindings;
    const current = boundSkills(bindings, windowId);
    if (current.includes(skill) || current.length >= MAX_BOUND_SKILLS) return bindings;
    return { ...bindings, [windowId]: [...current, skill] };
}

export function unbindSkill(bindings: SkillBindings, windowId: string, name: string): SkillBindings {
    const skill = cleanName(name);
    const current = boundSkills(bindings, windowId);
    if (!current.includes(skill)) return bindings;
    const next = current.filter((item) => item !== skill);
    if (next.length) return { ...bindings, [windowId]: next };
    const { [windowId]: _removed, ...rest } = bindings;
    return rest;
}

export function toggleSkill(bindings: SkillBindings, windowId: string, name: string): SkillBindings {
    return isSkillBound(bindings, windowId, name) ? unbindSkill(bindings, windowId, name) : bindSkill(bindings, windowId, name);
}

/** 删除窗口时清理绑定，避免 windowId 复用后继承别人的技能。 */
export function forgetWindow(bindings: SkillBindings, windowId: string): SkillBindings {
    if (!(windowId in bindings)) return bindings;
    const { [windowId]: _removed, ...rest } = bindings;
    return rest;
}

/**
 * 拼进提示词的技能前缀。
 * 已经在文本里出现过的 `$name` 不重复加，否则同一技能会被强调两次。
 */
export function skillPromptPrefix(bindings: SkillBindings, windowId: string, prompt: string): string {
    const names = boundSkills(bindings, windowId);
    if (!names.length) return "";
    const missing = names.filter((name) => !new RegExp(`(^|\\s)\\$${name}(?![a-z0-9-])`).test(prompt));
    if (!missing.length) return "";
    return `技能：${missing.map((name) => `$${name}`).join(" ")}\n`;
}
