// E4：线程工作目录解析。抽成纯函数是因为这条判定是安全边界——
// 请求里的 `cwd` 由前端给，只有「已注册仓库」和「真属于某个已注册仓库的 worktree」可以放行，
// 其余一律回退站点工作空间，绝不让 agent 在任意目录里跑。
import path from "node:path";

import { isRepoWorktreePath } from "./worktree.js";

export type ThreadCwdInput = { repoId?: unknown; cwd?: unknown };

/**
 * 解析顺序：repoId → 已注册仓库路径 → 任务 worktree 路径 → 回退。
 * `fallback` 用惰性值：站点工作空间会在缺失时创建目录，只在真回退时才该发生。
 */
export function resolveThreadCwd(input: ThreadCwdInput = {}, repos: Array<{ id: string; path: string }> = [], fallback: () => string, options: { baseDir?: string } = {}) {
    const repoId = String(input.repoId || "");
    const byId = repos.find((repo) => repo.id === repoId);
    if (byId) return byId.path;
    const cwd = String(input.cwd || "");
    if (cwd) {
        const resolved = path.resolve(cwd);
        const byPath = repos.find((repo) => path.resolve(repo.path) === resolved);
        if (byPath) return byPath.path;
        // worktree 也是合法工作目录，但它必须真属于某个已注册仓库。
        if (isRepoWorktreePath(repos.map((repo) => repo.path), resolved, options.baseDir)) return resolved;
    }
    return fallback();
}
