// WO-02: 需求 → 旅程/步骤的结构化梳理。
// 参考产品的第 1-2 幕：一句话需求被拆成「3 条旅程 · 若干屏原型」，平铺在画布上。
// 这里不调用模型：把需求正文按句子切成原子动作，再按「核心流程 / 异常边界 / 管理回顾」
// 三类归位，每一步产出一个小屏原型。规则是显式的、可测的；Agent 后续可以用真实产出覆盖。
import type { DesignBrief } from "@/lib/delivery/design-generator";
import { designTitleFromBrief } from "@/lib/delivery/design-generator";

export type PlannedJourney = {
    title: string;
    steps: string[];
};

const CORE_HINTS = /(进入|打开|选择|填写|搜索|浏览|下单|预约|提交|确认|支付|完成|创建|添加)/;
const EDGE_HINTS = /(失败|超时|取消|异常|错误|重试|拦截|校验|重复|不足|冲突|回滚)/;
const ADMIN_HINTS = /(管理|统计|记录|设置|历史|导出|通知|审核|配置|报表|权限)/;

function escapeHtml(value: string) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 需求正文 → 原子动作短句。太长的句子再按逗号切一次，最短 4 字，避免「步骤 1」这类空话。 */
export function requirementClauses(statement: string) {
    const raw = (statement || "")
        .split(/[\n。；;]/)
        .flatMap((part) => (part.length > 26 ? part.split(/[，,]/) : [part]))
        .map((part) => part.replace(/^[\s\-·•\d.、]+/, "").trim())
        .filter((part) => part.length >= 4 && part.length <= 30);
    return Array.from(new Set(raw));
}

function pick(clauses: string[], hints: RegExp, limit: number) {
    return clauses.filter((clause) => hints.test(clause)).slice(0, limit);
}

function trimStep(title: string) {
    return title.length > 18 ? `${title.slice(0, 18)}…` : title;
}

/**
 * 把一条需求梳理成三条旅程。句子归属按关键词；某条旅程没有命中素材时，
 * 用该旅程的标准动作补齐 —— 补的是**流程动作**，不是「步骤 N」这种占位文字。
 */
export function planJourneys(brief: DesignBrief = {}): PlannedJourney[] {
    const clauses = requirementClauses(brief.statement || "");
    const core = pick(clauses, CORE_HINTS, 4);
    const edge = pick(clauses, EDGE_HINTS, 3);
    const admin = pick(clauses, ADMIN_HINTS, 3);
    const coreFallback = ["进入首页", "选择目标内容", "确认并提交", "查看结果"];
    const edgeFallback = ["输入不合法时的提示", "重复提交拦截", "网络超时重试"];
    const adminFallback = ["查看历史记录", "修改与撤销", "接收结果通知"];
    const fill = (hits: string[], fallback: string[]) => {
        const merged = [...hits, ...fallback.filter((item) => !hits.includes(item))];
        return Array.from(new Set(merged)).slice(0, Math.max(3, hits.length));
    };
    return [
        { title: "核心流程", steps: fill(core, coreFallback).map(trimStep) },
        { title: "异常与边界", steps: fill(edge, edgeFallback).map(trimStep) },
        { title: "管理与回顾", steps: fill(admin, adminFallback).map(trimStep) },
    ];
}

/** 每一步的原型屏：一个小尺寸移动端画面，标题来自步骤本身。 */
export function stepScreenHtml(stepTitle: string, journeyTitle: string, accent = "#2f6bff") {
    const title = designTitleFromBrief({ title: stepTitle }) || stepTitle;
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=240"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:240px;height:360px;background:#fff;color:#1b1d22;font-family:-apple-system,"PingFang SC",sans-serif;overflow:hidden}
  body{display:flex;flex-direction:column;padding:12px}
  .bar{display:flex;justify-content:space-between;font-size:8px;color:#9aa0aa;margin-bottom:8px}
  .crumb{font-size:8px;color:${accent};font-weight:600;margin-bottom:4px}
  h1{font-size:14px;line-height:1.35}
  .card{margin-top:10px;border:1px solid #eef0f4;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px}
  .line{height:7px;border-radius:4px;background:#f0f2f6}
  .line.w70{width:70%}.line.w45{width:45%}
  .field{height:24px;border-radius:8px;background:#f7f8fb;border:1px solid #eef0f4;display:flex;align-items:center;padding:0 8px;font-size:9px;color:#9aa0aa}
  .cta{margin-top:auto;height:30px;border-radius:9px;background:${accent};color:#fff;font-size:10px;font-weight:600;display:grid;place-items:center}
</style></head><body>
  <div class="bar"><span>9:41</span><span>原型</span></div>
  <div class="crumb">${escapeHtml(journeyTitle)}</div>
  <h1>${escapeHtml(title)}</h1>
  <div class="card"><div class="line"></div><div class="line w70"></div><div class="field">${escapeHtml(stepTitle)}</div><div class="line w45"></div></div>
  <div class="cta">下一步</div>
</body></html>`;
}
