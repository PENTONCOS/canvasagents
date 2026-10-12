import { Maximize2, Settings2 } from "lucide-react";

// M1 immersive redesign: the canvas is the single entry point; settings is a global drawer
// instead of a page, so navigation collapses to these two items.
export const navigationTools = [
    {
        slug: "canvas",
        icon: Maximize2,
    },
    {
        slug: "settings",
        icon: Settings2,
    },
] as const;

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];
