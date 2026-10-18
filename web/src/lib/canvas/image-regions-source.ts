// DOM-side helpers that turn a canvas image reference into an /image/parse request body. Kept out
// of image-regions-utils.ts (which stays DOM-free and unit-testable) because fetching remote URLs
// and reading data URLs needs fetch/FileReader.
import i18n from "@/i18n";
import { isAbsoluteRepoPath } from "@/lib/canvas/code-node-utils";
import type { AgentImageParseBody, AgentImageParseLang } from "@/services/api/canvas-agent";

// Hard cap forwarded to the parser so one huge screenshot cannot return thousands of boxes.
export const MAX_PARSE_REGIONS = 200;

const DATA_URL_PATTERN = /^data:[^;,]*;base64,([\s\S]+)$/;

// Returns just the base64 payload of a data URL; non data URLs are returned trimmed as-is.
export function dataUrlBase64(value: string) {
    const match = DATA_URL_PATTERN.exec(value);
    return match ? match[1] : value.trim();
}

// OCR language follows the UI locale: Chinese UI asks for simplified Chinese, everything else en.
export function parseLang(): AgentImageParseLang {
    return i18n.language?.startsWith("zh") ? "zh-Hans" : "en-US";
}

// URL sources are downloaded and converted to base64 so the bridge receives a single payload shape.
export async function urlToBase64(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status}`);
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = typeof reader.result === "string" ? reader.result : "";
            const match = DATA_URL_PATTERN.exec(result);
            if (match) resolve(match[1]);
            else reject(new Error("data-url"));
        };
        reader.onerror = () => reject(reader.error instanceof Error ? reader.error : new Error("read-failed"));
        reader.readAsDataURL(blob);
    });
}

// Builds the bridge payload for a canvas image reference: absolute repo paths travel as `path`,
// data URLs and remote URLs are base64-encoded into `image`.
export async function buildParseBody(source: string): Promise<AgentImageParseBody> {
    const options = { lang: parseLang(), maxRegions: MAX_PARSE_REGIONS };
    if (isAbsoluteRepoPath(source)) return { path: source, options };
    if (source.startsWith("data:")) return { image: dataUrlBase64(source), options };
    return { image: await urlToBase64(source), options };
}
