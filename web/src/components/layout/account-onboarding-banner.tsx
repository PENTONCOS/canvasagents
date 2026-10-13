import { Button } from "antd";
import { Cloud, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { APP_ID } from "@/constant/brand";
import { readStoredValue, writeStoredValue } from "@/lib/brand-migration";
import { useAccountStore } from "@/stores/use-account-store";
import { useConfigStore } from "@/stores/use-config-store";

const ONBOARDING_DISMISSED_KEY = `${APP_ID}:onboarding_dismissed`;

/**
 * Non-blocking invitation for logged-out visitors. It floats above the app,
 * never gates any action, and stays gone once dismissed.
 */
export function AccountOnboardingBanner() {
    const { t } = useTranslation();
    const token = useAccountStore((state) => state.token);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const [dismissed, setDismissed] = useState(() => readStoredValue(ONBOARDING_DISMISSED_KEY) === "1");

    if (token || dismissed) return null;

    const dismiss = () => {
        setDismissed(true);
        writeStoredValue(ONBOARDING_DISMISSED_KEY, "1");
    };

    return (
        <div className="fixed bottom-4 right-4 z-40 w-72 rounded-lg border border-stone-200 bg-background/95 p-3 shadow-lg backdrop-blur dark:border-stone-800">
            <div className="flex items-start gap-2">
                <Cloud className="mt-0.5 size-4 shrink-0 text-stone-500" />
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{t("accountOnboarding.title")}</div>
                    <div className="mt-1 text-xs text-stone-500">{t("accountOnboarding.description")}</div>
                    <div className="mt-2 flex items-center gap-2">
                        <Button type="primary" size="small" onClick={() => openConfigDialog(false, "account")}>
                            {t("accountOnboarding.action")}
                        </Button>
                        <Button type="text" size="small" className="!text-xs text-stone-500" onClick={dismiss}>
                            {t("accountOnboarding.dismiss")}
                        </Button>
                    </div>
                </div>
                <button
                    type="button"
                    className="shrink-0 text-stone-400 transition hover:text-stone-700 dark:hover:text-stone-200"
                    aria-label={t("accountOnboarding.dismiss")}
                    title={t("accountOnboarding.dismiss")}
                    onClick={dismiss}
                >
                    <X className="size-4" />
                </button>
            </div>
        </div>
    );
}
