// M5: pure helpers for the code browser node. Everything here is DOM-free so it can be
// unit tested directly (see tests/code-node.test.ts) and reused by the node component.
import type { CanvasNodeCodeMetadata, CanvasNodeCodeView } from "@/types/canvas";

export type CodeRepoSummary = { id: string; name: string; path: string; isGit: boolean; branch?: string };
export type CodeTreeEntry = { path: string; name: string; type: "file" | "dir"; size?: number };

// Normalized view state read from node metadata; every field has a safe default.
export type CodeViewState = {
    repoId: string;
    rootPath: string;
    activePath: string;
    view: CanvasNodeCodeView;
};

export const CODE_VIEWS: CanvasNodeCodeView[] = ["tree", "file", "diff"];
export const CODE_ROOT_PATH = "";

const CODE_DEFAULT_VIEW: CanvasNodeCodeView = "tree";

function normalizeText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

// Reads metadata.code into a fully populated state object so the UI never has to guard for
// undefined, and drops unknown view values coming from older or hand-edited canvases.
export function readCodeMetadata(metadata?: { code?: CanvasNodeCodeMetadata } | null): CodeViewState {
    const code = metadata?.code;
    const view = code && CODE_VIEWS.includes(code.view) ? code.view : CODE_DEFAULT_VIEW;
    return {
        repoId: normalizeText(code?.repoId),
        rootPath: normalizeText(code?.rootPath),
        activePath: normalizeText(code?.activePath),
        view,
    };
}

// Builds the metadata.code object written back through ctx.updateMetadata. Empty strings are
// stored as undefined so unbound state round-trips without leaking "" into serialized canvases.
export function codeMetadataPatch(current: CodeViewState, patch: Partial<CodeViewState> = {}): CanvasNodeCodeMetadata {
    const next: CodeViewState = { ...current, ...patch };
    return {
        repoId: next.repoId || undefined,
        rootPath: next.rootPath || undefined,
        activePath: next.activePath || undefined,
        view: CODE_VIEWS.includes(next.view) ? next.view : CODE_DEFAULT_VIEW,
    };
}

// Accepts POSIX (/repo), Windows (C:\repo) and UNC (\\server\share) absolute paths.
export function isAbsoluteRepoPath(value: string): boolean {
    const path = normalizeText(value);
    if (!path) return false;
    if (path.startsWith("/")) return true;
    if (/^[A-Za-z]:[\\/]/.test(path)) return true;
    return path.startsWith("\\\\");
}

// Normalizes a repo-relative path from the agent into the form used for API queries: forward
// slashes, no leading "./" or "/", no trailing slash, no "." segments. The repo root collapses to "".
export function repoRelativePath(value: string): string {
    const segments = normalizeText(value)
        .replace(/\\/g, "/")
        .split("/")
        .filter((segment) => segment && segment !== ".");
    return segments.join("/");
}

export function parentPath(value: string): string {
    const path = repoRelativePath(value);
    const index = path.lastIndexOf("/");
    return index <= 0 ? CODE_ROOT_PATH : path.slice(0, index);
}

export function baseName(value: string): string {
    const path = repoRelativePath(value);
    const index = path.lastIndexOf("/");
    return index < 0 ? path : path.slice(index + 1);
}

// Directories first, then by name with natural numeric ordering ("a2" before "a10").
export function sortTreeEntries(entries: CodeTreeEntry[]): CodeTreeEntry[] {
    return [...entries].sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" });
    });
}

// Lazy directory loads merge into the entries already held for a directory, de-duplicating by
// path so repeating a request is idempotent.
export function mergeTreeEntries(...lists: CodeTreeEntry[][]): CodeTreeEntry[] {
    const byPath = new Map<string, CodeTreeEntry>();
    lists.forEach((list) => {
        list.forEach((entry) => {
            if (entry && typeof entry.path === "string" && entry.path) byPath.set(entry.path, entry);
        });
    });
    return sortTreeEntries([...byPath.values()]);
}

// Normalizes one agent tree page. Entries are repo-relative by contract (same as /repo/file), so
// a depth-1 listing of `dir` should already be prefixed; if the agent ever answers with paths
// relative to the requested directory we prefix them here so the tree keys stay repo-relative.
export function scopeTreeEntries(entries: { path: string; name?: string; type: "file" | "dir"; size?: number }[], dir = CODE_ROOT_PATH): CodeTreeEntry[] {
    const base = repoRelativePath(dir);
    return entries.map((entry) => {
        const path = repoRelativePath(entry.path);
        const scoped = base && path !== base && !path.startsWith(`${base}/`) ? `${base}/${path}` : path;
        return { path: scoped, name: entry.name || baseName(scoped), type: entry.type === "dir" ? "dir" : "file", size: entry.size };
    });
}

export type CodeDiffLineKind = "add" | "del" | "hunk" | "meta" | "context";
export type CodeDiffLine = { kind: CodeDiffLineKind; text: string };

const DIFF_META_PREFIXES = ["diff ", "index ", "new file", "deleted file", "old mode", "new mode", "similarity index", "rename ", "copy ", "Binary files", "\\ No newline"];

// Classifies one unified-diff line. File headers (---/+++) are meta, not add/del, so the
// counters and colors stay honest.
export function classifyDiffLine(line: string): CodeDiffLineKind {
    if (line.startsWith("+++") || line.startsWith("---")) return "meta";
    if (line.startsWith("@@")) return "hunk";
    if (DIFF_META_PREFIXES.some((prefix) => line.startsWith(prefix))) return "meta";
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "del";
    return "context";
}

export function parseUnifiedDiff(diff: string): CodeDiffLine[] {
    const text = typeof diff === "string" ? diff : "";
    if (!text.trim()) return [];
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.map((line) => ({ kind: classifyDiffLine(line), text: line }));
}

export function diffStats(lines: CodeDiffLine[]): { added: number; removed: number } {
    return lines.reduce(
        (total, line) => {
            if (line.kind === "add") total.added += 1;
            else if (line.kind === "del") total.removed += 1;
            return total;
        },
        { added: 0, removed: 0 },
    );
}

// Display-only language label for the file viewer header; highlighting itself is resolved by
// CodeMirror's own filename matcher, so this map only needs to cover common source files.
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
    bash: "Shell",
    c: "C",
    cc: "C++",
    cjs: "JavaScript",
    cpp: "C++",
    cs: "C#",
    css: "CSS",
    go: "Go",
    h: "C",
    hpp: "C++",
    html: "HTML",
    htm: "HTML",
    ini: "INI",
    java: "Java",
    js: "JavaScript",
    json: "JSON",
    jsonc: "JSON",
    jsx: "JSX",
    kt: "Kotlin",
    less: "Less",
    lua: "Lua",
    md: "Markdown",
    mjs: "JavaScript",
    php: "PHP",
    pl: "Perl",
    py: "Python",
    rb: "Ruby",
    rs: "Rust",
    scss: "Sass",
    sh: "Shell",
    sql: "SQL",
    svelte: "Svelte",
    swift: "Swift",
    toml: "TOML",
    ts: "TypeScript",
    tsx: "TSX",
    txt: "Plain text",
    vue: "Vue",
    xml: "XML",
    yaml: "YAML",
    yml: "YAML",
    zsh: "Shell",
};

const LANGUAGE_BY_FILENAME: Record<string, string> = {
    dockerfile: "Docker",
    makefile: "Makefile",
    "package.json": "JSON",
    "tsconfig.json": "JSON",
};

export function detectLanguageName(path: string): string {
    const name = baseName(path).toLowerCase();
    if (!name) return "";
    const exact = LANGUAGE_BY_FILENAME[name];
    if (exact) return exact;
    const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
    return extension ? LANGUAGE_BY_EXTENSION[extension] || "" : "";
}

export function formatBytes(value: number | undefined): string {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
