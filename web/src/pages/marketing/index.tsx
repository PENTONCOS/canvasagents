import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight, BookOpen, Check, Sparkles } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

/**
 * 定价页（M5 商业化）。静态页：价格与套餐写在代码里，接入支付属于后续工作。
 * 明确标注「当前为演示定价」——避免看起来像真在收钱。
 */

type Plan = {
    id: "free" | "pro" | "team";
    highlight?: boolean;
};

const PLANS: Plan[] = [{ id: "free" }, { id: "pro", highlight: true }, { id: "team" }];

export function MarketingNav() {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <header className="flex items-center justify-between border-b px-6 py-4" style={{ borderColor: theme.node.stroke }}>
            <Link to="/" className="flex items-center gap-2 text-sm font-semibold" style={{ color: theme.node.text }}>
                <Sparkles className="size-4" />CanvasAgents
            </Link>
            <nav className="flex items-center gap-4 text-sm" style={{ color: theme.node.muted }}>
                <Link to="/pricing" className="hover:underline">{t("marketing.nav.pricing")}</Link>
                <Link to="/courses" className="hover:underline">{t("marketing.nav.courses")}</Link>
                <Link to="/canvas" className="hover:underline">{t("marketing.nav.app")}</Link>
            </nav>
        </header>
    );
}

export default function PricingPage() {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <div className="min-h-screen" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <MarketingNav />
            <main className="mx-auto max-w-5xl px-6 py-16">
                <h1 className="text-3xl font-semibold">{t("marketing.pricing.title")}</h1>
                <p className="mt-3 max-w-2xl text-sm leading-6" style={{ color: theme.node.muted }}>{t("marketing.pricing.subtitle")}</p>
                <div className="mt-10 grid gap-4 md:grid-cols-3">
                    {PLANS.map((plan) => {
                        const features = t(`marketing.pricing.plans.${plan.id}.features`, { returnObjects: true }) as unknown;
                        const list = Array.isArray(features) ? (features as string[]) : [];
                        return (
                            <section
                                key={plan.id}
                                className="flex flex-col rounded-lg border p-5"
                                style={{ borderColor: plan.highlight ? theme.accent : theme.node.stroke, background: theme.node.fill }}
                            >
                                <div className="text-sm font-semibold">{t(`marketing.pricing.plans.${plan.id}.name`)}</div>
                                <div className="mt-3 flex items-baseline gap-1">
                                    <span className="text-2xl font-semibold">{t(`marketing.pricing.plans.${plan.id}.price`)}</span>
                                    <span className="text-xs" style={{ color: theme.node.muted }}>{t(`marketing.pricing.plans.${plan.id}.period`)}</span>
                                </div>
                                <ul className="mt-4 flex-1 space-y-2 text-xs leading-5" style={{ color: theme.node.muted }}>
                                    {list.map((feature) => (
                                        <li key={feature} className="flex gap-2">
                                            <Check className="mt-0.5 size-3.5 shrink-0" style={{ color: theme.accent }} />
                                            <span>{feature}</span>
                                        </li>
                                    ))}
                                </ul>
                                <Link
                                    to={plan.id === "free" ? "/register" : "/canvas"}
                                    className="mt-5 inline-flex items-center justify-center gap-1 rounded-md px-3 py-2 text-xs font-medium"
                                    style={{ background: theme.accent, color: "#fff" }}
                                >
                                    {t(`marketing.pricing.plans.${plan.id}.cta`)}
                                    <ArrowRight className="size-3.5" />
                                </Link>
                            </section>
                        );
                    })}
                </div>
                <p className="mt-8 text-xs" style={{ color: theme.node.faint }}>{t("marketing.pricing.note")}</p>
            </main>
        </div>
    );
}

type Course = { id: string; lessons: number; minutes: number };

const COURSES: Course[] = [
    { id: "basics", lessons: 8, minutes: 96 },
    { id: "delivery", lessons: 12, minutes: 180 },
    { id: "automation", lessons: 10, minutes: 150 },
];

export function CoursesPage() {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <div className="min-h-screen" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <MarketingNav />
            <main className="mx-auto max-w-4xl px-6 py-16">
                <h1 className="text-3xl font-semibold">{t("marketing.courses.title")}</h1>
                <p className="mt-3 max-w-2xl text-sm leading-6" style={{ color: theme.node.muted }}>{t("marketing.courses.subtitle")}</p>
                <div className="mt-10 space-y-3">
                    {COURSES.map((course) => (
                        <article key={course.id} className="flex items-start gap-4 rounded-lg border p-4" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                            <BookOpen className="mt-0.5 size-4 shrink-0" style={{ color: theme.accent }} />
                            <div className="min-w-0 flex-1">
                                <div className="text-sm font-semibold">{t(`marketing.courses.items.${course.id}.title`)}</div>
                                <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>{t(`marketing.courses.items.${course.id}.description`)}</div>
                                <div className="mt-2 text-[11px]" style={{ color: theme.node.faint }}>
                                    {t("marketing.courses.meta", { lessons: course.lessons, minutes: course.minutes })}
                                </div>
                            </div>
                            <Link to="/canvas" className="shrink-0 rounded-md border px-3 py-1.5 text-xs" style={{ borderColor: theme.node.stroke }}>
                                {t("marketing.courses.cta")}
                            </Link>
                        </article>
                    ))}
                </div>
            </main>
        </div>
    );
}
