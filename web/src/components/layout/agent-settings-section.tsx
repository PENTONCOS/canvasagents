import { useState } from "react";

import { App, Form, Input, Select } from "antd";
import { useTranslation } from "react-i18next";

import { useAgentStore, type AgentPermissionMode, type AgentReasoningEffort } from "@/stores/use-agent-store";

const EFFORTS: AgentReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const PERMISSION_MODES: AgentPermissionMode[] = ["request", "automatic", "full"];

// M1 immersive redesign: Agent (Codex bridge) settings section inside the
// global settings drawer. Persists via setAgentState plus the same localStorage
// keys the agent panel uses.
export function AgentSettingsSection() {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const url = useAgentStore((state) => state.url);
    const token = useAgentStore((state) => state.token);
    const model = useAgentStore((state) => state.model);
    const models = useAgentStore((state) => state.models);
    const reasoningEffort = useAgentStore((state) => state.reasoningEffort);
    const permissionMode = useAgentStore((state) => state.permissionMode);
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const [urlDraft, setUrlDraft] = useState(url);
    const [tokenDraft, setTokenDraft] = useState(token);

    const effortOptions = EFFORTS.map((effort) => ({ value: effort, label: t(`agent.composer.effort.${effort}`) }));
    const modelOptions = models.map((item) => ({ value: item.model, label: item.displayName || item.model }));
    const currentModel = modelOptions.some((option) => option.value === model)? model: undefined;

    const patchAgent = (patch: { model?: string; reasoningEffort?: AgentReasoningEffort; permissionMode?: AgentPermissionMode }) => {
        if (patch.model!== undefined) localStorage.setItem("canvas-agent-model", patch.model);
        if (patch.reasoningEffort!== undefined) localStorage.setItem("canvas-agent-reasoning-effort", patch.reasoningEffort);
        if (patch.permissionMode!== undefined) localStorage.setItem("canvas-agent-permission-mode", patch.permissionMode);
        setAgentState(patch);
    };

    const changePermissionMode = (mode: AgentPermissionMode) => {
        if (mode === "full" && permissionMode!== "full") {
            modal.confirm({
                title: t("agent.composer.permission.full"),
                content: t("agent.composer.permission.fullDescription"),
                okText: t("agent.composer.permission.fullShort"),
                onOk: () => patchAgent({ permissionMode: mode }),
            });
            return;
        }
        patchAgent({ permissionMode: mode });
    };

    const saveConnection = () => {
        const endpoint = urlDraft.trim();
        if (!endpoint) {
            message.warning(t("settings.agent.urlRequired"));
            return;
        }
        localStorage.setItem("canvas-agent-url", endpoint);
        localStorage.setItem("canvas-agent-token", tokenDraft.trim());
        setAgentState({ url: endpoint, token: tokenDraft.trim() });
        message.success(t("settings.agent.saved"));
    };

    return (
        <div className="flex flex-col gap-6 py-2">
            <section>
                <h3 className="mb-3 text-sm font-medium text-stone-950 dark:text-stone-100">{t("settings.agent.connectionTitle")}</h3>
                <Form layout="vertical" component={false}>
                    <Form.Item label={t("settings.agent.url")} className="mb-3">
                        <div className="flex gap-2">
                            <Input value={urlDraft} onChange={(event) => setUrlDraft(event.target.value)} placeholder="http://127.0.0.1:17371" />
                            <Input.Password value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} placeholder={t("settings.agent.token")} className="max-w-48" />
                        </div>
                    </Form.Item>
                    <button type="button" className="ant-btn ant-btn-default" onClick={saveConnection}>
                        {t("settings.agent.saveConnection")}
                    </button>
                </Form>
            </section>

            <section>
                <h3 className="mb-3 text-sm font-medium text-stone-950 dark:text-stone-100">{t("settings.agent.behaviorTitle")}</h3>
                <Form layout="vertical" component={false}>
                    <Form.Item label={t("settings.agent.model")} className="mb-3">
                        <Select
                            value={currentModel}
                            options={modelOptions}
                            placeholder={t("agent.composer.selectModel", { model: model || "-" })}
                            onChange={(value) => patchAgent({ model: value })}
                            allowClear={false}
                            showSearch
                            optionFilterProp="label"
                        />
                    </Form.Item>
                    <Form.Item label={t("settings.agent.reasoningEffort")} className="mb-3">
                        <Select
                            value={reasoningEffort || undefined}
                            options={effortOptions}
                            placeholder={t("agent.composer.selectReasoning", { effort: reasoningEffort || "-" })}
                            onChange={(value) => patchAgent({ reasoningEffort: value })}
                            allowClear={false}
                        />
                    </Form.Item>
                    <Form.Item label={t("settings.agent.permissionMode")} className="mb-0">
                        <Select
                            value={permissionMode}
                            options={PERMISSION_MODES.map((mode) => ({ value: mode, label: t(`agent.composer.permission.${mode}`) }))}
                            onChange={changePermissionMode}
                            allowClear={false}
                        />
                    </Form.Item>
                </Form>
            </section>
        </div>
    );
}
