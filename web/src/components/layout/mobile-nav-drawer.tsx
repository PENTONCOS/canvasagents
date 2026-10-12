import { Drawer } from "antd";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { useConfigStore } from "@/stores/use-config-store";
import { cn } from "@/lib/utils";

type MobileNavDrawerProps = {
    open: boolean;
    activeToolSlug?: NavigationToolSlug;
    onClose: () => void;
};

export function MobileNavDrawer({ open, activeToolSlug, onClose }: MobileNavDrawerProps) {
    const { t } = useTranslation();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    return (
        <Drawer title={t("topNav.navigation")} placement="left" size={280} open={open} onClose={onClose} className="md:hidden">
            <div className="flex flex-col gap-1 px-2 py-3">
                {navigationTools.map((tool) => {
                    const Icon = tool.icon;
                    const active = tool.slug === activeToolSlug;
                    const itemClass = cn(
                        "flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-base transition",
                        active
                            ? "bg-stone-100 font-medium text-stone-950 dark:bg-stone-800 dark:text-stone-100"
                            : "text-stone-600 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-stone-100",
                    );
                    if (tool.slug === "settings") {
                        return (
                            <button
                                key={tool.slug}
                                type="button"
                                onClick={() => {
                                    openConfigDialog(false);
                                    onClose();
                                }}
                                className={itemClass}
                                aria-label={t("navigation.settings")}
                                title={t("navigation.settings")}
                            >
                                <Icon className="size-4" />
                                {t(`navigation.${tool.slug}`)}
                            </button>
                        );
                    }
                    return (
                        <Link key={tool.slug} to={`/${tool.slug}`} onClick={onClose} className={itemClass}>
                            <Icon className="size-4" />
                            {t(`navigation.${tool.slug}`)}
                        </Link>
                    );
                })}
            </div>
        </Drawer>
    );
}
