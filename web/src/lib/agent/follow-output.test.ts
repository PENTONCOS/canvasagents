import { describe, expect, test } from "bun:test";

import type { AgentChatItem } from "@/stores/use-agent-store";
import { summarizeWindowOutput } from "./follow-output";

function assistant(text: string): AgentChatItem {
    return { id: `a-${text.length}`, role: "assistant", text };
}

describe("summarizeWindowOutput", () => {
    test("抽出文件数与测试通过数", () => {
        const summary = summarizeWindowOutput([assistant("改好了 src/a.ts 和 src/b.tsx，pnpm test: 21 passed, 0 failed")]);
        expect(summary?.files).toEqual(["src/a.ts", "src/b.tsx"]);
        expect(summary?.passed).toBe(21);
        expect(summary?.failed).toBe(0);
        expect(summary?.text).toBe("2 文件 · 21/21 通过");
    });

    test("只有文件改动也能出摘要", () => {
        const summary = summarizeWindowOutput([assistant("更新了 web/src/app.css")]);
        expect(summary?.text).toBe("1 文件");
        expect(summary?.passed).toBeUndefined();
    });

    test("没有可识别产物时返回 null，不编数据", () => {
        expect(summarizeWindowOutput([assistant("好了，刷新页面就能看到")])).toBeNull();
        expect(summarizeWindowOutput([])).toBeNull();
    });

    test("取最后一条助手消息，忽略用户消息", () => {
        const summary = summarizeWindowOutput([
            { id: "u1", role: "user", text: "src/old.ts 21 passed" },
            assistant("done"),
        ]);
        expect(summary).toBeNull();
    });
});
