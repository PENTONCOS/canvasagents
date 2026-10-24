// E4：会话窗的「任务独立 worktree」入口。
// 一个会话窗 = 一个任务：开独立 worktree 后，这个窗新建/恢复的线程都以该目录为工作目录。
// 目录与分支怎么命名由桥端决定，这里只负责选任务、拿路径、显示状态；绝不自己拼路径。
import { useEffect, useState } from "react";

import { Button, Dropdown, message, Tooltip } from "antd";
import { FolderGit2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { REPO_NODE_TYPE } from "@/components/canvas/nodes/repo-node";
import { readRepoMetadata, repoDisplayName } from "@/lib/canvas/repo-node-utils";
import { readWorktreeResult, worktreeLabel } from "@/lib/agent/agent-worktree";
import { useAgentStore } from "@/stores/use-agent-store";
import { createAgentWorktree, removeAgentWorktree } from "@/services/api/canvas-agent";

type BoundRepo = { repoId: string; name: string };

function readBoundRepo(): BoundRepo | null {
    const nodes = useAgentStore.getState().canvasContext?.snapshot.nodes || [];
    const node = nodes.find((item) => item.type === REPO_NODE_TYPE);
    const state = readRepoMetadata(node?.metadata);
    if (!state.repoId) return null;
    return { repoId: state.repoId, name: repoDisplayName(state) };
}

function signatureOf(repo: BoundRepo | null) {
    return repo ? `${repo.repoId}\u0000${repo.name}` : "";
}

export function AgentWorktreeMenu({
    endpoint,
    token,
    disabled,
    onSwitch,
}: {
    endpoint: string;
    token: string;
    disabled?: boolean;
    /** 传入新的 worktree 路径；空串表示切回主工作区。由面板负责落窗口状态并重建线程。 */
    onSwitch: (path: string) => void;
}) {
    const { t } = useTranslation();
    const [repo, setRepo] = useState<BoundRepo | null>(readBoundRepo);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let last = signatureOf(readBoundRepo());
        return useAgentStore.subscribe(() => {
            const next = readBoundRepo();
            const signature = signatureOf(next);
            if (signature === last) return;
            last = signature;
            setRepo(next);
        });
    }, []);

    const windowTitle = useAgentStore((state) => state.windows.find((item) => item.id === state.activeWindowId)?.title || "");
    const windowId = useAgentStore((state) => state.activeWindowId);
    const worktreePath = useAgentStore((state) => state.worktreePath);

    if (!repo) return null;

    const taskId = windowTitle.trim() || windowId;
    const label = worktreePath ? worktreeLabel(worktreePath) : t("agent.worktree.mainWorkspace");

    const create = async () => {
        setBusy(true);
        try {
            const payload = await createAgentWorktree(endpoint, token, { repoId: repo.repoId, taskId });
            const result = readWorktreeResult(payload);
            if (!result) throw new Error(t("agent.worktree.invalidPath"));
            onSwitch(result.path);
            message.success(result.created ? t("agent.worktree.created", { path: result.path }) : t("agent.worktree.reused", { path: result.path }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("agent.worktree.failed"));
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!worktreePath) return;
        setBusy(true);
        try {
            // 不加 force：目录里有未提交改动时桥端会拒绝，宁可他先提交，也不静默丢改动。
            await removeAgentWorktree(endpoint, token, { repoId: repo.repoId, path: worktreePath });
            onSwitch("");
            message.success(t("agent.worktree.removed"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("agent.worktree.failed"));
        } finally {
            setBusy(false);
        }
    };

    const items = [
        {
            key: "status",
            disabled: true,
            label: <span className="block max-w-[18rem] whitespace-normal text-xs leading-5 text-black/60 dark:text-white/60">{worktreePath ? t("agent.worktree.current", { path: worktreePath }) : t("agent.worktree.mainHint")}</span>,
        },
        { type: "divider" as const },
        {
            key: "enable",
            label: worktreePath ? t("agent.worktree.refresh") : t("agent.worktree.enable", { task: taskId }),
            disabled: busy,
        },
        {
            key: "main",
            label: t("agent.worktree.disable"),
            disabled: busy || !worktreePath,
        },
        {
            key: "remove",
            label: t("agent.worktree.remove"),
            danger: true,
            disabled: busy || !worktreePath,
        },
    ];

    return (
        <Dropdown
            trigger={["click"]}
            menu={{
                items,
                onClick: ({ key }) => {
                    if (key === "enable") void create();
                    else if (key === "main") onSwitch("");
                    else if (key === "remove") void remove();
                },
            }}
        >
            <Tooltip title={worktreePath ? t("agent.worktree.tooltipOn", { task: taskId }) : t("agent.worktree.tooltipOff")} placement="bottom">
                <Button
                    size="small"
                    type="text"
                    className="!h-8 !w-8 !min-w-8 !px-0 @min-[560px]:!w-auto @min-[560px]:!min-w-0 @min-[560px]:!px-[7px]"
                    aria-label={t("agent.worktree.badgeLabel")}
                    loading={busy}
                    disabled={disabled}
                    icon={<FolderGit2 className={worktreePath ? "size-3.5 text-emerald-600" : "size-3.5"} />}
                >
                    <span className="hidden max-w-[8rem] truncate @min-[560px]:inline">{label}</span>
                </Button>
            </Tooltip>
        </Dropdown>
    );
}
