import type { AgentAttachment } from "./types.js";

/** 本轮附件的来源标记，用于区分「用户新上传」与「画布已有素材」。 */
export type TurnContextAttachment = { id: string; name: string; source?: "upload" | "canvas"; canvasNodeId?: string };

/**
 * 把本轮附件与生图通道状态追加到用户 prompt 之后。
 *
 * 两条规则都必须显式写清，否则 Codex 会退回默认行为：
 * 1. 画布已有素材禁止再走 canvas_create_attachment_nodes，避免画布上出现重复图片节点。
 * 2. 网页侧没有可用生图通道时，必须使用 Codex 内置 imagegen，否则画布生图会被静默拦截。
 */
export function buildTurnContextPrompt(prompt: string, attachments: TurnContextAttachment[], imageChannelReady: boolean) {
    const uploaded = attachments.filter((item) => item.source !== "canvas");
    const onCanvas = attachments.filter((item) => item.source === "canvas");
    const sections: string[] = [];
    if (attachments.length) {
        const list = attachments.map((item, index) => {
            const origin = item.source === "canvas" ? `画布已有素材，画布节点 nodeId=${JSON.stringify(item.canvasNodeId || "")}` : "用户本轮上传";
            return `${index + 1}. attachmentId=${item.id}, name=${JSON.stringify(item.name)}, 来源=${origin}`;
        }).join("\n");
        const rules: string[] = [];
        if (uploaded.length) rules.push("用户本轮上传的图片：需要放入画布或作为生成参考图时，先调用 canvas_create_attachment_nodes，再使用返回的画布节点 ID 创建生成流程。");
        if (onCanvas.length) rules.push(`画布已有素材（共 ${onCanvas.length} 个）：这些图片已经在当前画布上，直接把它们上面的 nodeId 作为参考节点使用；禁止对它们调用 canvas_create_attachment_nodes——那会在画布上产生完全重复的图片节点。`);
        sections.push(`本轮可用图片附件（顺序与图片输入一致）：\n${list}\n${rules.join("\n")}`);
    }
    if (!imageChannelReady) {
        sections.push("当前网页没有可用的生图通道（未配置图片模型的 Base URL / API Key）：任何需要产出图片的任务必须使用 Codex 内置 imagegen 技能完成，不要调用 canvas_generate_image、canvas_generate_image_prompt_flow 或 canvas_run_generation——它们会被网页侧拦截并且不会产出任何图片。内置生图完成后，其结果会由 Canvas Agent 自动展示到对话并插入当前画布。");
    }
    if (!sections.length) return prompt;
    return `${prompt}\n\n${sections.join("\n\n")}`;
}

/** 把桥收到的附件请求归一化为 turn context 需要的形状。 */
export function turnContextAttachments(attachments: AgentAttachment[]): TurnContextAttachment[] {
    return attachments.flatMap((item, index) => {
        const id = item.id?.trim() || `attachment-${index + 1}`;
        return [{ id, name: item.name?.trim() || `图片 ${index + 1}`, ...(item.source === "canvas" ? { source: "canvas" as const } : {}), ...(item.canvasNodeId ? { canvasNodeId: item.canvasNodeId } : {}) }];
    });
}
