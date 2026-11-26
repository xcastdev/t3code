// @effect-diagnostics globalTimers:off globalFetch:off - This browser and WebView transport runs without an Effect runtime.
import { type DeviceHubAccess, withDeviceHubQuery } from "../device/hubAccess.ts";
import {
  PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE,
  PREVIEW_ASSET_WIDGET_MAX_MESSAGE_BYTES,
  PREVIEW_ASSET_WIDGET_GESTURE_MS,
  type PreviewAssetStreamOpen,
  type PreviewAssetStreamPresentation,
  type PreviewStreamHostSetup,
  type PreviewViewportSetting,
} from "@t3tools/contracts";

export const PREVIEW_STREAM_BASE_PATH = "/api/preview-stream";

export interface PreviewStreamViewport {
  readonly width: number;
  readonly height: number;
}

export type PreviewStreamMouseButton = "none" | "left" | "middle" | "right";

export interface PreviewStreamControl {
  readonly canOperate: boolean;
  readonly controller: "agent" | "you" | "another-viewer" | "unclaimed";
  readonly generation: number;
  readonly dialog: null | {
    readonly type: string;
    readonly message: string;
    readonly defaultValue: string;
  };
}

export const previewStreamControlLabel = (control: PreviewStreamControl | null): string =>
  !control
    ? "Connecting..."
    : !control.canOperate
      ? "Read-only"
      : control.controller === "you"
        ? "You have control"
        : control.controller === "agent"
          ? "Agent has control"
          : control.controller === "another-viewer"
            ? "Another viewer has control"
            : "Watching";

const isPreviewStreamDialog = (value: unknown): value is PreviewStreamControl["dialog"] =>
  value === null ||
  (typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string" &&
    "message" in value &&
    typeof value.message === "string" &&
    "defaultValue" in value &&
    typeof value.defaultValue === "string");

/** Coordinates are page CSS px. */
export type PreviewStreamInput =
  | PreviewAssetStreamPresentation
  | { readonly type: "takeControl" }
  | { readonly type: "releaseControl" }
  | { readonly type: "dialog"; readonly accept: boolean; readonly promptText?: string }
  | { readonly type: "viewport"; readonly setting: PreviewViewportSetting }
  | {
      readonly type: "mouse";
      readonly action: "move" | "down" | "up";
      readonly x: number;
      readonly y: number;
      readonly button: PreviewStreamMouseButton;
      /** Pressed buttons: left 1, right 2, middle 4. */
      readonly buttons: number;
      readonly clickCount: number;
      readonly modifiers: number;
    }
  | {
      readonly type: "wheel";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
      readonly modifiers: number;
    }
  | {
      readonly type: "key";
      readonly action: "down" | "up";
      readonly key: string;
      readonly code: string;
      /** Windows virtual key code (DOM `keyCode`); Enter, Backspace, and arrows need it. */
      readonly keyCode?: number;
      /** Only for printable keys without Ctrl or Meta. */
      readonly text?: string;
      readonly modifiers: number;
    }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "resize"; readonly width: number; readonly height: number }
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "history"; readonly delta: -1 | 1 }
  | { readonly type: "reload"; readonly ignoreCache?: boolean }
  | { readonly type: "stopLoading" }
  | { readonly type: "probe"; readonly x: number; readonly y: number };

export interface PreviewStreamDownload {
  readonly fileName: string;
  readonly sizeBytes: number;
  /** Authenticated with the stream's own access; cookie sessions must send credentials. */
  readonly url: string;
}

export interface PreviewStreamFileChooser {
  readonly multiple: boolean;
  readonly accept: string;
  /** Identifies the page request across offers. Only an offer's upload URL can answer it. */
  readonly requestId?: string;
  /** POST multipart `file` parts here; an empty form cancels the page's picker. */
  readonly uploadUrl: string;
  readonly credentials: boolean;
}

const previewStreamUploadUrl = (
  target: Pick<PreviewStreamTarget, "access" | "threadId" | "tabId">,
  chooser: string,
): string =>
  withDeviceHubQuery(
    `${target.access.httpBase}/upload?${new URLSearchParams({
      threadId: target.threadId,
      tabId: target.tabId,
      chooser,
    }).toString()}`,
    target.access,
  );

export async function uploadPreviewStreamFiles(
  chooser: PreviewStreamFileChooser,
  files: ReadonlyArray<Blob & { readonly name?: string }>,
  fetchResource: typeof fetch = fetch,
): Promise<void> {
  const body = new FormData();
  for (const file of files) body.append("file", file, file.name ?? "file");
  const response = await fetchResource(chooser.uploadUrl, {
    method: "POST",
    body,
    credentials: chooser.credentials ? "include" : "omit",
  });
  if (!response.ok) throw new Error((await response.text()) || "The upload was refused.");
}

export const previewStreamDownloadUrl = (
  target: Pick<PreviewStreamTarget, "access" | "threadId" | "tabId">,
  id: string,
): string =>
  withDeviceHubQuery(
    `${target.access.httpBase}/download?${new URLSearchParams({
      threadId: target.threadId,
      tabId: target.tabId,
      id,
    }).toString()}`,
    target.access,
  );

export interface PreviewStreamProbe {
  readonly x: number;
  readonly y: number;
  readonly editable: boolean;
}

export interface PreviewStreamPointer {
  readonly phase: "move" | "click";
  readonly x: number;
  readonly y: number;
  readonly sequence: number;
}

export const previewStreamModifiers = (event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): number =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0);

export interface PreviewStreamTarget {
  readonly access: DeviceHubAccess;
  readonly threadId: string;
  readonly tabId: string;
  /** Viewer backing-store size in device px. The server never sends larger frames. */
  readonly maxWidth: number;
  readonly maxHeight: number;
  /** Passive viewers reduce their own access, including automatic control grants. */
  readonly interactive?: boolean;
  readonly asset?: PreviewAssetStreamOpen;
}

export interface PreviewAssetWidgetConnection {
  readonly receive: (data: unknown, activated: boolean) => void;
  readonly dispose: () => void;
}

export interface PreviewStreamEvents {
  readonly onFrame: (jpeg: ArrayBuffer) => void;
  readonly onViewport: (viewport: PreviewStreamViewport) => void;
  readonly onAssetHeight?: (height: number) => void;
  readonly connectWidget?: (post: (data: unknown) => void) => PreviewAssetWidgetConnection;
  readonly widgetHasActivation?: () => boolean;
  readonly onProbe?: (probe: PreviewStreamProbe) => void;
  readonly onPointer?: (pointer: PreviewStreamPointer) => void;
  readonly onControl?: (control: PreviewStreamControl) => void;
  readonly onClipboard?: (text: string) => void;
  readonly onDownload?: (download: PreviewStreamDownload) => void;
  readonly onPopup?: (tabId: string) => void;
  readonly onFileChooser?: (chooser: PreviewStreamFileChooser | null) => void;
  readonly onConnectedChange: (connected: boolean) => void;
  /** The upgrade was refused; refresh access and start a new client. */
  readonly onUnauthorized: () => void;
  readonly onGone?: () => void;
  readonly onHostSetup?: (setup: PreviewStreamHostSetup) => void;
}

export interface PreviewStreamClient {
  readonly send: (input: PreviewStreamInput, activateWidget?: boolean) => boolean;
  readonly stop: () => void;
}

const widgetEncoder = new TextEncoder();

function encodeWidgetMessage(data: unknown): string | undefined {
  try {
    const json = JSON.stringify(data);
    if (
      json !== undefined &&
      json.length <= PREVIEW_ASSET_WIDGET_MAX_MESSAGE_BYTES &&
      widgetEncoder.encode(json).byteLength <= PREVIEW_ASSET_WIDGET_MAX_MESSAGE_BYTES
    ) {
      return `{"type":"widgetMessage","data":${json}}`;
    }
  } catch {
    return undefined;
  }
}

function oversizedMcpReply(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || !("jsonrpc" in data) || data.jsonrpc !== "2.0") {
    return;
  }
  if (
    !("id" in data) ||
    !(typeof data.id === "string" || (typeof data.id === "number" && Number.isFinite(data.id))) ||
    !("result" in data || "error" in data) ||
    "method" in data
  ) {
    return;
  }
  return encodeWidgetMessage({
    jsonrpc: "2.0",
    id: data.id,
    error: { code: -32000, message: "MCP app response exceeds 1 MiB." },
  });
}

const ACK_MESSAGE = JSON.stringify({ type: "ack" });
export function createPreviewStreamClient(
  target: PreviewStreamTarget,
  events: PreviewStreamEvents,
  createSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
): PreviewStreamClient {
  const query = new URLSearchParams({
    threadId: target.threadId,
    tabId: target.tabId,
    maxWidth: String(Math.max(1, Math.round(target.maxWidth))),
    maxHeight: String(Math.max(1, Math.round(target.maxHeight))),
  });
  if (target.asset) {
    query.delete("threadId");
    query.delete("tabId");
    query.set("asset", "1");
  }
  if (target.interactive === false) query.set("interactive", "false");
  const url = withDeviceHubQuery(`${target.access.wsBase}/ws?${query.toString()}`, target.access);
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let control: PreviewStreamControl | null = null;
  let fileChooser: string | null = null;
  let widgetConnection: PreviewAssetWidgetConnection | null = null;
  let widgetSocket: WebSocket | null = null;
  let gestureSequence = 0;
  let localGesture: { readonly id: number; readonly at: number } | null = null;

  const disposeWidget = () => {
    widgetSocket = null;
    localGesture = null;
    const current = widgetConnection;
    widgetConnection = null;
    try {
      current?.dispose();
    } catch {
      // Bridge cleanup must leave the socket closed even when the host fails.
    }
  };

  // The server re-offers a picker still open, under a new id, when this viewer reattaches.
  const withdrawFileChooser = () => {
    if (fileChooser === null) return;
    fileChooser = null;
    events.onFileChooser?.(null);
  };

  const connect = () => {
    if (stopped) return;
    let ws: WebSocket;
    try {
      ws = createSocket(url);
    } catch {
      events.onUnauthorized();
      return;
    }
    ws.binaryType = "arraybuffer";
    socket = ws;
    let opened = false;
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      opened = true;
      if (target.asset) ws.send(JSON.stringify(target.asset));
      events.onConnectedChange(true);
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        failures = 0;
        ws.send(ACK_MESSAGE);
        events.onFrame(event.data);
        return;
      }
      if (typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      const record = message as Record<string, unknown>;
      if (record.type === "widgetReady" || record.type === "widgetMessage") {
        if (!target.asset?.widget || !events.connectWidget) return;
        try {
          if (record.type === "widgetReady") {
            if (widgetSocket !== null || record.kind !== target.asset.widget) return;
            widgetSocket = ws;
            widgetConnection = events.connectWidget((data) => {
              if (widgetSocket !== ws || socket !== ws || ws.readyState !== WebSocket.OPEN) return;
              const payload =
                encodeWidgetMessage(data) ??
                (record.kind === "mcp-app" ? oversizedMcpReply(data) : undefined);
              if (payload !== undefined) ws.send(payload);
            });
          } else if (widgetSocket === ws && "data" in record) {
            const candidate = localGesture;
            const matches = candidate !== null && record.gesture === candidate.id;
            const activated =
              matches &&
              performance.now() - candidate.at <= PREVIEW_ASSET_WIDGET_GESTURE_MS &&
              events.widgetHasActivation?.() === true;
            if (matches) localGesture = null;
            widgetConnection?.receive(record.data, activated);
          }
        } catch {
          ws.close();
        }
        return;
      }
      const {
        type,
        x,
        y,
        width,
        height,
        editable,
        canOperate,
        controller,
        generation,
        dialog,
        text,
        id,
        requestId,
        fileName,
        sizeBytes,
        multiple,
        accept,
        phase,
        sequence,
        tabId,
      } = message as Record<string, unknown>;
      if (
        type === "fileChooser" &&
        typeof id === "string" &&
        typeof multiple === "boolean" &&
        typeof accept === "string"
      ) {
        fileChooser = id;
        events.onFileChooser?.({
          multiple,
          accept,
          ...(typeof requestId === "string" ? { requestId } : {}),
          uploadUrl: previewStreamUploadUrl(target, id),
          credentials: target.access.credentials,
        });
      } else if (type === "fileChooserClosed" && typeof id === "string") {
        if (fileChooser !== id) return;
        fileChooser = null;
        events.onFileChooser?.(null);
      } else if (
        type === "pointer" &&
        (phase === "move" || phase === "click") &&
        typeof x === "number" &&
        typeof y === "number" &&
        typeof sequence === "number"
      ) {
        events.onPointer?.({ phase, x, y, sequence });
      } else if (type === "popup" && typeof tabId === "string") {
        events.onPopup?.(tabId);
      } else if (type === "clipboard" && typeof text === "string") {
        events.onClipboard?.(text);
      } else if (
        type === "download" &&
        typeof id === "string" &&
        typeof fileName === "string" &&
        typeof sizeBytes === "number"
      ) {
        events.onDownload?.({
          fileName,
          sizeBytes,
          url: previewStreamDownloadUrl(target, id),
        });
      } else if (
        type === "assetHeight" &&
        Number.isSafeInteger(height) &&
        typeof height === "number" &&
        height > 0 &&
        height <= 20_000
      ) {
        events.onAssetHeight?.(height);
      } else if (type === "viewport" && typeof width === "number" && typeof height === "number") {
        failures = 0;
        events.onViewport({ width, height });
      } else if (
        type === "probe" &&
        typeof x === "number" &&
        typeof y === "number" &&
        typeof editable === "boolean"
      ) {
        events.onProbe?.({ x, y, editable });
      } else if (
        type === "control" &&
        typeof canOperate === "boolean" &&
        (controller === "agent" ||
          controller === "you" ||
          controller === "another-viewer" ||
          controller === "unclaimed") &&
        typeof generation === "number" &&
        isPreviewStreamDialog(dialog)
      ) {
        const nextControl: PreviewStreamControl = {
          canOperate,
          controller,
          generation,
          dialog,
        };
        control = nextControl;
        events.onControl?.(nextControl);
      }
    });
    ws.addEventListener("close", (event) => {
      if (socket !== ws) return;
      socket = null;
      control = null;
      disposeWidget();
      withdrawFileChooser();
      if (opened) events.onConnectedChange(false);
      if (stopped) return;
      if (event.code === 4404) {
        stopped = true;
        events.onGone?.();
        return;
      }
      if (event.code === PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE) {
        stopped = true;
        events.onHostSetup?.(decodeHostSetup(event.reason));
        return;
      }
      // Rejected upgrades surface as 1006 before open for both cookies and tickets.
      if (event.code === 1008 || event.code === 4401 || (!opened && event.code === 1006)) {
        stopped = true;
        events.onUnauthorized();
        return;
      }
      retryTimer = setTimeout(connect, Math.min(500 * 2 ** failures++, 10_000));
    });
    ws.addEventListener("error", () => ws.close());
  };

  connect();

  return {
    send: (input, activateWidget = false) => {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      if (!control?.canOperate) return false;
      if (input.type !== "takeControl" && control.controller !== "you") return false;
      if (activateWidget && widgetSocket === socket) {
        const id = ++gestureSequence;
        socket.send(JSON.stringify({ ...input, widgetGesture: id }));
        localGesture = { id, at: performance.now() };
      } else {
        socket.send(JSON.stringify(input));
      }
      return true;
    },
    stop: () => {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      const ws = socket;
      socket = null;
      control = null;
      disposeWidget();
      withdrawFileChooser();
      ws?.close();
    },
  };
}

export interface PreviewFramePainter {
  readonly paint: (jpeg: ArrayBuffer) => void;
  readonly stop: () => void;
}

/** One decode at a time, keeping only the latest waiting frame for slow viewers. */
export function createPreviewFramePainter(
  canvas: HTMLCanvasElement,
  onPainted?: () => void,
): PreviewFramePainter {
  const context = canvas.getContext("2d");
  let stopped = false;
  let decoding = false;
  let waiting: ArrayBuffer | null = null;
  const draw = (jpeg: ArrayBuffer) => {
    decoding = true;
    void createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }))
      .then((bitmap) => {
        if (stopped || !context) {
          bitmap.close();
          return;
        }
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        onPainted?.();
      })
      .catch(() => undefined)
      .finally(() => {
        decoding = false;
        const next = waiting;
        waiting = null;
        if (next && !stopped) draw(next);
      });
  };
  return {
    paint: (jpeg) => {
      if (stopped) return;
      if (decoding) waiting = jpeg;
      else draw(jpeg);
    },
    stop: () => {
      stopped = true;
      waiting = null;
    },
  };
}

const decodeHostSetup = (reason: string): PreviewStreamHostSetup => {
  try {
    const value = JSON.parse(reason) as Partial<PreviewStreamHostSetup>;
    if (
      (value.need === "sandbox" || value.need === "libraries") &&
      typeof value.command === "string"
    ) {
      return { need: value.need, command: value.command };
    }
  } catch {}
  return { need: "sandbox", command: "sudo npx t3 browser setup" };
};

export const previewStreamHostSetupMessage = (setup: PreviewStreamHostSetup) =>
  setup.need === "sandbox"
    ? "This server's host blocks the sandbox its browser runs in. Run this once on the host, then try again:"
    : "This server's host is missing libraries its browser needs. Run this once on the host, then try again:";
