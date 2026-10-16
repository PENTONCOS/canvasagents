// Phase 3: PS-mode editor node bridge. This module owns the postMessage protocol shared by the
// canvas node (parent frame) and the small script injected into the same-origin miniPaint iframe.
// Everything here is DOM-free so the protocol, its validation, and the timeout wrapper can be
// unit tested without a browser (see tests/editor-bridge.test.ts).

import type { CanvasNodeMetadata } from "@/types/canvas";

export const EDITOR_ENGINE_NAME = "miniPaint";
export const EDITOR_ENGINE_VERSION = "4.14.3";

// Self-hosted miniPaint build shipped under web/public/minipaint (Vite copies public/** verbatim).
export const EDITOR_IFRAME_SRC = "/minipaint/index.html";

// Every payload carries this channel so unrelated window messages are ignored on both sides.
export const EDITOR_MESSAGE_CHANNEL = "canvasagents:editor";

export const EDITOR_PARENT_TO_IFRAME_KINDS = ["ping", "load-image", "export-image"] as const;
export const EDITOR_IFRAME_TO_PARENT_KINDS = ["ready", "pong", "loaded", "exported", "error"] as const;

export type EditorParentToIframeKind = (typeof EDITOR_PARENT_TO_IFRAME_KINDS)[number];
export type EditorIframeToParentKind = (typeof EDITOR_IFRAME_TO_PARENT_KINDS)[number];
export type EditorMessageKind = EditorParentToIframeKind | EditorIframeToParentKind;

// Protocol constants used by the parent node and mirrored inside EDITOR_BRIDGE_SCRIPT.
export const MESSAGES = {
    channel: EDITOR_MESSAGE_CHANNEL,
    parentToIframe: EDITOR_PARENT_TO_IFRAME_KINDS,
    iframeToParent: EDITOR_IFRAME_TO_PARENT_KINDS,
    ping: "ping",
    pong: "pong",
    ready: "ready",
    loadImage: "load-image",
    loaded: "loaded",
    exportImage: "export-image",
    exported: "exported",
    error: "error",
} as const;

export const EDITOR_ENGINE = { name: EDITOR_ENGINE_NAME, version: EDITOR_ENGINE_VERSION } as const;

export type EditorMessage = {
    channel: string;
    kind: EditorMessageKind;
    id?: string;
    src?: string;
    dataUrl?: string;
    strategy?: string;
    message?: string;
};

const KIND_SET: ReadonlySet<string> = new Set<string>([...EDITOR_PARENT_TO_IFRAME_KINDS, ...EDITOR_IFRAME_TO_PARENT_KINDS]);

const OPTIONAL_STRING_FIELDS = ["id", "src", "dataUrl", "strategy", "message"] as const;

function isOptionalString(value: unknown) {
    return value === undefined || typeof value === "string";
}

// Pipe guard for incoming window messages: rejects foreign channels, unknown kinds, and payloads
// whose optional fields are the wrong type. Both sides of the bridge run every message through it.
export function isEditorMessage(value: unknown): value is EditorMessage {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    if (candidate.channel !== EDITOR_MESSAGE_CHANNEL) return false;
    if (typeof candidate.kind !== "string" || !KIND_SET.has(candidate.kind)) return false;
    return OPTIONAL_STRING_FIELDS.every((field) => isOptionalString(candidate[field]));
}

// Builds an outbound message with the channel stamped on it; keeps callers from forgetting it.
export function editorMessage(kind: EditorMessageKind, fields: Omit<EditorMessage, "channel" | "kind"> = {}): EditorMessage {
    return { channel: EDITOR_MESSAGE_CHANNEL, kind, ...fields };
}

export const DEFAULT_EDITOR_TIMEOUT_MS = 8000;

// Wraps a promise with a timeout so a silent iframe fails loudly instead of hanging the node.
export function requestWithTimeout<T>(promise: Promise<T>, timeoutMs: number = DEFAULT_EDITOR_TIMEOUT_MS, timeoutMessage = "editor-timeout"): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(timeoutMessage));
        }, Math.max(0, timeoutMs));
        promise.then(
            (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            },
            (cause: unknown) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(cause);
            },
        );
    });
}

// Artifact + structure write-back for a save-from-editor round trip:
// - artifact: the exported image becomes the node content, so re-opening the node shows the edit;
// - structure: an existing regions layer keeps its data and only gets its parse timestamp bumped.
export function buildEditorSavePatch(metadata: CanvasNodeMetadata | undefined, dataUrl: string, savedAt: number): CanvasNodeMetadata {
    const patch: CanvasNodeMetadata = {
        content: dataUrl,
        editor: { engine: EDITOR_ENGINE_NAME, version: EDITOR_ENGINE_VERSION, lastSavedAt: savedAt },
    };
    if (metadata?.regions) patch.regions = { ...metadata.regions, parsedAt: savedAt };
    return patch;
}

// Script injected into the iframe after load. It cannot import the parent bundle, so the protocol is
// re-declared here as plain ES5-ish JS. miniPaint 4.14.3 exposes window.Layers / window.State /
// window.FileOpen / window.FileSave; the load and export entry points are probed with typeof at
// runtime instead of being assumed, and a missing capability reports an explicit error back.
export const EDITOR_BRIDGE_SCRIPT = `(function () {
  var CHANNEL = "${EDITOR_MESSAGE_CHANNEL}";
  var READY_TIMEOUT_MS = 8000;
  var READY_POLL_MS = 200;

  function send(kind, fields) {
    var message = fields || {};
    message.channel = CHANNEL;
    message.kind = kind;
    try {
      window.parent.postMessage(message, window.location.origin);
    } catch (error) {
      /* Parent frame is gone; nothing sensible to report to. */
    }
  }

  function describe(cause) {
    return cause && cause.message ? cause.message : String(cause);
  }

  function probe() {
    var element = document.getElementById("canvas_minipaint");
    return {
      layers: Boolean(window.Layers && typeof window.Layers.render === "function"),
      state: Boolean(window.State && typeof window.State.do_action === "function"),
      fileOpen: Boolean(window.FileOpen && typeof window.FileOpen.file_open_data_url_handler === "function"),
      canvas: Boolean(element && typeof element.toDataURL === "function")
    };
  }

  function loadImage(message) {
    if (!message.src) {
      send("error", { id: message.id, message: "empty-source" });
      return;
    }
    try {
      if (window.FileOpen && typeof window.FileOpen.file_open_data_url_handler === "function") {
        window.FileOpen.file_open_data_url_handler(message.src);
        send("loaded", { id: message.id, strategy: "file-open-handler" });
        return;
      }
      send("error", { id: message.id, message: "load-unsupported" });
    } catch (error) {
      send("error", { id: message.id, message: describe(error) });
    }
  }

  function exportImage(message) {
    try {
      if (window.Layers && typeof window.Layers.render === "function") {
        window.Layers.render(true);
      }
      var element = document.getElementById("canvas_minipaint");
      if (!element || typeof element.toDataURL !== "function") {
        send("error", { id: message.id, message: "export-unsupported" });
        return;
      }
      var dataUrl = element.toDataURL("image/png");
      if (!dataUrl || dataUrl.indexOf("data:image") !== 0) {
        send("error", { id: message.id, message: "export-empty" });
        return;
      }
      send("exported", { id: message.id, dataUrl: dataUrl, strategy: "main-canvas" });
    } catch (error) {
      send("error", { id: message.id, message: describe(error) });
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.channel !== CHANNEL) return;
    if (data.kind === "ping") send("pong", { id: data.id });
    else if (data.kind === "load-image") loadImage(data);
    else if (data.kind === "export-image") exportImage(data);
  });

  var startedAt = Date.now();
  var readyTimer = window.setInterval(function () {
    var state = probe();
    if (state.layers || state.fileOpen || Date.now() - startedAt > READY_TIMEOUT_MS) {
      window.clearInterval(readyTimer);
      send("ready", { strategy: "engine", message: JSON.stringify(state) });
    }
  }, READY_POLL_MS);
})();`;
