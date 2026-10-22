import { useEffect, useState } from "react";
import { Button, Modal } from "antd";
import { useTranslation } from "react-i18next";

import { cancelFeedPreview, confirmFeedPreview, type FeedPreview, type FeedPreviewOutcome } from "@/lib/delivery/feed-preview";

/**
 * C3 投喂前预览。
 *
 * 投喂是一次不可撤销的交接：内容一旦发给 Agent 就开始烧 token，
 * 所以发送前把拼好的提示词整篇摊开给用户看，并且允许直接改。
 * 文本框不可省略：卡片/富文本渲染会把换行与分组标题吃掉，
 * 而「分组标题还在不在」正是用户判断这份上下文对不对的依据。
 */
export function FeedPreviewModal({ preview, open, onResolve }: { preview: FeedPreview | null; open: boolean; onResolve: (outcome: FeedPreviewOutcome) => void }) {
    const { t } = useTranslation();
    const [text, setText] = useState("");
    useEffect(() => {
        // 每次重开都回到「按当前选择重新拼装」的结果，不残留上一次的手改。
        if (open && preview) setText(preview.prompt);
    }, [open, preview]);

    const cancel = () => onResolve(cancelFeedPreview());

    return (
        <Modal open={open && Boolean(preview)} title={t("canvas.nodeToolbar.feedPreviewTitle")} onCancel={cancel} footer={null} width={760} centered destroyOnHidden>
            <div className="space-y-3" data-feed-preview>
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="font-medium" data-feed-preview-target>
                        {t("canvas.nodeToolbar.feedPreviewTarget", { label: preview?.targetLabel ?? "" })}
                    </span>
                    <span className="opacity-50">{t("canvas.nodeToolbar.feedPreviewCount", { count: preview?.count ?? 0 })}</span>
                </div>
                <p className="text-xs opacity-55">{t("canvas.nodeToolbar.feedPreviewHint")}</p>
                <textarea
                    data-feed-preview-text
                    aria-label={t("canvas.nodeToolbar.feedPreviewTitle")}
                    className="h-[320px] w-full resize-y rounded-lg border border-black/15 bg-[#fbfbfc] p-3 font-mono text-[13px] leading-5 outline-none focus:border-black/40"
                    spellCheck={false}
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                />
                <div className="flex justify-end gap-2">
                    {/* antd 会给两个汉字的按钮自动插空格（「取 消」），所以 e2e 只认 data 属性。 */}
                    <Button data-feed-preview-cancel onClick={cancel}>
                        {t("canvas.nodeToolbar.feedPreviewCancel")}
                    </Button>
                    <Button data-feed-preview-send type="primary" onClick={() => onResolve(confirmFeedPreview(text))}>
                        {t("canvas.nodeToolbar.feedPreviewSend")}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
