/**
 * WO-10: 跟随节点的「产出回流」。
 *
 * 之前节点上贴的是窗口最后一条回复的前 32 字，属于聊天气泡摘要，不是产物。
 * 这里从真实输出里抽取可核对的东西：改了哪些文件、测试通过/失败数、是否部署。
 * 抽不到就返回 null，节点不贴假信息。
 */
import type { AgentChatItem } from "@/stores/use-agent-store";

// 前后用「非单词字符」界定，兼容中文分隔（和、，）与 markdown 反引号；
// 之前只写了半角分隔符，导致「和 src/b.tsx，」这种情况漏抓。
const FILE_PATTERN = /(?:^|[^\w/])((?:[\w@.-]+\/)*[\w@.-]+\.(?:tsx?|jsx?|css|scss|md|json|ya?ml|html))(?=[^\w]|$)/g;
const PASS_PATTERN = /(\d+)\s*(?:passed|通过)/gi;
const FAIL_PATTERN = /(\d+)\s*(?:failed|失败)/gi;

export type WindowOutputSummary = {
    files: string[];
    passed?: number;
    failed?: number;
    text: string;
};

function lastAssistantText(messages: AgentChatItem[]) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const item = messages[index];
        if (item.role === "assistant" && typeof item.text === "string" && item.text.trim()) return item.text;
    }
    return "";
}

/** 抽取一份可展示的产物摘要；没有可识别产物时返回 null。 */
export function summarizeWindowOutput(messages: AgentChatItem[]): WindowOutputSummary | null {
    const text = lastAssistantText(messages);
    if (!text) return null;

    const files = Array.from(new Set(Array.from(text.matchAll(FILE_PATTERN), (match) => match[1]))).slice(0, 6);

    let passed: number | undefined;
    let failed: number | undefined;
    for (const match of text.matchAll(PASS_PATTERN)) passed = Number(match[1]);
    for (const match of text.matchAll(FAIL_PATTERN)) failed = Number(match[1]);

    const parts: string[] = [];
    if (files.length) parts.push(`${files.length} 文件`);
    if (typeof passed === "number" || typeof failed === "number") {
        parts.push(`${passed ?? 0}/${(passed ?? 0) + (failed ?? 0)} 通过`);
    }
    if (!parts.length) return null;
    return { files, passed, failed, text: parts.join(" · ") };
}
