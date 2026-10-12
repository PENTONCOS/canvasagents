import { useEffect, useState } from "react";

import { Button, Input, Modal, Steps } from "antd";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useConfigStore } from "@/stores/use-config-store";
import { useAgentStore } from "@/stores/use-agent-store";

const ONBOARDED_KEY = "ic_onboarded";

// M1 immersive redesign: first-run wizard. Collects one AI channel key and
// shows the local agent bridge status; skippable, shown once.
export function OnboardingWizard() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [checked, setChecked] = useState(false);
    const [open, setOpen] = useState(false);
    const [step, setStep] = useState(0);
    const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
    const [apiKey, setApiKey] = useState("");
    const importChannelCredentials = useConfigStore((state) => state.importChannelCredentials);
    const agentConnected = useAgentStore((state) => state.connected);
    const agentUrl = useAgentStore((state) => state.url);

    useEffect(() => {
        if (typeof window === "undefined") return;
        setChecked(true);
        if (!localStorage.getItem(ONBOARDED_KEY)) setOpen(true);
    }, []);

    const finish = () => {
        localStorage.setItem(ONBOARDED_KEY, "1");
        setOpen(false);
    };

    const saveKey = () => {
        try {
            importChannelCredentials({ baseUrl: baseUrl.trim() || null, apiKey: apiKey.trim() || null });
            finish();
            navigate("/canvas");
        } catch {
            finish();
        }
    };

    if (!checked) return null;

    return (
        <Modal
            open={open}
            onCancel={finish}
            footer={null}
            width={520}
            closable={false}
            title={t("onboarding.title")}
        >
            <div className="flex flex-col gap-5 pt-2">
                <Steps
                    size="small"
                    current={step}
                    items={[{ title: t("onboarding.stepKey") }, { title: t("onboarding.stepAgent") }]}
                />

                {step === 0? (
                    <div className="flex flex-col gap-3">
                        <p className="text-sm text-stone-500 dark:text-stone-400">{t("onboarding.keyDescription")}</p>
                        <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" />
                        <Input.Password value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={t("onboarding.apiKey")} />
                        <div className="flex items-center justify-between">
                            <Button type="text" onClick={finish}>{t("onboarding.skip")}</Button>
                            <Button type="primary" onClick={saveKey}>{t("onboarding.next")}</Button>
                        </div>
                    </div>
                ): (
                    <div className="flex flex-col gap-3">
                        <p className="text-sm text-stone-500 dark:text-stone-400">{t("onboarding.agentDescription", { url: agentUrl })}</p>
                        <div className="rounded-lg bg-stone-100 px-3 py-2 text-sm dark:bg-stone-800">
                            {agentConnected? t("onboarding.agentConnected"): t("onboarding.agentOffline")}
                        </div>
                        <div className="flex items-center justify-between">
                            <Button type="text" onClick={finish}>{t("onboarding.skip")}</Button>
                            <Button type="primary" onClick={() => { finish(); navigate("/canvas"); }}>{t("onboarding.start")}</Button>
                        </div>
                    </div>
                )}
            </div>
        </Modal>
    );
}
