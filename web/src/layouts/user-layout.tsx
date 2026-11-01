import { lazy, Suspense, type ReactNode } from "react";

import { AppTopNav } from "@/components/layout/app-top-nav";

// Agent 面板（对话 / 队列 / 技能）体量很大，首屏不需要它，放到落地后再加载。
const AgentPanel = lazy(() => import("@/components/agent/agent-panel").then((mod) => ({ default: mod.AgentPanel })));
const AgentQueueView = lazy(() => import("@/components/agent/agent-queue-view").then((mod) => ({ default: mod.AgentQueueView })));

export default function UserLayout({ children }: { children: ReactNode }) {
    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppTopNav />
                <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            </div>
            <Suspense fallback={null}>
                <AgentPanel />
                <AgentQueueView />
            </Suspense>
        </div>
    );
}
