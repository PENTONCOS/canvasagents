import { describe, expect, test } from "bun:test";

import { DELIVERY_DEFINITIONS } from "@/components/canvas/nodes/delivery-nodes";
import { registerBuiltinNodes } from "@/components/canvas/nodes/builtin-nodes";
import { NODE_SPECS } from "@/constant/canvas";
import { getNodeDefinition, getNodeSpec, isBuiltinNodeType, listNodeDefinitions } from "@/lib/canvas/node-registry";
import { CanvasNodeType } from "@/types/canvas";

// Production registers in project.tsx; tests must do the same before querying the registry.
registerBuiltinNodes();

const DELIVERY_TYPES = [
    CanvasNodeType.Requirement,
    CanvasNodeType.Journey,
    CanvasNodeType.JourneyStep,
    CanvasNodeType.Design,
    CanvasNodeType.Acceptance,
    CanvasNodeType.TestCase,
    CanvasNodeType.Bug,
    CanvasNodeType.Environment,
    CanvasNodeType.Run,
];

describe("node registry (M0 delivery nodes)", () => {
    test("all 9 delivery types resolve from the registry", () => {
        for (const type of DELIVERY_TYPES) {
            const def = getNodeDefinition(type);
            expect(def).toBeDefined();
            expect(def?.type).toBe(type);
            expect(def?.defaultSize.width).toBeGreaterThan(0);
            expect(def?.defaultSize.height).toBeGreaterThan(0);
            expect(def?.title).toBeTruthy();
        }
    });

    test("getNodeSpec covers delivery metadata defaults", () => {
        const bugSpec = getNodeSpec(CanvasNodeType.Bug);
        expect(bugSpec.metadata).toMatchObject({ status: "idle", severity: "P1" });
        const designSpec = getNodeSpec(CanvasNodeType.Design);
        expect(designSpec.metadata).toMatchObject({ selected: false });
    });

    test("legacy built-in nodes are unaffected (no regression)", () => {
        const legacy = [
            CanvasNodeType.Image,
            CanvasNodeType.Text,
            CanvasNodeType.Config,
            CanvasNodeType.Video,
            CanvasNodeType.Audio,
            CanvasNodeType.Group,
        ];
        for (const type of legacy) {
            expect(getNodeDefinition(type)).toBeDefined();
            expect(isBuiltinNodeType(type)).toBe(true);
        }
    });

    test("create menu visibility: testcase/bug/run hidden, others visible", () => {
        const byType = new Map(DELIVERY_DEFINITIONS.map((def) => [def.type, def]));
        expect(byType.get(CanvasNodeType.TestCase)?.showInCreateMenu).toBe(false);
        expect(byType.get(CanvasNodeType.Bug)?.showInCreateMenu).toBe(false);
        expect(byType.get(CanvasNodeType.Run)?.showInCreateMenu).toBe(false);
        expect(byType.get(CanvasNodeType.Requirement)?.showInCreateMenu).not.toBe(false);
        expect(byType.get(CanvasNodeType.Acceptance)?.showInCreateMenu).not.toBe(false);
    });

    test("every CanvasNodeType has a NODE_SPECS entry and appears in the registry list", () => {
        for (const type of Object.values(CanvasNodeType)) {
            expect(NODE_SPECS[type]).toBeDefined();
        }
        const registered = new Set(listNodeDefinitions().map((def) => def.type));
        for (const type of Object.values(CanvasNodeType)) {
            expect(registered.has(type)).toBe(true);
        }
    });
});
