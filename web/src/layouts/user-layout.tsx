import type { ReactNode } from "react";

import { AgentPanel } from "@/components/agent/agent-panel";
import { AgentQueueView } from "@/components/agent/agent-queue-view";
import { AppTopNav } from "@/components/layout/app-top-nav";

export default function UserLayout({ children }: { children: ReactNode }) {
    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppTopNav />
                <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            </div>
            {/* 面板不做懒加载：延迟挂载会让「连接后自动展开」的初始动画错过时机，
                面板停在视口外，e2e 里点「新建会话窗」这类动作会一直报 outside of the viewport。 */}
            <AgentPanel />
            <AgentQueueView />
        </div>
    );
}
