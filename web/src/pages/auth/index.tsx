import { App, Button, Form, Input, Segmented } from "antd";
import { ArrowLeft, Cloud, LogIn, RefreshCw, ShieldCheck, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { APP_NAME } from "@/constant/brand";
import { APP_VERSION } from "@/constant/env";
import { loginAccount, registerAccount } from "@/services/account-auth";
import { useAccountStore } from "@/stores/use-account-store";

type AuthMode = "login" | "register";

function BrandMark({ className }: { className?: string }) {
    return (
        <span
            className={className}
            style={{
                mask: "url(/logo.svg) center / contain no-repeat",
                WebkitMask: "url(/logo.svg) center / contain no-repeat",
            }}
        />
    );
}

/**
 * Dedicated sign-in / sign-up page. The account is a first-class dimension, so it
 * gets its own full-page surface instead of hiding inside the settings dialog.
 *
 * Layout notes (why it is written this way):
 * - The brand panel is a fixed dark surface in BOTH themes, so contrast never
 *   depends on the light/dark inversion and the logo stays legible.
 * - The login/register switcher is antd `Segmented`, so the active state comes
 *   from the design system instead of hand-rolled background/text pairs.
 */
export default function AuthPage({ mode: initialMode = "login" }: { mode?: AuthMode }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const token = useAccountStore((state) => state.token);
    const [mode, setMode] = useState<AuthMode>(initialMode);
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        setMode(initialMode);
    }, [initialMode]);

    // Already signed in: the page has nothing to do, continue into the app.
    useEffect(() => {
        if (token) navigate("/canvas", { replace: true });
    }, [token, navigate]);

    const switchMode = (next: AuthMode) => {
        setMode(next);
        navigate(next === "login" ? "/login" : "/register", { replace: true });
    };

    const submit = async () => {
        if (!username.trim() || !password) {
            message.error(t("auth.credentialsRequired"));
            return;
        }
        if (mode === "register" && password.length < 6) {
            message.error(t("auth.passwordTooShort"));
            return;
        }
        setBusy(true);
        try {
            if (mode === "register") await registerAccount(username.trim(), password, displayName.trim());
            else await loginAccount(username.trim(), password);
            message.success(t(mode === "register" ? "config.account.registered" : "config.account.loggedIn"));
            navigate("/canvas", { replace: true });
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.account.authFailed"));
        } finally {
            setBusy(false);
        }
    };

    const features = [
        { icon: <Cloud className="size-4 shrink-0" />, text: t("auth.featureSync") },
        { icon: <RefreshCw className="size-4 shrink-0" />, text: t("auth.featureDevices") },
        { icon: <ShieldCheck className="size-4 shrink-0" />, text: t("auth.featurePrivate") },
    ];

    const brandMark = (
        // `!` is load-bearing: antd injects an UNLAYERED `:where(.css-x) a { color: var(--ant-color-link) }`,
        // and unlayered rules outrank Tailwind's @layer utilities. Without `!` the wordmark inherits
        // antd's link colour — near-black in light mode — and vanishes into this black panel.
        <Link to="/canvas" className="inline-flex items-center gap-2 text-sm font-semibold tracking-tight text-stone-100!">
            <BrandMark className="size-5 shrink-0 bg-current" />
            {APP_NAME}
        </Link>
    );

    return (
        <div className="flex min-h-dvh flex-col bg-background text-foreground">
            <main className="flex flex-1 items-center justify-center bg-background bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-6 py-12 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)]">
                <section className="w-full max-w-4xl overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm md:grid md:grid-cols-2 dark:border-stone-700/60 dark:bg-stone-900 dark:shadow-xl dark:shadow-black/50">
                    <aside className="hidden flex-col gap-10 bg-stone-950 p-8 text-stone-100 md:flex">
                        {brandMark}
                        <div className="my-auto space-y-6">
                            <div>
                                <h1 className="text-2xl font-semibold leading-snug">{t("auth.sideTitle")}</h1>
                                <p className="mt-3 max-w-[30ch] text-sm leading-6 text-stone-400">{t("auth.sideDescription")}</p>
                            </div>
                            <ul className="space-y-3 text-sm text-stone-300">
                                {features.map((feature) => (
                                    <li key={feature.text} className="flex items-center gap-2.5">
                                        {feature.icon}
                                        {feature.text}
                                    </li>
                                ))}
                            </ul>
                        </div>
                        <div className="text-xs text-stone-400">
                            {APP_NAME} {APP_VERSION}
                        </div>
                    </aside>

                    <div className="flex flex-col p-8">
                        <div className="mb-6 md:hidden">
                            <Link to="/canvas" className="inline-flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground!">
                                <BrandMark className="size-5 shrink-0 bg-current" />
                                {APP_NAME}
                            </Link>
                        </div>

                        <Segmented
                            block
                            className="auth-switcher"
                            value={mode}
                            onChange={(value) => switchMode(value as AuthMode)}
                            options={[
                                { label: t("auth.login"), value: "login" },
                                { label: t("auth.register"), value: "register" },
                            ]}
                        />

                        <div className="mt-6 mb-5">
                            <h2 className="text-lg font-semibold">{t(mode === "login" ? "auth.welcome" : "auth.createTitle")}</h2>
                            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                                {t(mode === "login" ? "auth.subtitle" : "auth.createSubtitle")}
                            </p>
                        </div>

                        <Form layout="vertical" requiredMark={false} onFinish={() => void submit()}>
                            <Form.Item label={t("auth.username")} className="mb-4">
                                <Input
                                    size="large"
                                    value={username}
                                    autoComplete="username"
                                    placeholder={t("auth.usernamePlaceholder")}
                                    onChange={(event) => setUsername(event.target.value)}
                                />
                            </Form.Item>
                            <Form.Item label={t("auth.password")} className="mb-4">
                                <Input.Password
                                    size="large"
                                    value={password}
                                    autoComplete={mode === "register" ? "new-password" : "current-password"}
                                    placeholder={t("auth.passwordPlaceholder")}
                                    onChange={(event) => setPassword(event.target.value)}
                                />
                            </Form.Item>
                            {mode === "register" ? (
                                <Form.Item label={t("auth.displayName")} className="mb-4">
                                    <Input
                                        size="large"
                                        value={displayName}
                                        placeholder={t("auth.displayNamePlaceholder")}
                                        onChange={(event) => setDisplayName(event.target.value)}
                                    />
                                </Form.Item>
                            ) : null}
                            <Button
                                type="primary"
                                size="large"
                                block
                                htmlType="submit"
                                loading={busy}
                                icon={mode === "register" ? <UserPlus className="size-4" /> : <LogIn className="size-4" />}
                            >
                                {t(mode === "register" ? "auth.registerAction" : "auth.loginAction")}
                            </Button>
                        </Form>

                        <div className="mt-5 flex items-center justify-between gap-4 text-xs">
                            <Link
                                to="/canvas"
                                className="inline-flex items-center gap-1 text-stone-500! transition hover:text-stone-900! dark:text-stone-400! dark:hover:text-stone-100!"
                            >
                                <ArrowLeft className="size-3.5" />
                                {t("auth.backToCanvas")}
                            </Link>
                            <button
                                type="button"
                                className="cursor-pointer text-stone-500 transition hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
                                onClick={() => switchMode(mode === "login" ? "register" : "login")}
                            >
                                {t(mode === "login" ? "auth.noAccount" : "auth.haveAccount")}
                            </button>
                        </div>
                    </div>
                </section>
            </main>
        </div>
    );
}
