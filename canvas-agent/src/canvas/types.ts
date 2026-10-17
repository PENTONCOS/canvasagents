import type { CanvasEdgeType } from "./schemas.js";

/** 画布坐标。 */
export type Position = { x: number; y: number };
export type Viewport = { x: number; y: number; k: number };
/** 画布节点类型：内置基础类型 + 网页端已注册的扩展节点类型。 */
export type CanvasNodeType = "image" | "text" | "config" | "video" | "audio" | "code" | "repo" | "service" | "image-regions" | "editor" | "preview" | "terminal" | "group";
export type CanvasNode = { id: string; type: CanvasNodeType; title?: string; position: Position; width: number; height: number; metadata?: Record<string, unknown> };
/**
 * 画布连线。除拓扑外还承载边语义：
 * - `type`：边类型（flow/http/depends-on/event/db），未提供时调用方按 `flow` 对待；
 * - `label`：边上的简短说明；
 * - `metadata`：自由元数据，可含 `contract`（接口契约）。
 * 兼容网页可能上报的 `edgeType` 写法，读取时统一归一为 `type`。
 */
export type CanvasConnection = { id: string; fromNodeId: string; toNodeId: string; type?: CanvasEdgeType | string; edgeType?: CanvasEdgeType | string; label?: string; metadata?: Record<string, unknown> };
export type CanvasSnapshot = { projectId?: string; title?: string; nodes?: CanvasNode[]; connections?: CanvasConnection[]; selectedNodeIds?: string[]; viewport?: Viewport; clientId?: string };
