import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { APP_ID } from "@/constant/brand";
import { readStoredValue, writeStoredValue } from "@/lib/brand-migration";
import enUS from "@/i18n/locales/en-US";
import zhCN from "@/i18n/locales/zh-CN";

export type AppLocale = "zh-CN" | "en-US";

const LOCALE_STORAGE_KEY = `${APP_ID}:locale`;

i18n.use(initReactI18next).init({
    resources: {
        "zh-CN": { translation: zhCN },
        "en-US": { translation: enUS },
    },
    lng: (readStoredValue(LOCALE_STORAGE_KEY) as AppLocale) || "zh-CN",
    fallbackLng: "zh-CN",
    supportedLngs: ["zh-CN", "en-US"],
    initAsync: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
});

export function changeAppLocale(locale: AppLocale) {
    writeStoredValue(LOCALE_STORAGE_KEY, locale);
    return i18n.changeLanguage(locale);
}

export default i18n;
