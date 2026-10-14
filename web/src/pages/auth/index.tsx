import { App, Button, Form, Input } from "antd";
import { ArrowLeft, Cloud, LogIn, RefreshCw, ShieldCheck, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { APP_NAME } from "@/constant/brand";
import { APP_VERSION } from "@/constant/env";
import { loginAccount, registerAccount } from "@/services/account-auth";
import { useAccountStore } from "@/stores/use-account-store";
import { cn } from "@/lib/utils";

type AuthMode = "login" | "register";

/**
 * Dedicated sign-in / sign-up page. The account is a first-class dimension, so it
 * gets its own full-page surface instead of hiding inside the settings dialog.
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
        { icon: <Cloud className="size-4" />, text: t("auth.featureSync") },
        { icon: <RefreshCw className="size-4" />, text: t("auth.featureDevices") },
        { icon: <ShieldCheck className="size-4" />, text: t("auth.featurePrivate") },
    ];

    return (
        <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
            <main className="flex h-full min-h-0 items-center justify-center overflow-y-auto bg-background bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-6 py-10 text-stone-900 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.16)_1px,transparent_1px)] dark:text-stone-100">
                <section className="w-full max-w-3xl overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-stone-900 md:grid md:grid-cols-2">
                    <div className="hidden flex-col justify-between bg-stone-950 p-8 text-stone-100 md:flex dark:bg-stone-100 dark:text-stone-950">
                        <Link to="/canvas" className="inline-flex items-center gap-2 text-sm font-semibold tracking-tight">
                            <span
                                className="size-5 shrink-0 bg-current"
                                style={{
                                    mask: "url(/logo.svg) center / contain no-repeat",
                                    WebkitMask: "url(/logo.svg) center / contain no-repeat",
                                }}
                            />
                            {APP_NAME}
                        </Link>
                        <div>
                            <h1 className="text-2xl font-semibold leading-snug">{t("auth.sideTitle")}</h1>
                            <p className="mt-3 text-sm leading-6 opacity-70">{t("auth.sideDescription")}</p>
                            <ul className="mt-6 space-y-3 text-sm">
                                {features.map((feature) => (
                                    <li key={feature.text} className="flex items-center gap-2.5 opacity-80">
                                        {feature.icon}
                                        {feature.text}
                                    </li>
                                ))}
                            </ul>
                        </div>
                        <div className="text-xs opacity-50">{APP_NAME} v{APP_VERSION}</div>
                    </div>

                    <div className="p-8">
                        <div className="mb-6 md:hidden">
                            <Link to="/canvas" className="inline-flex items-center gap-2 text-sm font-semibold tracking-tight">
                                <span
                                    className="size-5 shrink-0 bg-current"
                                    style={{
                                        mask: "url(/logo.svg) center / contain no-repeat",
                                        WebkitMask: "url(/logo.svg) center / contain no-repeat",
                                    }}
                                />
                                {APP_NAME}
                            </Link>
                        </div>

                        <div className="mb-6 grid grid-cols-2 gap-1 rounded-lg border border-stone-200 p-1 dark:border-stone-800">
                            {(["login", "register"] as const).map((item) => (
                                <button
                                    key={item}
                                    type="button"
                                    onClick={() => switchMode(item)}
                                    className={cn(
                                        "h-9 cursor-pointer rounded-md text-sm font-medium transition",
                                        mode === item
                                            ? "bg-stone-950 text-white dark:bg-stone-100 dark:text-stone-950"
                                            : "text-stone-500 hover:text-stone-800 dark:hover:text-stone-200",
                                    )}
                                >
                                    {t(item === "login" ? "auth.login" : "auth.register")}
                                </button>
                            ))}
                        </div>

                        <div className="mb-5">
                            <h2 className="text-lg font-semibold">{t(mode === "login" ? "auth.welcome" : "auth.createTitle")}</h2>
                            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{t("auth.subtitle")}</p>
                        </div>

                        <Form layout="vertical" requiredMark={false}>
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
                                    onPressEnter={() => void submit()}
                                />
                            </Form.Item>
                            {mode === "register" ? (
                                <Form.Item label={t("auth.displayName")} className="mb-4">
                                    <Input
                                        size="large"
                                        value={displayName}
                                        placeholder={t("auth.displayNamePlaceholder")}
                                        onChange={(event) => setDisplayName(event.target.value)}
                                        onPressEnter={() => void submit()}
                                    />
                                </Form.Item>
                            ) : null}
                            <Button
                                type="primary"
                                size="large"
                                block
                                loading={busy}
                                icon={mode === "register" ? <UserPlus className="size-4" /> : <LogIn className="size-4" />}
                                onClick={() => void submit()}
                            >
                                {t(mode === "register" ? "auth.registerAction" : "auth.loginAction")}
                            </Button>
                        </Form>

                        <div className="mt-6 flex items-center justify-between text-xs">
                            <Link to="/canvas" className="inline-flex items-center gap-1 text-stone-500 transition hover:text-stone-800 dark:hover:text-stone-200">
                                <ArrowLeft className="size-3.5" />
                                {t("auth.backToCanvas")}
                            </Link>
                            <button
                                type="button"
                                className="cursor-pointer text-stone-500 transition hover:text-stone-800 dark:hover:text-stone-200"
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
