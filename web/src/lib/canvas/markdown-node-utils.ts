// A1: Markdown 节点。正文只存在 metadata.content 一处：
// - 画布持久化（use-canvas-store 整体存 nodes）；
// - Agent 快照（snapshot 直接带 metadata，canvas_get_state 预览、canvas_get_node 读全文）。
// 这个模块只放纯函数，方便单测覆盖编辑器状态栏与空状态判断。
export const MARKDOWN_NODE_TYPE = "markdown";

export type MarkdownDocStats = {
    characters: number;
    lines: number;
    headings: number;
};

/** 编辑器状态栏统计：标题只数围栏代码块外的 ATX 标题，避免把代码里的 `#` 当成标题。 */
export function markdownDocStats(source: string): MarkdownDocStats {
    const text = typeof source === "string" ? source : "";
    const normalized = text.replace(/\r\n?/g, "\n");
    if (!normalized.length) return { characters: 0, lines: 0, headings: 0 };
    const lines = normalized.split("\n");
    let headings = 0;
    let inFence = false;
    let fenceMarker = "";
    for (const line of lines) {
        const trimmed = line.trimStart();
        const fence = /^(`{3,}|~{3,})/.exec(trimmed);
        if (fence) {
            const marker = fence[1][0];
            if (!inFence) {
                inFence = true;
                fenceMarker = marker;
            } else if (marker === fenceMarker) {
                inFence = false;
                fenceMarker = "";
            }
            continue;
        }
        if (!inFence && /^#{1,6}\s+\S/.test(trimmed)) headings += 1;
    }
    return { characters: normalized.length, lines: lines.length, headings };
}

/** 空状态判断：只剩空白也算空，节点要给出「开始写」的入口而不是一片空白。 */
export function isMarkdownBlank(source: string | undefined | null): boolean {
    return !String(source ?? "").trim();
}
