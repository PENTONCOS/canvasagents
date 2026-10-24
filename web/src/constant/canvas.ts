import i18n from "@/i18n";
import { CanvasNodeType } from "@/types/canvas";
import type { CanvasNodeMetadata } from "@/types/canvas";
import { getNodeSpec as getRegistryNodeSpec } from "@/lib/canvas/node-registry";

type CanvasNodeSpec = {
    width: number;
    height: number;
    title: string;
    metadata?: CanvasNodeMetadata;
};

export const NODE_DEFAULT_SIZE = {
    [CanvasNodeType.Image]: { width: 340, height: 240, get title() { return i18n.t("canvas.nodeTypes.image"); } },
    [CanvasNodeType.Text]: { width: 340, height: 240, get title() { return i18n.t("canvas.nodeTypes.text"); } },
    [CanvasNodeType.Config]: { width: 340, height: 240, get title() { return i18n.t("canvas.nodeTypes.config"); } },
    [CanvasNodeType.Video]: { width: 420, height: 236, get title() { return i18n.t("canvas.nodeTypes.video"); } },
    [CanvasNodeType.Audio]: { width: 340, height: 120, get title() { return i18n.t("canvas.nodeTypes.audio"); } },
    [CanvasNodeType.Group]: { width: 760, height: 480, get title() { return i18n.t("canvas.nodeTypes.group"); } },
    // M0: delivery domain
    // A4: 一句话需求便签，单行高度即可；实际创建尺寸以节点注册表里的 defaultSize 为准。
    [CanvasNodeType.Requirement]: { width: 340, height: 120, get title() { return i18n.t("canvas.nodeTypes.requirement"); } },
    [CanvasNodeType.Journey]: { width: 620, height: 300, get title() { return i18n.t("canvas.nodeTypes.journey"); } },
    [CanvasNodeType.JourneyStep]: { width: 240, height: 360, get title() { return i18n.t("canvas.nodeTypes.journeyStep"); } },
    [CanvasNodeType.Design]: { width: 360, height: 520, get title() { return i18n.t("canvas.nodeTypes.design"); } },
    [CanvasNodeType.Acceptance]: { width: 320, height: 160, get title() { return i18n.t("canvas.nodeTypes.acceptance"); } },
    [CanvasNodeType.TestCase]: { width: 300, height: 140, get title() { return i18n.t("canvas.nodeTypes.testCase"); } },
    [CanvasNodeType.Bug]: { width: 320, height: 180, get title() { return i18n.t("canvas.nodeTypes.bug"); } },
    [CanvasNodeType.Environment]: { width: 300, height: 160, get title() { return i18n.t("canvas.nodeTypes.environment"); } },
    [CanvasNodeType.Run]: { width: 320, height: 180, get title() { return i18n.t("canvas.nodeTypes.run"); } },
} satisfies Record<CanvasNodeType, { width: number; height: number; title: string }>;

export const NODE_SPECS = {
    [CanvasNodeType.Image]: {
        width: 340, height: 240, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Image].title; },
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Text]: {
        width: 340, height: 240, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Text].title; },
        metadata: { content: "", status: "idle", fontSize: 14 },
    },
    [CanvasNodeType.Config]: {
        width: 340, height: 240, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Config].title; },
        metadata: { content: "", status: "idle", generationMode: "image" },
    },
    [CanvasNodeType.Video]: {
        width: 420, height: 236, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Video].title; },
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Audio]: {
        width: 340, height: 120, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Audio].title; },
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Group]: {
        width: 760, height: 480, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Group].title; },
        metadata: { status: "idle" },
    },
    // M0: delivery domain
    [CanvasNodeType.Requirement]: {
        width: 340, height: 120, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Requirement].title; },
        metadata: { status: "idle", content: "" },
    },
    [CanvasNodeType.Journey]: {
        width: 620, height: 300, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Journey].title; },
        metadata: { status: "idle", stepIds: [] as string[] },
    },
    [CanvasNodeType.JourneyStep]: {
        width: 240, height: 360, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.JourneyStep].title; },
        metadata: { status: "idle", content: "" },
    },
    [CanvasNodeType.Design]: {
        width: 360, height: 520, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Design].title; },
        metadata: { status: "idle", content: "", selected: false },
    },
    [CanvasNodeType.Acceptance]: {
        width: 320, height: 160, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Acceptance].title; },
        metadata: { status: "idle", acId: "", statement: "" },
    },
    [CanvasNodeType.TestCase]: {
        width: 300, height: 140, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.TestCase].title; },
        metadata: { status: "idle", acId: "" },
    },
    [CanvasNodeType.Bug]: {
        width: 320, height: 180, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Bug].title; },
        metadata: { status: "idle", bugId: "", severity: "P1", violates: [] as string[] },
    },
    [CanvasNodeType.Environment]: {
        width: 300, height: 160, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Environment].title; },
        metadata: { status: "idle", envName: "staging", url: "" },
    },
    [CanvasNodeType.Run]: {
        width: 320, height: 180, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Run].title; },
        metadata: { status: "idle", runKind: "test" },
    },
} satisfies Record<CanvasNodeType, CanvasNodeSpec>;

// Return built-in specs directly and resolve plugin types from the registry.
export function getNodeSpec(type: string) {
    if ((Object.values(CanvasNodeType) as string[]).includes(type)) return NODE_SPECS[type as CanvasNodeType];
    const spec = getRegistryNodeSpec(type);
    return { width: spec.width, height: spec.height, title: spec.title, metadata: spec.metadata };
}
