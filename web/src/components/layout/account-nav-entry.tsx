import { App, Avatar, Button, Dropdown, type MenuProps } from "antd";
import { LogIn, LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { logoutAccount } from "@/services/account-auth";
import { useAccountStore } from "@/stores/use-account-store";
import { useConfigStore } from "@/stores/use-config-store";

function formatSyncedAt(value: string, locale: string) {
    return new Date(value).toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Account entry that lives in the top nav, so the account is a first-class dimension instead of a settings tab. */
export function AccountNavEntry() {
    const { message } = App.useApp();
    const { t, i18n } = useTranslation();
    const locale = i18n.language as string;
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const navigate = useNavigate();
    const token = useAccountStore((state) => state.token);
    const user = useAccountStore((state) => state.user);
    const lastSyncedAt = useAccountStore((state) => state.lastSyncedAt);

    if (!token) {
        return (
            <Button size="small" className="!h-8" icon={<LogIn className="size-4" />} onClick={() => navigate("/login")}>
                {t("topNav.signInRegister")}
            </Button>
        );
    }

    const name = user?.displayName || user?.username || t("config.account.notLoggedIn");
    const initial = (user?.username || name).trim().charAt(0).toUpperCase() || "?";
    const items: MenuProps["items"] = [
        { key: "account", disabled: true, label: t("config.account.signedInAs", { name }) },
        { key: "synced", disabled: true, label: lastSyncedAt ? t("config.account.lastSynced", { time: formatSyncedAt(lastSyncedAt, locale) }) : t("config.account.neverSynced") },
        { type: "divider" },
        { key: "settings", label: t("topNav.accountSettings") },
        { key: "logout", icon: <LogOut className="size-4" />, label: t("config.account.logout") },
    ];

    const onMenuClick: MenuProps["onClick"] = async ({ key }) => {
        if (key === "settings") {
            openConfigDialog(false, "account");
            return;
        }
        if (key !== "logout") return;
        try {
            await logoutAccount();
            message.success(t("config.account.loggedOut"));
        } catch (error) {
            // logoutAccount is best-effort and keeps the local session on failure.
            message.error(error instanceof Error ? error.message : t("config.account.authFailed"));
        }
    };

    return (
        <Dropdown menu={{ items, onClick: (info) => void onMenuClick(info) }} trigger={["click"]} placement="bottomRight">
            <button type="button" className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition hover:opacity-90" aria-label={t("topNav.account")} title={name}>
                <Avatar size={28} className="!bg-stone-900 !text-xs !font-medium !text-stone-50 dark:!bg-stone-100 dark:!text-stone-900">
                    {initial}
                </Avatar>
            </button>
        </Dropdown>
    );
}
