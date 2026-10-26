// WO-05: 三端布局的最小判据。
// 只回答一个问题：当前是不是窄屏（手机/竖屏平板）。布局决策留在各面板里，
// 这里不读任何业务状态，避免把响应式判断散进 store。
import { useEffect, useState } from "react";

export const COMPACT_MAX_WIDTH = 767;

export function useCompactViewport(maxWidth = COMPACT_MAX_WIDTH) {
    const query = `(max-width: ${maxWidth}px)`;
    const [compact, setCompact] = useState(() => (typeof window === "undefined" ? false : window.matchMedia(query).matches));

    useEffect(() => {
        if (typeof window === "undefined") return;
        const media = window.matchMedia(query);
        const onChange = (event: MediaQueryListEvent) => setCompact(event.matches);
        setCompact(media.matches);
        media.addEventListener("change", onChange);
        return () => media.removeEventListener("change", onChange);
    }, [query]);

    return compact;
}
