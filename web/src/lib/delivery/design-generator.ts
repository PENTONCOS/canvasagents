// WO-01: 设计稿生成器。
// 参考产品在画布上并排给出三版「能看的高保真稿」，选一版再投喂给编码 Agent。
// 这里不调用模型：从需求文本生成三份**可渲染的**独立 HTML（内联样式、无外部资源），
// 保证「新建一个设计稿节点」立刻有内容可看；Agent 后续可以用真实产出覆盖 variant.html。
import type { DesignVariant } from "@/types/delivery";

export type DesignBrief = {
    /** 需求/旅程标题，优先来自选中的需求便签 */
    title?: string;
    /** 需求正文，用来补足标题和列表文案 */
    statement?: string;
    /** 所属旅程标题（有则放进顶部副标题） */
    journeyTitle?: string;
};

export type GeneratedVariant = {
    label: "A" | "B" | "C";
    html: string;
    style: string;
    notes: string;
};

const MAX_TITLE = 16;

function escapeHtml(value: string) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function firstClause(text: string) {
    return text
        .split(/[\n。；;，,]/)
        .map((part) => part.trim())
        .find((part) => part.length > 0) || "";
}

/** 从需求文本里取一个像 App 名的短标题（去掉「做一个/帮我/需要」这类口头前缀）。 */
export function designTitleFromBrief(brief: DesignBrief) {
    const raw = (brief.statement || "").trim();
    const source = (brief.title || "").trim() || firstClause(raw) || "未命名需求";
    const cleaned = source
        .replace(/^(帮我|请|需要|想要|我要|做一个|做个|实现一个|实现|开发一个|开发)\s*/g, "")
        .replace(/[「」“”"'《》]/g, "")
        .trim();
    const base = cleaned || source;
    return base.length > MAX_TITLE ? `${base.slice(0, MAX_TITLE)}…` : base;
}

/** 从需求正文里抽 3 条像样的功能点；不够就用通用项补齐，绝不出现占位符文字。 */
function featureLines(brief: DesignBrief) {
    const text = `${brief.statement || ""}`;
    const parts = text
        .split(/[\n。；;]/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 4 && part.length <= 28);
    const fallback = ["查看全部内容", "快速完成下单", "随时查看进度"];
    const lines: string[] = [];
    for (const part of parts) {
        if (lines.length >= 3) break;
        if (!lines.includes(part)) lines.push(part);
    }
    for (const item of fallback) {
        if (lines.length >= 3) break;
        if (!lines.includes(item)) lines.push(item);
    }
    return lines.slice(0, 3);
}

function shell(options: {
    title: string;
    subtitle: string;
    accent: string;
    background: string;
    text: string;
    muted: string;
    body: string;
    label: string;
}) {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=390, initial-scale=1">
<title>${escapeHtml(options.title)} · 方案 ${options.label}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:390px;min-height:844px;background:${options.background};color:${options.text};font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
  body{display:flex;flex-direction:column;padding:20px 18px 0}
  .status{display:flex;justify-content:space-between;font-size:11px;color:${options.muted};margin-bottom:14px}
  h1{font-size:22px;line-height:1.3;letter-spacing:-.2px}
  .sub{margin-top:6px;font-size:12px;color:${options.muted}}
  .spacer{flex:1}
  .cta{position:sticky;bottom:0;margin:18px -18px 0;padding:14px 18px 22px;background:${options.accent};color:#fff;font-size:15px;font-weight:600;text-align:center}
  .row{display:flex;align-items:center;gap:12px;padding:14px 0}
  .dot{width:10px;height:10px;border-radius:50%;background:${options.accent};flex:none}
  .row b{font-size:14px;font-weight:600}
  .row span{display:block;margin-top:3px;font-size:12px;color:${options.muted}}
</style>
</head>
<body>
  <div class="status"><span>9:41</span><span>方案 ${options.label}</span></div>
  <h1>${escapeHtml(options.title)}</h1>
  <div class="sub">${escapeHtml(options.subtitle)}</div>
  ${options.body}
  <div class="spacer"></div>
  <div class="cta">立即开始</div>
</body>
</html>`;
}

function variantA(title: string, subtitle: string, features: string[], note: string): GeneratedVariant {
    const rows = features
        .map(
            (feature, index) => `<div class="row"><div class="dot"></div><div><b>${escapeHtml(feature)}</b><span>第 ${index + 1} 步 · 点击进入</span></div></div>`,
        )
        .join("\n  ");
    const html = shell({
        title,
        subtitle,
        accent: "#2f6bff",
        background: "#ffffff",
        text: "#1b1d22",
        muted: "#8b909a",
        label: "A",
        body: `<div class="cards" style="margin-top:22px;border-top:1px solid #eef0f4">${rows}</div>
  <div style="margin-top:18px;padding:16px;border-radius:16px;background:#f5f8ff">
    <div style="font-size:13px;font-weight:600">为你推荐</div>
    <div style="margin-top:8px;font-size:12px;color:#8b909a">${escapeHtml(features[0])}</div>
  </div>`,
    });
    return { label: "A", html, style: "清爽白 · 卡片列表优先 · #2f6bff", notes: note };
}

function variantB(title: string, subtitle: string, features: string[], note: string): GeneratedVariant {
    const rows = features
        .map(
            (feature) => `<div style="display:flex;justify-content:space-between;padding:13px 0;border-bottom:1px solid #22262e">
      <span style="font-size:13px">${escapeHtml(feature)}</span><span style="color:#22c55e;font-size:12px">查看</span>
    </div>`,
        )
        .join("\n    ");
    const html = shell({
        title,
        subtitle,
        accent: "#22c55e",
        background: "#0f1115",
        text: "#f3f5f7",
        muted: "#7b828e",
        label: "B",
        body: `<div style="margin-top:20px;height:210px;border-radius:18px;background:linear-gradient(135deg,#1d2a22,#0f1115 65%),radial-gradient(circle at 70% 20%,#22c55e55,transparent 60%)"></div>
  <div style="margin-top:18px">
    ${rows}
  </div>`,
    });
    return { label: "B", html, style: "深色 · 大图优先 · #22c55e", notes: note };
}

function variantC(title: string, subtitle: string, features: string[], note: string): GeneratedVariant {
    const steps = features
        .map(
            (feature, index) => `<div style="display:flex;gap:12px;padding:12px 0">
      <div style="width:24px;height:24px;border-radius:50%;background:#e2582b;color:#fff;font-size:12px;display:grid;place-items:center;flex:none">${index + 1}</div>
      <div><b style="font-size:13px">${escapeHtml(feature)}</b><div style="font-size:12px;color:#9a8f86;margin-top:2px">填写后自动保存</div></div>
    </div>`,
        )
        .join("\n    ");
    const html = shell({
        title,
        subtitle,
        accent: "#e2582b",
        background: "#fdfbf7",
        text: "#2b2622",
        muted: "#9a8f86",
        label: "C",
        body: `<div style="margin-top:22px;padding:18px;border-radius:18px;background:#fff;border:1px solid #f0e7dd">
    ${steps}
    <div style="margin-top:6px;height:40px;border-radius:12px;background:#f7f2ec;display:flex;align-items:center;padding:0 12px;font-size:12px;color:#9a8f86">输入你的需求…</div>
  </div>`,
    });
    return { label: "C", html, style: "暖色 · 分步表单优先 · #e2582b", notes: note };
}

/** 生成三版设计稿；顺序固定 A/B/C，语义稳定（A 已默认选中）。 */
export function generateDesignVariants(brief: DesignBrief = {}): GeneratedVariant[] {
    const title = designTitleFromBrief(brief);
    const features = featureLines(brief);
    const subtitle = brief.journeyTitle?.trim() || brief.statement?.trim().slice(0, 40) || "先看清主流程，再动手实现";
    return [
        variantA(title, subtitle, features, "白底卡片，信息密度高，适合工具型首页"),
        variantB(title, subtitle, features, "深色大图，突出内容视觉，适合展示型首页"),
        variantC(title, subtitle, features, "暖色分步，强调录入与确认，适合表单型流程"),
    ];
}

/** 旧数据补内容时用：按已有 variant 生成一版稳的稿，避免节点继续空着。 */
export function backfillVariantHtml(variant: Pick<DesignVariant, "label" | "style">, brief: DesignBrief = {}) {
    const all = generateDesignVariants(brief);
    return all.find((item) => item.label === variant.label)?.html || all[0].html;
}
