import { useEffect } from "react";

import { Drawer } from "antd";
import { useTranslation } from "react-i18next";

import { AppConfigPanel } from "@/components/layout/app-config-modal";
import { AgentSettingsSection } from "@/components/layout/agent-settings-section";
import { useConfigStore, type ConfigTabKey } from "@/stores/use-config-store";

// M1 immersive redesign: the global settings surface. Wraps the existing
// AppConfigPanel in a drawer so every openConfigDialog() caller lands here
// without changes; adds the Agent section as a dedicated tab.
export function SettingsDrawer() {
    const { t } = useTranslation();
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const configTab = useConfigStore((state) => state.configTab);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);

    useEffect(() => {
        document.body.classList.toggle("settings-drawer-open", isConfigOpen);
        return () => document.body.classList.remove("settings-drawer-open");
    }, [isConfigOpen]);

    return (
        <Drawer
            title={t("config.title")}
            placement="right"
            size={720}
            open={isConfigOpen}
            onClose={() => setConfigDialogOpen(false)}
            destroyOnClose={false}
        >
            {configTab === "agent"? <AgentSettingsSection />: <AppConfigPanel showDoneButton initialTab={configTab as ConfigTabKey} />}
        </Drawer>
    );
}
