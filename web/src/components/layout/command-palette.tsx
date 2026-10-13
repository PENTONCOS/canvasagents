import { useEffect, useMemo, useState } from "react";

import { Modal } from "antd";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { CanvasNodeType } from "@/types/canvas";
import { TERMINAL_NODE_TYPE } from "@/components/canvas/nodes/terminal-node";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCommandStore } from "@/stores/use-command-store";
import { useConfigStore } from "@/stores/use-config-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { cn } from "@/lib/utils";

type CommandItem = {
    key: string;
    label: string;
    hint?: string;
    run: () => void;
};

const NODE_TYPES = [CanvasNodeType.Image, CanvasNodeType.Text, CanvasNodeType.Config, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Group] as const;

function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
}

// M1 immersive redesign: lightweight ⌘K/Ctrl+K command palette. No new deps:
// fuzzy-ish filter + keyboard navigation over a flat command list.
export function CommandPalette() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [activeIndex, setActiveIndex] = useState(0);
    const requestNode = useCommandStore((state) => state.requestNode);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const openPanel = useAgentStore((state) => state.openPanel);
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const projects = useCanvasStore((state) => state.projects);
    const createProject = useCanvasStore((state) => state.createProject);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                setOpen((value) =>!value);
                setQuery("");
                setActiveIndex(0);
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    const commands = useMemo<CommandItem[]>(() => {
        const items: CommandItem[] = NODE_TYPES.map((type) => ({
            key: `node:${type}`,
            label: t("commandPalette.createNode", { type: t(`canvas.nodeTypes.${type.toLowerCase()}`) }),
            run: () => {
                requestNode(type);
                setOpen(false);
            },
        }));
        items.push({
            key: "node:terminal",
            label: t("commandPalette.createNode", { type: t("canvas.nodeTypes.terminal") }),
            run: () => {
                requestNode(TERMINAL_NODE_TYPE);
                setOpen(false);
            },
        });
        items.push(
            { key: "settings", label: t("commandPalette.openSettings"), run: () => { openConfigDialog(false); setOpen(false); } },
            { key: "agent", label: t("commandPalette.openAgent"), run: () => { openPanel(); setOpen(false); } },
            { key: "queue", label: t("commandPalette.openQueue"), run: () => { setAgentState({ queueOpen: true }); setOpen(false); } },
            ...projects.slice(0, 8).map((project) => ({
                key: `project:${project.id}`,
                label: t("commandPalette.openProject"),
                hint: project.title,
                run: () => { navigate(`/canvas/${project.id}`); setOpen(false); },
            })),
            {
                key: "project:new",
                label: t("commandPalette.newProject"),
                run: () => {
                    const id = createProject();
                    navigate(`/canvas/${id}`);
                    setOpen(false);
                },
            },
        );
        return items;
    }, [t, projects, navigate, requestNode, openConfigDialog, openPanel, createProject, setAgentState]);

    const filtered = useMemo(() => {
        const keyword = query.trim().toLowerCase();
        if (!keyword) return commands;
        return commands.filter((item) => `${item.label} ${item.hint ?? ""}`.toLowerCase().includes(keyword));
    }, [commands, query]);

    useEffect(() => {
        setActiveIndex(0);
    }, [query]);

    const runActive = (item?: CommandItem) => {
        if (item) item.run();
    };

    return (
        <Modal
            open={open}
            onCancel={() => setOpen(false)}
            footer={null}
            closable={false}
            width={520}
            styles={{ body: { padding: 0 } }}
        >
            <div className="flex flex-col">
                <input
                    autoFocus
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t("commandPalette.placeholder")}
                    className="w-full border-0 border-b border-stone-200 bg-transparent px-4 py-3 text-sm outline-none placeholder:text-stone-400 dark:border-stone-800"
                    onKeyDown={(event) => {
                        if (event.key === "ArrowDown") {
                            event.preventDefault();
                            setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
                        } else if (event.key === "ArrowUp") {
                            event.preventDefault();
                            setActiveIndex((index) => Math.max(index - 1, 0));
                        } else if (event.key === "Enter") {
                            event.preventDefault();
                            runActive(filtered[activeIndex]);
                        } else if (event.key === "Escape") {
                            setOpen(false);
                        }
                    }}
                />
                <div className="max-h-80 overflow-y-auto py-1">
                    {filtered.length === 0? (
                        <div className="px-4 py-6 text-center text-sm text-stone-400">{t("commandPalette.empty")}</div>
                    ): (
                        filtered.map((item, index) => (
                            <button
                                key={item.key}
                                type="button"
                                onMouseEnter={() => setActiveIndex(index)}
                                onClick={() => runActive(item)}
                                className={cn(
                                    "flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm transition",
                                    index === activeIndex? "bg-stone-100 text-stone-950 dark:bg-stone-800 dark:text-stone-100": "text-stone-600 dark:text-stone-300",
                                )}
                            >
                                <span className="truncate">{item.label}</span>
                                {item.hint? <span className="max-w-40 truncate text-xs text-stone-400">{item.hint}</span>: null}
                            </button>
                        ))
                    )}
                </div>
            </div>
        </Modal>
    );
}
