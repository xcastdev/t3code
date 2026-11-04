// @effect-diagnostics globalTimers:off globalDate:off - Runs inside a sandboxed plugin frame, outside any Effect runtime.
import { T3PluginError, type T3PluginClient } from "@t3tools/plugin-sdk/ui";

import { fill, h, type HeaderPairs, isRecord, messageOf } from "../dom.ts";
import type { NavSlot } from "./nav.ts";
import type { ReplayModel } from "./replays.ts";

export type FlowType = "http" | "websocket" | "tunnel" | "other";

export interface Summary {
  readonly kind: "request";
  readonly id: string;
  readonly seq: number;
  readonly recordingId?: string;
  readonly proxyId?: string;
  readonly startedAt?: number;
  readonly method?: string;
  readonly scheme?: string;
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  readonly status?: number;
  readonly error?: string;
  readonly replayOf?: string;
  readonly requestBytes?: number;
  readonly responseBytes?: number;
  readonly flowType?: FlowType;
  /** Tunnel rows only. */
  readonly sni?: string;
  readonly clientAddr?: string;
  readonly endedAt?: number;
  readonly bytesUp?: number;
  readonly bytesDown?: number;
  readonly removed?: true;
}

export interface RecordingView {
  readonly id: string;
  readonly proxyId: string;
  readonly name?: string;
  readonly startedAt: number;
  readonly stoppedAt?: number;
  readonly listenHost: string;
  readonly listenPort: number;
  readonly requestCount: number;
  readonly droppedFlows: number;
}

export type ProxyState = "stopped" | "starting" | "running" | "failed";

/** How a proxy relates to the panel's chat, from `list_proxies`. */
export type CallerLink = "thread" | "project" | "parentThread" | "rootThread";

export interface ProxyView {
  readonly kind: "proxy";
  readonly id: string;
  readonly name: string;
  readonly state: ProxyState;
  readonly stateDetail?: string;
  readonly listen: { readonly host: string; readonly port: number } | null;
  readonly requested: { readonly host: string; readonly port: number | "auto" };
  readonly mode: {
    readonly kind: "regular" | "socks5" | "upstream";
    readonly url?: string;
    readonly hasAuth?: boolean;
  };
  readonly passthroughHosts: ReadonlyArray<string>;
  readonly ignoredHosts: ReadonlyArray<string>;
  readonly recording: {
    readonly id: string;
    readonly name?: string;
    readonly startedAt: number;
    readonly droppedFlows: number;
  } | null;
  readonly restartRequired: boolean;
  readonly links: ReadonlyArray<{ readonly kind: "thread" | "project"; readonly id: string }>;
  readonly callerLink: CallerLink | null;
  readonly deletedAt: number | null;
}

export interface Caller {
  readonly threadId: string | null;
  readonly projectId: string | null;
  readonly parentThreadId: string | null;
  readonly rootThreadId: string | null;
}

export interface BodyInfo {
  readonly capturedBytes: number;
  readonly declaredBytes?: number;
  readonly truncated: boolean;
  readonly contentEncoding?: string;
  readonly isText: boolean;
}

export type Headers = HeaderPairs;

export interface Detail {
  readonly id: string;
  readonly recordingId: string;
  readonly proxyId: string;
  readonly startedAt: number;
  readonly flowType: FlowType;
  readonly method: string;
  readonly scheme: string;
  readonly host: string;
  readonly port: number;
  readonly authority: string;
  readonly path: string;
  readonly pathTruncated?: true;
  readonly httpVersion: string;
  readonly replayOf?: string;
  readonly error?: string;
  readonly sni?: string;
  readonly clientAddr?: string;
  readonly endedAt?: number;
  readonly bytesUp?: number;
  readonly bytesDown?: number;
  readonly request: { headers: Headers; headersTruncated: boolean; body?: BodyInfo };
  readonly response?: {
    status: number;
    reason?: string;
    httpVersion: string;
    headers: Headers;
    headersTruncated: boolean;
    body?: BodyInfo;
  };
}

export interface ReadBodyResult {
  readonly base64: string;
  readonly offset: number;
  readonly length: number;
  readonly totalBytes: number;
  readonly eof: boolean;
  readonly truncatedAtCapture: boolean;
}

export type BodyEdit = { kind: "inline"; base64: string } | { kind: "draft"; draftId: string };

export interface Edits {
  method?: string;
  url?: string;
  headers?: Array<[string, string]>;
  body?: BodyEdit;
}

export interface ReplayRequest {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly edits?: Edits;
}

export interface ReplayEntryInput {
  readonly request: ReplayRequest;
  readonly label: string;
}

export const CHUNK_BYTES = 131072;

export const explainCallFailure = (error: unknown) => {
  if (error instanceof T3PluginError && error.reason === "not-running") {
    return `${error.message} Check its status in Settings → Plugins; it may be missing mitmdump.`;
  }
  return messageOf(error);
};

export interface Emitter<T> {
  readonly emit: (value: T) => void;
  readonly on: (listener: (value: T) => void) => () => void;
}

export const createEmitter = <T = void>(): Emitter<T> => {
  const listeners = new Set<(value: T) => void>();
  return {
    emit: (value) => {
      for (const listener of listeners) listener(value);
    },
    on: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

/** A value with change listeners; setting the same value notifies no one. */
export interface Signal<T> {
  readonly get: () => T;
  readonly set: (value: T) => void;
  readonly subscribe: (listener: (value: T) => void) => () => void;
}

export const createSignal = <T>(initial: T): Signal<T> => {
  let value = initial;
  const changed = createEmitter<T>();
  return {
    get: () => value,
    set: (next) => {
      if (Object.is(next, value)) return;
      value = next;
      changed.emit(next);
    },
    subscribe: changed.on,
  };
};

export interface Notices {
  /** Ids starting with `dismiss:` get a Dismiss button. */
  readonly set: (id: string, tone: "warn" | "error", text: string | null) => void;
}

export const createNotices = (element: HTMLElement): Notices => {
  const notices = new Map<string, { tone: "warn" | "error"; text: string }>();
  const set: Notices["set"] = (id, tone, text) => {
    if (text === null) notices.delete(id);
    else notices.set(id, { tone, text });
    fill(
      element,
      ...[...notices.entries()].map(([key, notice]) =>
        h(
          "div",
          { class: `notice ${notice.tone} row` },
          h("span", { class: "spacer" }, notice.text),
          key.startsWith("dismiss:") &&
            h(
              "button",
              { type: "button", class: "ghost", onclick: () => set(key, "warn", null) },
              "Dismiss",
            ),
        ),
      ),
    );
  };
  return { set };
};

/**
 * Each slice has its own byte cap so one cannot crowd out the rest; together they stay well
 * under the host's 240 KiB state limit. Unsettled Sends get the most room.
 */
const SLICE_BYTES: Readonly<Record<string, number>> = {
  replays: 120 * 1024,
  replayer: 40 * 1024,
  replayHistory: 24 * 1024,
  decoder: 16 * 1024,
};
const DEFAULT_SLICE_BYTES = 4 * 1024;

export const sliceBytes = (key: string) => SLICE_BYTES[key] ?? DEFAULT_SLICE_BYTES;

const encoder = new TextEncoder();
export const jsonBytes = (value: unknown) =>
  value === undefined ? 0 : encoder.encode(JSON.stringify(value)).length;

/**
 * Panel state is one `{ v: 1, ...slices }` object. Each view registers the top-level keys it
 * owns and reads its restored value back from `restored`. A slice's `read` gets its byte cap
 * and should trim to fit; a slice still over its cap is not saved.
 */
export interface Persistence {
  readonly restored: Readonly<Record<string, unknown>>;
  readonly register: (key: string, read: (maxBytes: number) => unknown) => () => void;
  readonly soon: () => void;
  /** Resolves false when the host did not keep the state. */
  readonly now: () => Promise<boolean>;
}

export const createPersistence = (client: T3PluginClient, stored: unknown): Persistence => {
  const restored: Record<string, unknown> = {};
  if (isRecord(stored) && stored.v === 1) {
    for (const [key, value] of Object.entries(stored)) if (key !== "v") restored[key] = value;
  }
  const slices = new Map<string, (maxBytes: number) => unknown>();
  let lastSave: Promise<void> = Promise.resolve();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const now = (): Promise<boolean> => {
    clearTimeout(saveTimer);
    // Slices of views that have not mounted yet keep their restored value.
    const value: Record<string, unknown> = { v: 1 };
    for (const key of new Set([...Object.keys(restored), ...slices.keys()])) {
      const read = slices.get(key);
      const slice = read === undefined ? restored[key] : read(sliceBytes(key));
      if (jsonBytes(slice) <= sliceBytes(key)) value[key] = slice;
    }
    const saved = lastSave.then(() =>
      client.state.set(value).then(
        () => true,
        () => false,
      ),
    );
    lastSave = saved.then(() => undefined);
    return saved;
  };

  return {
    restored,
    register: (key, read) => {
      slices.set(key, read);
      return () => {
        if (slices.get(key) === read) slices.delete(key);
      };
    },
    soon: () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void now(), 400);
    },
    now,
  };
};

export interface ProxiesFeed {
  /** True once the first `proxies` snapshot and `list_proxies` answer arrived. */
  readonly ready: () => boolean;
  /** Live proxies in id order, then deleted ones. */
  readonly list: () => ReadonlyArray<ProxyView>;
  readonly get: (id: string) => ProxyView | undefined;
  readonly storageBlocked: () => boolean;
  /** The panel's chat as `list_proxies` resolved it; null until it answers. */
  readonly caller: () => Caller | null;
  /** The proxy linked to the panel's chat or its project. */
  readonly defaultProxyId: () => string | null;
  /** The proxy chosen in the app bar's strip; null browses every proxy. */
  readonly selected: Signal<string | null>;
  /** A pick by hand; the selection stops following the chat's default until the chat changes. */
  readonly select: (id: string | null) => void;
  /** Drops a pick by hand so the selection follows the chat's default again. */
  readonly followDefault: () => void;
  /** Re-reads `list_proxies` (caller, default proxy, caller links). */
  readonly refresh: () => void;
  /** Any proxy, status, or caller change. */
  readonly on: (listener: () => void) => () => void;
}

export interface App {
  readonly client: T3PluginClient;
  /** The nav slot on screen. Setting it switches views. */
  readonly view: Signal<NavSlot>;
  readonly notices: Notices;
  readonly persistence: Persistence;
  /** The request open in the detail pane. */
  readonly selection: Signal<string | null>;
  /** A live batch changed this request's summary. */
  readonly requestUpdated: Emitter<string>;
  readonly proxies: ProxiesFeed;
  readonly replays: ReplayModel;
  /** Requests ticked in the list's select mode, for multi-request actions; empty outside it. */
  readonly checked: Signal<ReadonlySet<string>>;
  /** Asks the Replayer to open a tab for this request; the emitter switches to it. */
  readonly sendToReplayer: Emitter<string>;
  /** Asks the Decoder to start a chain from this value. */
  readonly sendToDecoder: Emitter<DecoderInput>;
}

export type DecoderInput =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "header";
      readonly requestId: string;
      readonly side: "request" | "response";
      readonly header: string;
    }
  | { readonly kind: "body"; readonly requestId: string; readonly side: "request" | "response" };

/** Each view module exports this shape. Nested views export `mount` and `styles` only. */
export interface ViewModule {
  readonly styles: string;
  readonly mount: (root: HTMLElement, app: App) => () => void;
}
