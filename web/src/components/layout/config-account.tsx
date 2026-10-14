import { App, Button, Form, Progress } from "antd";
import { Cloud, LogIn, LogOut } from "lucide-react";
import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { useAccountAutoSyncStore, requestAccountSync } from "@/services/account-auto-sync";
import { fetchCurrentUser, logoutAccount } from "@/services/account-auth";
import { pullConfigFromCloud, pushConfigToCloud } from "@/services/account-sync";
import { useAccountStore } from "@/stores/use-account-store";
import { cn } from "@/lib/utils";

type AccountDomainKey = "canvas" | "assets" | "image-workbench" | "video-workbench" | "config";

const domainKeys: AccountDomainKey[] = ["canvas", "assets", "image-workbench", "video-workbench", "config"];

type DomainProgress = {
    stage: string;
    current?: number;
    total?: number;
    status?: "active" | "success" | "exception";
};

function accountDomainLabel(key: AccountDomainKey, t: TFunction) {
    if (key === "image-workbench") return t("config.webdav.domains.imageWorkbench");
    if (key === "video-workbench") return t("config.webdav.domains.videoWorkbench");
    if (key === "config") return t("config.account.domains.config");
    return t(`config.webdav.domains.${key}`);
}

function accountStageLabel(stage: string, t: TFunction) {
    const map: Record<string, string> = {
        等待同步: "config.webdav.stages.waiting",
        等待本地数据加载: "config.webdav.stages.localWaiting",
        同步完成: "config.webdav.stages.syncComplete",
        读取远端清单: "config.webdav.stages.remoteManifest",
        读取本地数据: "config.webdav.stages.localData",
        下载缺失媒体: "config.webdav.stages.downloadMedia",
        写入本地合并结果: "config.webdav.stages.writeMerge",
        上传新增媒体: "config.webdav.stages.uploadMedia",
        媒体已齐全: "config.webdav.stages.mediaReady",
        媒体无需上传: "config.webdav.stages.mediaSkipped",
        检查缺失媒体: "config.webdav.stages.checkMissingMedia",
        下载媒体: "config.webdav.stages.downloadMediaFile",
        检查本地媒体: "config.webdav.stages.checkLocalMedia",
        完成: "config.webdav.stages.complete",
        上传配置: "config.account.stages.uploadConfig",
        应用云端配置: "config.account.stages.applyRemoteConfig",
        配置无变化: "config.account.stages.configUnchanged",
        "配置冲突，已保留本地": "config.account.stages.configConflict",
    };
    if (map[stage]) return t(map[stage]);
    if (stage.startsWith("上传媒体 ")) return t("config.webdav.stages.uploadMediaFile", { size: stage.slice(5) });
    if (stage.startsWith("上传清单 ")) return t("config.webdav.stages.uploadManifest", { size: stage.slice(5) });
    return stage;
}

function accountProgressPercent(item: DomainProgress) {
    if (item.status === "success" || item.status === "exception") return 100;
    if (item.total) return Math.min(100, Math.round(((item.current || 0) / item.total) * 100));
    if (item.stage === "等待同步") return 0;
    return item.status === "active" ? 30 : 0;
}

function formatAccountTime(value: string, locale: string) {
    return new Date(value).toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function ConfigAccount({ active = true }: { active?: boolean }) {
    const { message } = App.useApp();
    const { t, i18n } = useTranslation();
    const locale = i18n.language as string;
    const navigate = useNavigate();
    const token = useAccountStore((state) => state.token);
    const user = useAccountStore((state) => state.user);
    const lastSyncedAt = useAccountStore((state) => state.lastSyncedAt);

    const [busy, setBusy] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [progress, setProgress] = useState<Partial<Record<AccountDomainKey, DomainProgress>>>({});
    const [conflict, setConflict] = useState(false);
    const autoSyncStatus = useAccountAutoSyncStore((state) => state.status);

    useEffect(() => {
        if (active && token && !user) void fetchCurrentUser().catch(() => undefined);
    }, [active, token, user]);

    // Manual recovery only: everything else syncs automatically in the background.
    const manualResync = async () => {
        setSyncing(true);
        setConflict(false);
        setProgress({});
        try {
            const result = await requestAccountSync({
                force: true,
                onProgress: (event) => {
                    const key = (event.domain || "config") as AccountDomainKey;
                    setProgress((prev) => ({
                        ...prev,
                        [key]: { stage: event.stage, current: event.current, total: event.total, status: event.status },
                    }));
                },
            });
            // Failures never throw out of the coordinator; the status line reports them.
            if (result?.config === "conflict") {
                setConflict(true);
                message.warning(t("config.account.conflictDetected"));
            }
        } finally {
            setSyncing(false);
        }
    };

    const resolveConflict = async (direction: "push" | "pull") => {
        setBusy(true);
        try {
            if (direction === "push") await pushConfigToCloud();
            else await pullConfigFromCloud();
            setConflict(false);
            message.success(t("config.account.conflictResolved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.account.syncFailed"));
        } finally {
            setBusy(false);
        }
    };

    const doLogout = async () => {
        setBusy(true);
        try {
            await logoutAccount();
            setProgress({});
            setConflict(false);
            message.success(t("config.account.loggedOut"));
        } finally {
            setBusy(false);
        }
    };

    const autoSyncLabel = autoSyncStatus === "syncing"
        ? t("config.account.autoSyncing")
        : autoSyncStatus === "error"
            ? t("config.account.autoSyncError")
            : lastSyncedAt
                ? t("config.account.lastSynced", { time: formatAccountTime(lastSyncedAt, locale) })
                : t("config.account.autoSyncOn");

    if (!token) {
        return (
            <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                    <Cloud className="size-4" />
                    {t("config.account.title")}
                </div>
                <div className="mb-3 text-xs text-stone-500">{t("config.account.description")}</div>
                <Button type="primary" icon={<LogIn className="size-4" />} onClick={() => navigate("/login")}>
                    {t("config.account.goToAuth")}
                </Button>
            </section>
        );
    }

    return (
        <Form layout="vertical" requiredMark={false}>
            <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            <Cloud className="size-4" />
                            {t("config.account.signedInAs", { name: user?.displayName || user?.username || t("config.account.notLoggedIn") })}
                        </div>
                        {user?.username ? <div className="mt-1 text-xs text-stone-500">@{user.username}</div> : null}
                    </div>
                    <div className="text-xs text-stone-500">{lastSyncedAt ? t("config.account.lastSynced", { time: formatAccountTime(lastSyncedAt, locale) }) : t("config.account.neverSynced")}</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Button icon={<LogOut className="size-4" />} disabled={busy || syncing} onClick={() => void doLogout()}>
                        {t("config.account.logout")}
                    </Button>
                    <span className="inline-flex items-center gap-1.5 text-xs text-stone-500">
                        <span className={cn("size-1.5 rounded-full", autoSyncStatus === "error" ? "bg-red-500" : autoSyncStatus === "syncing" ? "bg-amber-500" : "bg-emerald-500")} />
                        {autoSyncLabel}
                    </span>
                    <Button type="text" size="small" className="!h-6 !px-1 !text-xs text-stone-500" disabled={syncing} onClick={() => void manualResync()}>
                        {t("config.account.resync")}
                    </Button>
                </div>
                {conflict ? (
                    <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-700 dark:bg-amber-950/40">
                        <div className="mb-2 font-medium text-amber-800 dark:text-amber-200">{t("config.account.conflictHint")}</div>
                        <div className="flex flex-wrap gap-2">
                            <Button size="small" onClick={() => void resolveConflict("push")}>
                                {t("config.account.keepLocal")}
                            </Button>
                            <Button size="small" onClick={() => void resolveConflict("pull")}>
                                {t("config.account.keepRemote")}
                            </Button>
                        </div>
                    </div>
                ) : null}
                {syncing || Object.keys(progress).length ? (
                    <div className="mt-3 grid gap-2">
                        {domainKeys.map((key) => {
                            const item = progress[key];
                            const count = item?.total ? `${item.current || 0}/${item.total}` : "";
                            return (
                                <div key={key} className="rounded-md border border-stone-200 px-3 py-2 dark:border-stone-800">
                                    <div className="mb-1 flex min-w-0 items-center justify-between gap-3 text-xs">
                                        <span className="shrink-0 font-medium text-stone-700 dark:text-stone-200">{accountDomainLabel(key, t)}</span>
                                        <span className="min-w-0 truncate text-right text-stone-500">
                                            {item ? accountStageLabel(item.stage, t) : t("config.webdav.stages.waiting")}
                                            {count ? ` · ${count}` : ""}
                                        </span>
                                    </div>
                                    <Progress percent={item ? accountProgressPercent(item) : 0} size="small" status={item?.status === "success" ? "success" : item?.status === "exception" ? "exception" : item?.status === "active" ? "active" : "normal"} showInfo={false} />
                                </div>
                            );
                        })}
                    </div>
                ) : null}
            </section>
        </Form>
    );
}
