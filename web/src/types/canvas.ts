export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Config = "config",
    Video = "video",
    Audio = "audio",
    Group = "group",
    // M0: delivery domain nodes (dev plan §1.1)
    Requirement = "requirement",
    Journey = "journey",
    JourneyStep = "journey.step",
    Design = "design",
    Acceptance = "acceptance",
    TestCase = "testcase",
    Bug = "bug",
    Environment = "environment",
    Run = "run",
}

// Node types are open strings: built-ins use CanvasNodeType and plugins use "<pluginId>:<name>".
export type CanvasNodeTypeId = CanvasNodeType | (string & {});

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";
export type CanvasImageGenerationType = "generation" | "edit";

export type CanvasNodeImage = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
    storageKey?: string;
    naturalWidth: number;
    naturalHeight: number;
    bytes: number;
    mimeType: string;
};

export type CanvasNodeText = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
};

export type CanvasNodeTimelineEntry = {
    at: number; // epoch ms
    kind: string; // CanvasAgentOp type, rendered via canvas.agentOps.* i18n
    detail?: string; // optional short human-readable detail (e.g. generation prompt)
};

// Phase 3 follow-up: per-node edit history. Records the writes that changed an image node in place
// (a save from the embedded PS-mode editor, or a structure/region edit) so the canvas timeline can
// list "this image was edited with PS" next to the stage breakdown. The list is oldest first and is
// capped when appended (see lib/canvas/canvas-node-history).
export type CanvasNodeEditKind = "ps-edit" | "region-edit";
export type CanvasNodeEditRecord = {
    kind: CanvasNodeEditKind;
    at: number; // epoch ms
    engine?: string; // editing engine name (e.g. miniPaint)
    version?: string; // engine version at save time
    summary?: string; // optional short human-readable detail
};

// M5: code browser node view state. `tree` shows the file browser only, `file` shows the
// selected file next to the tree, and `diff` shows the unified diff of the active path.
export type CanvasNodeCodeView = "tree" | "file" | "diff";

// M6: edge semantics. Every connection carries a kind that decides its color and line style,
// plus optional metadata documenting the contract it represents (http method/path, payloads).
export type CanvasEdgeType = "flow" | "http" | "depends-on" | "event" | "db" | "derives" | "specifies" | "covers" | "violates" | "proves";
export type CanvasEdgeContract = {
    method?: string;
    path?: string;
    request?: string;
    response?: string;
    notes?: string;
};
export type CanvasEdgeMetadata = { contract?: CanvasEdgeContract };

// M6: pipeline stage badge rendered in the node header (requirement -> ... -> runtime).
export type CanvasNodeStage = "requirement" | "design" | "code" | "service" | "test" | "runtime";

// M6: repo node binding. Mirrors the canvas-agent /repo/status payload so a node can render a
// repository summary (name, branch, dirty marker, last commit) without re-querying on every render.
export type CanvasNodeRepoMetadata = {
    repoId?: string;
    name?: string;
    path?: string;
    isGit?: boolean;
    branch?: string;
    dirty?: boolean;
    lastCommit?: string;
};

// M7: image structure layer. `regions` is the parsed structure of an image (text boxes plus font
// hints) kept next to the pixels: edits change this metadata only, never the source image.
export type CanvasImageRegionType = "title" | "subtitle" | "body" | "button" | "label" | "logo" | "image" | "unknown";
export type CanvasImageRegionFont = { sizePx?: number; weight?: "regular" | "bold"; align?: "left" | "center" | "right"; family?: string };
export type CanvasImageRegionBbox = { x: number; y: number; w: number; h: number };
export type CanvasImageRegion = {
    id: string;
    type: CanvasImageRegionType;
    bbox: CanvasImageRegionBbox;
    text: string;
    confidence?: number;
    font?: CanvasImageRegionFont;
};
// `source` is the image reference this structure was parsed from (data URL or absolute path);
// width/height are the image's natural pixel size and bound every region bbox.
export type CanvasNodeRegionsMetadata = {
    source?: string;
    width?: number;
    height?: number;
    engine?: string;
    parsedAt?: number;
    regions?: CanvasImageRegion[];
    selectedRegionId?: string;
};

// Phase 3: PS-mode editor binding. `engine`/`version` identify the embedded editing engine and
// `lastSavedAt` records the last save-from-editor round trip shown in the node toolbar.
export type CanvasNodeEditorMetadata = {
    engine?: string;
    version?: string;
    lastSavedAt?: number;
};

// M6: service node binding. `port` + `healthPath` build the probe target; `status` caches the
// last probe outcome ("probing" | "ready" | "failed") so the node can render before the first poll.
export type CanvasNodeServiceStatus = "probing" | "ready" | "failed";
export type CanvasNodeServiceMetadata = {
    name?: string;
    port?: number;
    healthPath?: string;
    status?: CanvasNodeServiceStatus;
};

export type CanvasNodeCodeMetadata = {
    repoId?: string; // canvas-agent /repos repo id bound to this node
    rootPath?: string; // absolute path reported by the agent when the repo was registered
    activePath?: string; // repo-relative path of the file shown in the viewer, "" for the repo root
    view: CanvasNodeCodeView;
};

export type CanvasNodeMetadata = {
    stage?: CanvasNodeStage; // M6: pipeline stage badge shown in the node header
    repo?: CanvasNodeRepoMetadata; // M6: repo node binding (name/branch/dirty/last commit)
    service?: CanvasNodeServiceMetadata; // M6: service node binding (port/health path/status)
    terminalSession?: string; // M2: bound canvas-agent terminal session id
    followWindowId?: string; // M2: agent window this node follows (badge + accent outline; cleared when the window closes)
    preview?: { url?: string; autoRefreshMs?: number }; // M4: web preview node iframe target + auto refresh interval (ms, 0 = off)
    code?: CanvasNodeCodeMetadata; // M5: code browser repo binding + tree/file/diff view state
    regions?: CanvasNodeRegionsMetadata; // M7: image structure layer (parsed regions + edits)
    editor?: CanvasNodeEditorMetadata; // Phase 3: PS-mode editor engine binding + last save time
    // M1: 设计版本标签（其余交付字段见文件末尾的 M0 段，避免重复声明）。
    variantLabel?: string; // design 节点：A/B/C 版本标签
    variantOf?: string; // design 节点：同一组版本的锚点节点 id
    timeline?: CanvasNodeTimelineEntry[]; // M3: agent op history for this node, oldest first, capped at 50
    history?: CanvasNodeEditRecord[]; // Phase 3: in-place edit history (PS-mode saves), oldest first, capped at 50
    content?: string;
    composerContent?: string;
    prompt?: string;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    reasoningEffort?: "auto" | "low" | "medium" | "high" | "xhigh";
    size?: string;
    quality?: string;
    background?: string;
    count?: number;
    textCount?: number;
    texts?: CanvasNodeText[];
    primaryTextId?: string;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    videoMode?: string;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    references?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    images?: CanvasNodeImage[];
    primaryImageId?: string;
    storageKey?: string;
    mimeType?: string;
    // M0: delivery domain node metadata (dev plan §1.1)
    stepIds?: string[]; // journey -> ordered journey.step node ids
    selected?: boolean; // design variant chosen as the reference
    acId?: string; // acceptance/testcase business id ("AC-04")
    statement?: string; // acceptance statement text
    bugId?: string; // bug business id ("BUG-03")
    severity?: "P0" | "P1" | "P2" | "P3";
    violates?: string[]; // bug -> violated AC ids
    envId?: string; // environment business id ("ENV-01")
    envName?: string; // environment name (staging/production/…)
    url?: string; // environment URL
    runKind?: "test" | "deploy";
    bytes?: number;
    durationMs?: number;
    videoTaskId?: string;
    videoTaskProvider?: "openai" | "gemini";
    groupId?: string;
    interactive?: boolean; // Plugin node interaction/move state; see CanvasNodeDefinition.interactionToggle.
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    type?: CanvasEdgeType; // M6: edge semantics; defaults to "flow"
    label?: string; // M6: free label rendered at the edge midpoint
    metadata?: CanvasEdgeMetadata; // M6: contract documentation for this edge
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    references?: CanvasAssistantReference[];
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      };

// Canvas Journal: an append-only, traceable log of what changed on a canvas and who did it. A
// snapshot pair is diffed into human-readable entries (see lib/canvas/canvas-journal) so the UI can
// later list "operations" and jump back to any step, with assistant turns/tool calls flowing into
// the same stream. Entry summaries never carry literal text: `summary.key` is an i18n key.
export type CanvasJournalActorKind = "user" | "agent" | "system";
export type CanvasJournalActor = {
    kind: CanvasJournalActorKind;
    id?: string;
    name?: string;
};

export type CanvasJournalKind = "node.add" | "node.remove" | "node.update" | "node.move" | "node.resize" | "node.content" | "node.image-edit" | "edge.add" | "edge.remove" | "edge.update" | "project.rename" | "agent.turn" | "agent.tool";

export type CanvasJournalTargets = {
    nodeIds?: string[];
    edgeIds?: string[];
};

export type CanvasJournalSummary = {
    key: string; // i18n key (e.g. canvas.journal.nodeAdd); never a literal human string
    params?: Record<string, string | number>;
};

export type CanvasJournalEntry = {
    seq: number; // monotonic position inside the journal (oldest first)
    id: string; // stable entry id, unique inside the journal
    at: number; // epoch ms
    actor: CanvasJournalActor;
    kind: CanvasJournalKind;
    targets: CanvasJournalTargets;
    summary: CanvasJournalSummary;
    patch?: unknown; // optional before/after delta; large values are redacted
    meta?: Record<string, unknown>;
};
