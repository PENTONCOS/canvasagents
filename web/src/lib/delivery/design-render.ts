// WO-01: 设计稿预览取值。
// 节点只认「这版有没有内容」和「内容是 HTML 还是图片」，渲染细节由节点组件决定。
import type { DesignVariant } from "@/types/delivery";

export type DesignPreviewKind = "html" | "image" | "empty";

export function designPreviewKind(variant?: Partial<DesignVariant> | null): DesignPreviewKind {
    if (!variant) return "empty";
    if (typeof variant.html === "string" && variant.html.trim().length > 0) return "html";
    if (typeof variant.imageUrl === "string" && variant.imageUrl.trim().length > 0) return "image";
    return "empty";
}

/** iframe srcdoc 只接受完整文档；老数据里如果存的是 HTML 片段，这里补一层壳。 */
export function designPreviewDoc(variant?: Partial<DesignVariant> | null): string {
    if (!variant) return "";
    if (typeof variant.html === "string" && variant.html.trim()) {
        const html = variant.html.trim();
        return /^<!doctype|^<html/i.test(html) ? html : designFallbackDoc(variant.label || "A", html);
    }
    if (typeof variant.imageUrl === "string" && variant.imageUrl.trim()) return designFallbackDoc(variant.label || "A", "");
    return "";
}

/** 没有 html 也没有图片时的兜底文档：只说明这一版还没有产出，不伪造设计内容。 */
export function designFallbackDoc(label: string, inner: string) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  html,body{height:100%;margin:0;background:#f7f7f9;color:#6b7280;font-family:-apple-system,"PingFang SC",sans-serif}
  body{display:grid;place-items:center;text-align:center;padding:24px}
  b{display:block;color:#242529;font-size:14px;margin-bottom:6px}
  span{font-size:12px;line-height:1.6}
</style></head><body><div><b>方案 ${label}</b><span>${inner ? "这一版只存了片段内容，等待重新生成完整设计稿。" : "还没有设计稿内容，选中后可以让 Agent 产出这一版。"}</span></div></body></html>`;
}
