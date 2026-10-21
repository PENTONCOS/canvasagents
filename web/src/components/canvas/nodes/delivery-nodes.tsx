import { Bug, ClipboardList, FlaskConical, Play, Route, Server, SquareCheck, SquareDashed } from "lucide-react";

import { NODE_SPECS } from "@/constant/canvas";
import { CanvasNodeType } from "@/types/canvas";
import type { CanvasNodeDefinition } from "@/types/canvas-plugin";

// M0: delivery-domain node definitions (dev plan §1.2). Rendering uses the shared
// DeliveryNodeContent renderer in canvas-node; full editing arrives with per-node Panels in M1.
// Execution-state nodes (testcase/bug/run/environment) are created by the delivery flow, not
// the create menu, so they opt out via showInCreateMenu: false.

const iconClass = "size-4";

const DELIVERY_ICON: Partial<Record<CanvasNodeType, React.ReactNode>> = {
    [CanvasNodeType.Requirement]: <ClipboardList className={iconClass} />,
    [CanvasNodeType.Journey]: <Route className={iconClass} />,
    [CanvasNodeType.JourneyStep]: <SquareDashed className={iconClass} />,
    [CanvasNodeType.Design]: <SquareCheck className={iconClass} />,
    [CanvasNodeType.Acceptance]: <FlaskConical className={iconClass} />,
    [CanvasNodeType.TestCase]: <FlaskConical className={iconClass} />,
    [CanvasNodeType.Bug]: <Bug className={iconClass} />,
    [CanvasNodeType.Environment]: <Server className={iconClass} />,
    [CanvasNodeType.Run]: <Play className={iconClass} />,
};

const DELIVERY_MINIMAP: Partial<Record<CanvasNodeType, string>> = {
    [CanvasNodeType.Requirement]: "#f59e0b",
    [CanvasNodeType.Journey]: "#0ea5e9",
    [CanvasNodeType.JourneyStep]: "#38bdf8",
    [CanvasNodeType.Design]: "#8b5cf6",
    [CanvasNodeType.Acceptance]: "#22c55e",
    [CanvasNodeType.TestCase]: "#4ade80",
    [CanvasNodeType.Bug]: "#ef4444",
    [CanvasNodeType.Environment]: "#64748b",
    [CanvasNodeType.Run]: "#eab308",
};

const NOT_IN_CREATE_MENU: CanvasNodeType[] = [CanvasNodeType.TestCase, CanvasNodeType.Bug, CanvasNodeType.Run];

export const DELIVERY_DEFINITIONS: CanvasNodeDefinition[] = (
    [
        CanvasNodeType.Requirement,
        CanvasNodeType.Journey,
        CanvasNodeType.JourneyStep,
        CanvasNodeType.Design,
        CanvasNodeType.Acceptance,
        CanvasNodeType.TestCase,
        CanvasNodeType.Bug,
        CanvasNodeType.Environment,
        CanvasNodeType.Run,
    ] as CanvasNodeType[]
).map((type) => ({
    type,
    title: NODE_SPECS[type].title,
    icon: DELIVERY_ICON[type],
    minimapColor: DELIVERY_MINIMAP[type],
    showInCreateMenu: !NOT_IN_CREATE_MENU.includes(type),
    defaultSize: { width: NODE_SPECS[type].width, height: NODE_SPECS[type].height },
    defaultMetadata: NODE_SPECS[type].metadata,
}));
