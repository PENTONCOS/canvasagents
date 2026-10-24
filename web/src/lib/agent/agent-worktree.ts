// E4：面板侧的「任务独立 worktree」纯逻辑。
// 目录与分支的命名规则在桥端（`canvas-agent/src/repo/worktree.ts`）定死，前端不重算、不猜路径：
// 这里只负责把接口响应收窄成安全结构，并在拿到不合规路径时退回主工作区。
import type { AgentWindow } from "@/lib/agent/agent-windows";

/** 桥端 `POST /repo/worktrees` 的响应里我们真正需要的部分。 */
export type AgentWorktreeResult = {
    taskId: string;
    path: string;
    branch: string;
    /** true = 这次是真的新建，false = 复用了已有 worktree。 */
    created: boolean;
};

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

/**
 * 任务 id：用会话窗标题当任务名，空标题退回窗口 id。
 * 标题决定 worktree 目录名，所以只在「首次创建」时用；建好后路径就存在窗口里，改名不会搬目录。
 */
export function worktreeTaskId(title: string, windowId: string) {
    return text(title) || text(windowId);
}

/**
 * 收窄创建/查询响应。路径必须是绝对路径且非空，否则视为失败返回 null ——
 * 把相对路径当 cwd 交给桥端，等于在桥端进程的当前目录里跑 agent，宁可退回主工作区。
 */
export function readWorktreeResult(payload: unknown): AgentWorktreeResult | null {
    if (!payload || typeof payload !== "object") return null;
    const record = payload as Record<string, unknown>;
    const path = text(record.path);
    if (!path.startsWith("/")) return null;
    return {
        taskId: text(record.taskId),
        path,
        branch: text(record.branch),
        created: record.created === true,
    };
}

/** 列表响应用不到太多字段，但仍要挡掉空路径与相对路径，避免面板列出「点不动的条目」。 */
export function readWorktreeList(payload: unknown): AgentWorktreeResult[] {
    if (!payload || typeof payload !== "object") return [];
    const records = (payload as Record<string, unknown>).worktrees;
    if (!Array.isArray(records)) return [];
    const list: AgentWorktreeResult[] = [];
    for (const item of records) {
        const result = readWorktreeResult(item);
        if (result) list.push(result);
    }
    return list;
}

/** 徽标只显示目录末段：worktree 目录名已经带任务 slug，比整条路径可读。 */
export function worktreeLabel(path: string) {
    const trimmed = text(path).replace(/\/+$/, "");
    if (!trimmed) return "";
    const segment = trimmed.slice(trimmed.lastIndexOf("/") + 1);
    return segment || trimmed;
}

/**
 * 建线程时要传给桥端的 cwd。空串表示「不带 cwd」，桥端按 repoId / 站点工作空间解析，
 * 与 E4 之前完全一致；不要为了「显式」传一个自己拼出来的路径。
 */
export function threadWorktreeCwd(window: Pick<AgentWindow, "worktreePath"> | null | undefined) {
    return text(window?.worktreePath);
}
