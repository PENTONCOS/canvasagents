import { useCallback, useMemo, useState } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";
import { APP_VERSION } from "@/constant/env";
import type { ReleaseInfo } from "@/lib/release";

// 本仓库为唯一发布源：版本与更新日志在构建时从本地 VERSION / CHANGELOG 注入（__APP_RELEASES__），不再请求远程。
function readLocalReleases(): ReleaseInfo[] {
    return __APP_RELEASES__ || [];
}

export function useVersionCheck() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const currentVersion = APP_VERSION;
    const releases = useMemo(readLocalReleases, []);
    const [open, setOpen] = useState(false);

    const checkLatestRelease = useCallback(
        async (showMessage = false) => {
            if (showMessage) message.success(t("version.updated"));
            return true;
        },
        [message, t],
    );

    const openReleaseModal = useCallback(() => {
        setOpen(true);
        void checkLatestRelease();
    }, [checkLatestRelease]);

    return {
        open,
        setOpen,
        openReleaseModal,
        latestVersion: currentVersion,
        releases,
        checking: false,
        hasNewVersion: false,
        checkLatestRelease,
    };
}
