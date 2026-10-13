import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { APP_ID } from "@/constant/brand";
import { createBrandStorage } from "@/lib/brand-migration";

export type ThemeName = "light" | "dark";

type ThemeStore = {
    theme: ThemeName;
    setTheme: (theme: ThemeName) => void;
};

export const useThemeStore = create<ThemeStore>()(
    persist(
        (set) => ({
            theme: "dark",
            setTheme: (theme) => set({ theme }),
        }),
        { name: `${APP_ID}:theme_store`, storage: createJSONStorage(() => createBrandStorage()) },
    ),
);
