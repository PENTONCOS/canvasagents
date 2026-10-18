// M2: terminal window node. Talks to canvas-agent /terminal/ws; the backend side
// owns a pty-bridge process re-attached to a persistent macOS screen session, so
// terminals survive agent restarts and page reloads. Session id lives in node
// metadata (terminalSession) and is namespaced per canvas (canvas-<id>-<n>).
// G-CLI: 终端内核已抽到 ../agent/embedded-terminal.tsx，与 Agent 面板 CLI 模式共用。
import { useState } from "react";

import { SquareTerminal } from "lucide-react";
import { useParams } from "react-router-dom";

import i18n from "@/i18n";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { useAgentStore } from "@/stores/use-agent-store";
import { EmbeddedTerminal } from "@/components/agent/embedded-terminal";
import type { CanvasNodeContext, CanvasNodeDefinition } from "@/types/canvas-plugin";

export const TERMINAL_NODE_TYPE = "terminal";

function TerminalView({ ctx }: { ctx: CanvasNodeContext }) {
    const { id: routeId } = useParams<{ id?: string }>();
    const agentUrl = useAgentStore((state) => state.url);
    const agentToken = useAgentStore((state) => state.token);
    const [session, setSession] = useState(() => String(ctx.node.metadata?.terminalSession || ""));

    return (
        <EmbeddedTerminal
            agentUrl={agentUrl}
            agentToken={agentToken}
            canvasId={routeId || ""}
            session={session}
            onSession={(id) => {
                ctx.updateMetadata({ terminalSession: id });
                setSession(id);
            }}
        />
    );
}

export function terminalNodeDefinition(): CanvasNodeDefinition {
    return {
        type: TERMINAL_NODE_TYPE,
        title: i18n.t("canvas.nodeTypes.terminal"),
        icon: <SquareTerminal className="size-4" />,
        description: i18n.t("canvas.terminal.description"),
        minimapColor: "#22c55e",
        defaultSize: { width: 560, height: 380 },
        defaultMetadata: {},
        hasSourceHandle: false,
        hidePanel: true,
        interactionToggle: true,
        forceInteractive: () => true,
        Content: ({ ctx }) => <TerminalView ctx={ctx} />,
    };
}

let registered = false;
export function registerTerminalNode() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions([terminalNodeDefinition()], "builtin");
}
