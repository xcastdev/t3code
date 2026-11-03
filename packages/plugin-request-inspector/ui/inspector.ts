// @effect-diagnostics globalTimers:off globalDate:off - Runs inside a sandboxed plugin frame, outside any Effect runtime.
import type { PluginSubscriptionEvent } from "@t3tools/contracts";
import {
  connectT3,
  type PluginHostContext,
  T3PluginError,
  type T3PluginClient,
} from "@t3tools/plugin-sdk/ui";

import { requestOrigin } from "../backend/origin.ts";
import { MISSING_DETAILS, REPLAY_DETAILS, replayRefusalOutcome } from "../backend/refusals.ts";
import {
  createReplayTracker,
  type GetReplayResult,
  MAX_UNSETTLED_REPLAYS,
  mayHaveBeenSent,
  parseReplayStatus,
  type ReplayStatus,
  type ReplayTracker,
  type TrackedReplay,
} from "./replayTracker.ts";

interface Summary {
  readonly kind: "request";
  readonly id: string;
  readonly seq: number;
  readonly captureId?: string;
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
  readonly flowType?: string;
  readonly removed?: true;
}

interface CaptureRecord {
  readonly id: string;
  readonly startedAt: number;
  readonly stoppedAt?: number;
  readonly listenHost: string;
  readonly listenPort: number;
  readonly requestCount: number;
}

interface CaptureItem {
  readonly kind: "capture";
  readonly running: CaptureRecord | null;
  readonly droppedFlows: number;
  readonly storageBlocked: boolean;
}

interface BodyInfo {
  readonly capturedBytes: number;
  readonly declaredBytes?: number;
  readonly truncated: boolean;
  readonly contentEncoding?: string;
  readonly isText: boolean;
}

type Headers = ReadonlyArray<readonly [string, string]>;

interface Detail {
  readonly id: string;
  readonly captureId: string;
  readonly startedAt: number;
  readonly flowType: string;
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

interface ReadBodyResult {
  readonly base64: string;
  readonly offset: number;
  readonly length: number;
  readonly totalBytes: number;
  readonly eof: boolean;
  readonly truncatedAtCapture: boolean;
}

interface Preview {
  readonly destination: { scheme: string; host: string; port: number };
  readonly method: string;
  readonly path: string;
  readonly bodyBytes: number;
  readonly refusal?: string;
  readonly idempotencyKey: string;
}

type BodyEdit = { kind: "inline"; base64: string } | { kind: "draft"; draftId: string };

interface Edits {
  method?: string;
  url?: string;
  headers?: Array<[string, string]>;
  body?: BodyEdit;
}

interface ReplayRequest {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly edits?: Edits;
}

interface ReplayEntryInput {
  readonly request: ReplayRequest;
  readonly label: string;
}

interface Filter {
  query: string;
  method: string;
  host: string;
  status: string;
  captureId: string;
}

interface SavedState {
  readonly v: 1;
  readonly filter: Filter;
  readonly selected: string | null;
  readonly replays: ReadonlyArray<TrackedReplay<ReplayEntryInput>>;
}

const CHUNK_BYTES = 131072;
// Larger edited bodies go through a draft so tracked retries stay small in bridge state.
const INLINE_BODY_BYTES = 4096;
/** A Send is kept in bridge state until it settles; larger edits are refused before sending. */
const MAX_SAVED_REPLAY_CHARS = 32 * 1024;
const MAX_BODY_VIEW_BYTES = 4 * 1024 * 1024;
const HEX_VIEW_BYTES = 64 * 1024;
const PAGE_LIMIT = 100;
const MAX_ROWS = 500;
/** Rows past this many, oldest first, can never be shown and are dropped. */
const MAX_HELD_ROWS = 1000;
const SNAPSHOT_TEXT_CHARS = 3000;
const REDACTED = "[redacted]";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Child = Node | string | null | undefined | false;

function h(
  tag: string,
  props: Record<string, string | boolean | ((event: Event) => void)> = {},
  ...children: ReadonlyArray<Child>
): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (typeof value === "function") element.addEventListener(name.slice(2), value);
    else if (value === true) element.setAttribute(name, "");
    else if (value !== false) element.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child);
  }
  return element;
}

const fill = (element: HTMLElement, ...children: ReadonlyArray<Child>) =>
  element.replaceChildren(
    ...children.filter(
      (child): child is Node | string => child !== null && child !== undefined && child !== false,
    ),
  );

const ui = {
  captureText: $("capture-text"),
  captureToggle: $<HTMLButtonElement>("capture-toggle"),
  notices: $("notices"),
  proxyHint: $<HTMLDetailsElement>("proxy-hint"),
  proxyUrl: $("proxy-url"),
  query: $<HTMLInputElement>("f-query"),
  method: $<HTMLSelectElement>("f-method"),
  status: $<HTMLInputElement>("f-status"),
  host: $<HTMLInputElement>("f-host"),
  capture: $<HTMLSelectElement>("f-capture"),
  deleteCapture: $<HTMLButtonElement>("delete-capture"),
  replays: $<HTMLDetailsElement>("replays"),
  replaysSummary: $("replays-summary"),
  replayList: $("replay-list"),
  list: $("list"),
  listCount: $("list-count"),
  loadOlder: $<HTMLButtonElement>("load-older"),
  detail: $("detail"),
  detailTitle: $("detail-title"),
  detailError: $("detail-error"),
  back: $<HTMLButtonElement>("back"),
  closeDetail: $<HTMLButtonElement>("close-detail"),
  tabs: [...document.querySelectorAll<HTMLButtonElement>("[data-tab]")],
  tabHeaders: $("tab-headers"),
  tabBody: $("tab-body"),
  tabReplay: $("tab-replay"),
  bodyDecoded: $<HTMLButtonElement>("body-decoded"),
  bodyRaw: $<HTMLButtonElement>("body-raw"),
  bodyMeta: $("body-meta"),
  bodyView: $("body-view"),
  bodyProgress: $("body-progress"),
  bodyMore: $<HTMLButtonElement>("body-more"),
  rMethod: $<HTMLInputElement>("r-method"),
  rUrl: $<HTMLInputElement>("r-url"),
  rHeaders: $<HTMLTextAreaElement>("r-headers"),
  rBodyOn: $<HTMLInputElement>("r-body-on"),
  rBody: $<HTMLTextAreaElement>("r-body"),
  rNotes: $("r-notes"),
  rDestination: $("r-destination"),
  rReset: $<HTMLButtonElement>("r-reset"),
  rSend: $<HTMLButtonElement>("r-send"),
  attachText: $<HTMLButtonElement>("attach-text"),
  attachRef: $<HTMLButtonElement>("attach-ref"),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const messageOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^The plugin operation failed: /,
    "",
  );

const bytesLabel = (bytes: number | undefined) => {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const timeLabel = (ms: number | undefined) =>
  ms === undefined
    ? ""
    : new Date(ms).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

const compareIdsDesc = (a: string, b: string) =>
  a.length !== b.length ? b.length - a.length : a < b ? 1 : a > b ? -1 : 0;

const statusClass = (status: number | undefined, error: string | undefined) =>
  error !== undefined ? "s5" : status === undefined ? "" : `s${Math.floor(status / 100)}`;

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

const hexDump = (bytes: Uint8Array) => {
  const lines: Array<string> = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = bytes.subarray(offset, offset + 16);
    const hex = [...row].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...row]
      .map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : "."))
      .join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join("\n");
};

const headersText = (headers: Headers) =>
  headers.map(([name, value]) => `${name}: ${value}`).join("\n");

const parseHeaderLines = (text: string): Array<[string, string]> =>
  text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const colon = line.indexOf(":");
      if (colon <= 0) return [line.trim(), ""];
      return [line.slice(0, colon).trim(), line.slice(colon + 1).replace(/^ /, "")];
    });

const isSummary = (value: unknown): value is Summary =>
  isRecord(value) &&
  value.kind === "request" &&
  typeof value.id === "string" &&
  typeof value.seq === "number";

let client: T3PluginClient | undefined;
let filter: Filter = { query: "", method: "", host: "", status: "", captureId: "" };
let selectedId: string | null = null;
let tracker: ReplayTracker<ReplayEntryInput> | undefined;
let lastSave: Promise<void> = Promise.resolve();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** An accepted replay is only ever polled by id, so its edits are not kept. */
const savedReplay = (entry: TrackedReplay<ReplayEntryInput>): TrackedReplay<ReplayEntryInput> => {
  if (entry.replayId === undefined || entry.input.request.edits === undefined) return entry;
  const { requestId, idempotencyKey } = entry.input.request;
  return { ...entry, input: { label: entry.input.label, request: { requestId, idempotencyKey } } };
};

const savedState = (): SavedState => ({
  v: 1,
  filter,
  selected: selectedId,
  replays: (tracker?.tracked() ?? []).map(savedReplay),
});

/** Resolves false when the host did not keep the state. */
const persistNow = (): Promise<boolean> => {
  clearTimeout(saveTimer);
  const value = savedState();
  const saved = lastSave.then(async () => {
    if (client === undefined) return false;
    return client.state.set(value).then(
      () => true,
      () => false,
    );
  });
  lastSave = saved.then(() => undefined);
  return saved;
};

const persistSoon = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void persistNow(), 400);
};

const readSavedState = (value: unknown): Partial<SavedState> => {
  if (!isRecord(value) || value.v !== 1) return {};
  const result: { filter?: Filter; selected?: string | null; replays?: SavedState["replays"] } = {};
  if (isRecord(value.filter)) {
    const raw = value.filter;
    const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : "");
    result.filter = {
      query: text("query"),
      method: text("method"),
      host: text("host"),
      status: text("status"),
      captureId: text("captureId"),
    };
  }
  if (typeof value.selected === "string" || value.selected === null) {
    result.selected = value.selected;
  }
  if (Array.isArray(value.replays)) {
    result.replays = value.replays.filter(
      (entry): entry is TrackedReplay<ReplayEntryInput> =>
        isRecord(entry) &&
        typeof entry.key === "string" &&
        (entry.replayId === undefined || typeof entry.replayId === "string") &&
        isRecord(entry.input) &&
        typeof entry.input.label === "string" &&
        isRecord(entry.input.request) &&
        entry.input.request.idempotencyKey === entry.key,
    );
  }
  return result;
};

const notices = new Map<string, { tone: "warn" | "error"; text: string }>();

const setNotice = (id: string, tone: "warn" | "error", text: string | null) => {
  if (text === null) notices.delete(id);
  else notices.set(id, { tone, text });
  fill(
    ui.notices,
    ...[...notices.entries()].map(([key, notice]) =>
      h(
        "div",
        { class: `notice ${notice.tone} row` },
        h("span", { class: "spacer" }, notice.text),
        key.startsWith("dismiss:") &&
          h(
            "button",
            { type: "button", class: "ghost", onclick: () => setNotice(key, "warn", null) },
            "Dismiss",
          ),
      ),
    ),
  );
};

const explainCallFailure = (error: unknown) => {
  if (error instanceof T3PluginError && error.reason === "not-running") {
    return `${error.message} Check its status in Settings → Plugins; it may be missing mitmdump.`;
  }
  return messageOf(error);
};

let captureState: CaptureItem | undefined;
let captureBusy = false;

const renderCapture = () => {
  const state = captureState;
  const running = state?.running ?? null;
  const dot = h("span", { class: running === null ? "dot" : "dot live" });
  if (state === undefined) {
    ui.captureText.replaceChildren(dot, "Connecting…");
  } else if (running === null) {
    ui.captureText.replaceChildren(dot, "Not capturing");
  } else {
    ui.captureText.replaceChildren(
      dot,
      `Capturing on ${running.listenHost}:${running.listenPort} since ${timeLabel(running.startedAt)}`,
    );
  }
  ui.captureText.title = ui.captureText.textContent ?? "";
  ui.captureToggle.textContent = running === null ? "Start capture" : "Stop capture";
  ui.captureToggle.className = running === null ? "primary" : "";
  ui.captureToggle.disabled = state === undefined || captureBusy;
  ui.proxyHint.hidden = running === null;
  if (running !== null)
    ui.proxyUrl.textContent = `http://${running.listenHost}:${running.listenPort}`;
  setNotice(
    "dropped",
    "warn",
    state !== undefined && state.droppedFlows > 0
      ? `${state.droppedFlows} flow${state.droppedFlows === 1 ? " was" : "s were"} dropped: the storage budget is full or the capture reached its request limit. Delete old captures or raise the limits in the plugin's settings.`
      : null,
  );
  setNotice(
    "blocked",
    "warn",
    state?.storageBlocked === true
      ? "Storage is blocked: another program is holding the inspector database open, so new flows are dropped until it closes."
      : null,
  );
};

ui.captureToggle.addEventListener("click", async () => {
  if (client === undefined || captureState === undefined) return;
  const starting = captureState.running === null;
  captureBusy = true;
  renderCapture();
  setNotice("capture", "error", null);
  try {
    await client.call(starting ? "start_capture" : "stop_capture", {});
  } catch (error) {
    setNotice("capture", "error", explainCallFailure(error));
  } finally {
    captureBusy = false;
    renderCapture();
  }
});

let captures: ReadonlyArray<CaptureRecord> = [];
let capturesTimer: ReturnType<typeof setTimeout> | undefined;

const renderCaptureOptions = () => {
  const options = [h("option", { value: "" }, "All captures")];
  for (const capture of captures) {
    const when = new Date(capture.startedAt).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    options.push(
      h(
        "option",
        { value: capture.id },
        `#${capture.id} · ${when}${capture.stoppedAt === undefined ? " · live" : ""}`,
      ),
    );
  }
  if (filter.captureId !== "" && !captures.some((capture) => capture.id === filter.captureId)) {
    options.push(h("option", { value: filter.captureId }, `#${filter.captureId}`));
  }
  ui.capture.replaceChildren(...options);
  ui.capture.value = filter.captureId;
  const chosen = captures.find((capture) => capture.id === filter.captureId);
  ui.deleteCapture.hidden = chosen === undefined || chosen.stoppedAt === undefined;
};

const loadCaptures = () => {
  clearTimeout(capturesTimer);
  capturesTimer = setTimeout(async () => {
    if (client === undefined) return;
    try {
      const result = await client.call("list_captures", {});
      if (isRecord(result) && Array.isArray(result.items)) {
        captures = result.items as ReadonlyArray<CaptureRecord>;
        renderCaptureOptions();
      }
    } catch {
      // The list is a convenience; the capture filter still works by id.
    }
  }, 150);
};

// Sandboxed frames cannot open confirm(), so the first click arms the button.
let deleteArmedFor: string | undefined;
ui.deleteCapture.addEventListener("blur", () => {
  deleteArmedFor = undefined;
  ui.deleteCapture.textContent = "Delete capture";
});
ui.deleteCapture.addEventListener("click", async () => {
  if (client === undefined || filter.captureId === "") return;
  const captureId = filter.captureId;
  if (deleteArmedFor !== captureId) {
    deleteArmedFor = captureId;
    ui.deleteCapture.textContent = `Delete #${captureId} and its requests?`;
    return;
  }
  deleteArmedFor = undefined;
  ui.deleteCapture.textContent = "Delete capture";
  try {
    await client.call("delete_capture", { captureId });
    filter = { ...filter, captureId: "" };
    renderCaptureOptions();
    resubscribeRequests();
    persistSoon();
  } catch (error) {
    setNotice("dismiss:delete", "error", explainCallFailure(error));
  }
});

const rows = new Map<string, Summary>();
/** seq of each recent removal, so a stale page cannot bring a pruned row back. */
const removedRows = new Map<string, number>();
let snapshotRevision: string | null = null;
let pageCursor: string | null = null;
let listLive: "connecting" | "live" | "resyncing" | "closed" = "connecting";
let closeRequests: (() => void) | undefined;
let requestsGeneration = 0;
/** Bumped by every snapshot and resubscribe; a page fetched under an older list is dropped. */
let listGeneration = 0;
let renderQueued = false;

/** Keeps the summary with the highest seq for each id, so a stale page never resurrects a row. */
const mergeSummary = (summary: Summary) => {
  const held = rows.get(summary.id);
  if (held !== undefined && held.seq >= summary.seq) return false;
  const removedAt = removedRows.get(summary.id);
  if (removedAt !== undefined && removedAt >= summary.seq) return false;
  if (summary.removed === true) {
    rows.delete(summary.id);
    removedRows.set(summary.id, summary.seq);
    for (const id of removedRows.keys()) {
      if (removedRows.size <= MAX_HELD_ROWS) break;
      removedRows.delete(id);
    }
  } else {
    rows.set(summary.id, summary);
  }
  return true;
};

const clearRows = () => {
  rows.clear();
  removedRows.clear();
};

const scheduleRender = () => {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderList();
  });
};

const renderList = () => {
  const visible = [...rows.values()].sort((a, b) => compareIdsDesc(a.id, b.id));
  for (const row of visible.splice(MAX_HELD_ROWS)) rows.delete(row.id);
  const fragment = document.createDocumentFragment();
  for (const row of visible.slice(0, MAX_ROWS)) {
    const statusText =
      row.error !== undefined ? "ERR" : row.status === undefined ? "…" : String(row.status);
    fragment.append(
      h(
        "li",
        {},
        h(
          "button",
          {
            type: "button",
            class: "req",
            role: "option",
            "aria-selected": String(row.id === selectedId),
            "data-id": row.id,
          },
          h("span", { class: "method" }, row.method ?? ""),
          h("span", { class: "path", title: `${row.host ?? ""}${row.path ?? ""}` }, row.path ?? ""),
          h("span", { class: `status ${statusClass(row.status, row.error)}` }, statusText),
          h(
            "span",
            { class: "meta" },
            row.replayOf !== undefined && h("span", { class: "tag" }, "replay"),
            row.flowType !== undefined &&
              row.flowType !== "http" &&
              h("span", { class: "tag" }, row.flowType),
            [row.host, timeLabel(row.startedAt), bytesLabel(row.responseBytes)]
              .filter((part) => part !== undefined && part !== "")
              .join(" · "),
          ),
        ),
      ),
    );
  }
  if (visible.length === 0) {
    const hasFilter =
      filter.query !== "" ||
      filter.method !== "" ||
      filter.host !== "" ||
      filter.status !== "" ||
      filter.captureId !== "";
    fragment.append(
      h(
        "li",
        { class: "empty" },
        listLive === "connecting"
          ? "Loading requests…"
          : hasFilter
            ? "No requests match these filters."
            : captureState?.running
              ? "Waiting for traffic. Send requests through the proxy to see them here."
              : "No captured requests yet. Start a capture and route a client through the proxy.",
      ),
    );
  }
  ui.list.replaceChildren(fragment);
  const shown = Math.min(visible.length, MAX_ROWS);
  ui.listCount.textContent =
    listLive === "resyncing"
      ? "Resyncing…"
      : listLive === "closed"
        ? "Updates stopped"
        : visible.length > MAX_ROWS
          ? `Showing ${shown} of ${visible.length}; narrow the filters`
          : `${visible.length} request${visible.length === 1 ? "" : "s"}`;
  ui.loadOlder.hidden = pageCursor === null || listLive !== "live";
};

const filterParams = () => {
  const status = Number.parseInt(filter.status, 10);
  return {
    ...(filter.query.trim() === "" ? {} : { query: filter.query.trim() }),
    ...(filter.method === "" ? {} : { method: filter.method }),
    ...(filter.host.trim() === "" ? {} : { host: filter.host.trim() }),
    ...(Number.isInteger(status) && status >= 100 && status <= 999 ? { status } : {}),
  };
};

const onRequestsEvent = (generation: number, event: PluginSubscriptionEvent) => {
  if (generation !== requestsGeneration) return;
  switch (event.type) {
    case "snapshot": {
      listGeneration += 1;
      clearRows();
      for (const item of event.items) if (isSummary(item)) mergeSummary(item);
      snapshotRevision = event.revision;
      pageCursor = event.cursor;
      listLive = "live";
      setNotice("requests", "warn", null);
      break;
    }
    case "batch": {
      let touchedSelection = false;
      for (const item of event.items) {
        if (isSummary(item) && mergeSummary(item) && item.id === selectedId) {
          touchedSelection = true;
        }
      }
      if (touchedSelection) refreshDetailSoon();
      break;
    }
    case "resync":
      listGeneration += 1;
      listLive = "resyncing";
      break;
    case "closed":
      listLive = "closed";
      setNotice(
        "requests",
        "warn",
        event.reason === "plugin-disabled"
          ? "The inspector was disabled. Enable it in Settings → Plugins."
          : `Live updates stopped (${event.reason}). Reopen the panel to reconnect.`,
      );
      break;
  }
  scheduleRender();
};

const resubscribeRequests = () => {
  if (client === undefined) return;
  closeRequests?.();
  requestsGeneration += 1;
  const generation = requestsGeneration;
  listGeneration += 1;
  clearRows();
  snapshotRevision = null;
  pageCursor = null;
  listLive = "connecting";
  scheduleRender();
  closeRequests = client.subscribe(
    "requests",
    {
      ...(filter.captureId === "" ? {} : { captureId: filter.captureId }),
      filter: filterParams(),
    },
    (event) => onRequestsEvent(generation, event),
  );
};

ui.loadOlder.addEventListener("click", async () => {
  if (client === undefined || pageCursor === null) return;
  const generation = listGeneration;
  ui.loadOlder.disabled = true;
  try {
    const page = await client.call("search_requests", {
      ...filterParams(),
      ...(filter.captureId === "" ? {} : { captureId: filter.captureId }),
      limit: PAGE_LIMIT,
      cursor: pageCursor,
    });
    // A page from before the latest snapshot may hold rows that snapshot replaced; drop it.
    if (generation !== listGeneration || !isRecord(page) || page.revision !== snapshotRevision) {
      return;
    }
    if (Array.isArray(page.items))
      for (const item of page.items) if (isSummary(item)) mergeSummary(item);
    pageCursor = typeof page.cursor === "string" ? page.cursor : null;
    scheduleRender();
  } catch (error) {
    setNotice("dismiss:page", "error", explainCallFailure(error));
  } finally {
    ui.loadOlder.disabled = false;
  }
});

ui.list.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-id]");
  const id = target?.dataset.id;
  if (id !== undefined) select(id);
});

let filterTimer: ReturnType<typeof setTimeout> | undefined;
const onFilterInput = () => {
  filter = {
    query: ui.query.value,
    method: ui.method.value,
    host: ui.host.value,
    status: ui.status.value,
    captureId: ui.capture.value,
  };
  ui.deleteCapture.hidden = !captures.some(
    (capture) => capture.id === filter.captureId && capture.stoppedAt !== undefined,
  );
  clearTimeout(filterTimer);
  filterTimer = setTimeout(resubscribeRequests, 250);
  persistSoon();
};
for (const input of [ui.query, ui.host, ui.status]) input.addEventListener("input", onFilterInput);
for (const select of [ui.method, ui.capture]) select.addEventListener("change", onFilterInput);

type Tab = "headers" | "request" | "response" | "replay";

let detail: Detail | undefined;
let detailMissing = false;
let showSensitive = false;
let tab: Tab = "headers";
let detailGeneration = 0;
let detailTimer: ReturnType<typeof setTimeout> | undefined;

const select = (id: string | null) => {
  if (id === selectedId) return;
  selectedId = id;
  detail = undefined;
  detailMissing = false;
  showSensitive = false;
  editor.reset();
  document.body.classList.toggle("has-detail", id !== null);
  ui.detail.hidden = id === null;
  persistSoon();
  scheduleRender();
  if (id !== null) void loadDetail();
  else renderDetail();
};

const refreshDetailSoon = () => {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(() => void loadDetail(), 300);
};

const loadDetail = async () => {
  if (client === undefined || selectedId === null) return;
  const generation = ++detailGeneration;
  const requestId = selectedId;
  renderDetail();
  try {
    const result = await client.call("get_request", {
      requestId,
      bodies: "none",
      includeSensitiveHeaders: showSensitive,
    });
    if (generation !== detailGeneration) return;
    const previous = detail;
    detail = result as Detail;
    detailMissing = false;
    ui.detailError.textContent = "";
    if (previous?.id !== detail.id) editor.load(detail);
    else editor.syncHeaders(detail);
    if (tab === "request" || tab === "response")
      void bodyViewer.open(tab, previous?.id === detail.id);
  } catch (error) {
    if (generation !== detailGeneration) return;
    detailMissing = messageOf(error) === MISSING_DETAILS.request;
    ui.detailError.textContent = detailMissing ? "" : explainCallFailure(error);
  }
  renderDetail();
};

const headerTable = (headers: Headers) =>
  h(
    "table",
    { class: "headers" },
    h(
      "tbody",
      {},
      ...headers.map(([name, value]) =>
        h(
          "tr",
          {},
          h("td", {}, name),
          h("td", { class: value === REDACTED ? "faint" : "" }, value),
        ),
      ),
    ),
  );

const requestLine = (value: Detail) =>
  `${value.method} ${value.scheme}://${requestOrigin(value)}${value.path}${value.pathTruncated ? "…" : ""}`;

const renderHeadersTab = (value: Detail) => {
  const response = value.response;
  const anyTruncated = value.request.headersTruncated || response?.headersTruncated === true;
  fill(
    ui.tabHeaders,
    h(
      "div",
      { class: "row" },
      h("h3", { class: "spacer" }, "Request"),
      h(
        "label",
        { class: "check" },
        h("input", {
          type: "checkbox",
          ...(showSensitive ? { checked: true } : {}),
          onchange: (event: Event) => {
            showSensitive = (event.target as HTMLInputElement).checked;
            void loadDetail();
          },
        }),
        "Show credentials",
      ),
    ),
    h("div", { class: "line" }, `${requestLine(value)} ${value.httpVersion}`),
    value.replayOf !== undefined &&
      h("div", { class: "muted" }, `Replay result (replay ${value.replayOf.slice(0, 8)})`),
    headerTable(value.request.headers),
    h("h3", {}, "Response"),
    response === undefined
      ? h(
          "div",
          { class: value.error === undefined ? "muted" : "notice error" },
          value.error ?? "No response yet.",
        )
      : h(
          "div",
          { class: `line ${statusClass(response.status, undefined)}` },
          `${response.httpVersion} ${response.status}${response.reason ? ` ${response.reason}` : ""}`,
        ),
    response !== undefined && headerTable(response.headers),
    anyTruncated &&
      h(
        "div",
        { class: "faint" },
        "Long header values are cut here. Replay uses the full stored headers.",
      ),
  );
};

const renderDetail = () => {
  for (const button of ui.tabs)
    button.setAttribute("aria-selected", String(button.dataset.tab === tab));
  ui.tabHeaders.hidden = tab !== "headers";
  ui.tabBody.hidden = tab !== "request" && tab !== "response";
  ui.tabReplay.hidden = tab !== "replay";
  const value = detail?.id === selectedId ? detail : undefined;
  ui.detailTitle.textContent =
    value === undefined ? (detailMissing ? "Request deleted" : "Loading…") : requestLine(value);
  ui.detailTitle.title = ui.detailTitle.textContent;
  if (detailMissing) {
    ui.tabHeaders.replaceChildren(
      h(
        "div",
        { class: "empty" },
        "This request no longer exists. It may have been pruned or its capture deleted.",
      ),
    );
    ui.tabHeaders.hidden = false;
    ui.tabBody.hidden = true;
    ui.tabReplay.hidden = true;
  } else if (value !== undefined) {
    renderHeadersTab(value);
  }
  const canAttach = value !== undefined && client?.context.chatTarget != null;
  ui.attachRef.disabled = !canAttach;
  ui.attachText.disabled = !canAttach;
  const target = client?.context.chatTarget;
  ui.attachRef.title =
    target == null ? "Open a chat to attach this request." : `Attach to ${target.title}`;
  ui.attachText.title = ui.attachRef.title;
};

for (const button of ui.tabs) {
  button.addEventListener("click", () => {
    tab = button.dataset.tab as Tab;
    renderDetail();
    if (tab === "request" || tab === "response") void bodyViewer.open(tab, false);
    if (tab === "replay") editor.refreshPreview();
  });
}
ui.back.addEventListener("click", () => select(null));
ui.closeDetail.addEventListener("click", () => select(null));

const bodyViewer = (() => {
  let side: "request" | "response" = "request";
  let decoded = true;
  let chunks: Array<Uint8Array> = [];
  let loaded = 0;
  let total: number | undefined;
  let eof = false;
  let generation = 0;
  let forRequest: string | undefined;

  const info = () => (side === "request" ? detail?.request.body : detail?.response?.body);

  const render = () => {
    const body = info();
    ui.bodyDecoded.setAttribute("aria-pressed", String(decoded));
    ui.bodyRaw.setAttribute("aria-pressed", String(!decoded));
    const encoding = body?.contentEncoding;
    ui.bodyDecoded.disabled = encoding === undefined;
    if (body === undefined) {
      ui.bodyMeta.textContent = "";
      ui.bodyView.textContent =
        side === "response" && detail?.response === undefined ? "No response." : "No body.";
      ui.bodyProgress.textContent = "";
      ui.bodyMore.hidden = true;
      return;
    }
    ui.bodyMeta.textContent = [
      `${bytesLabel(body.capturedBytes)} captured`,
      body.declaredBytes !== undefined && body.declaredBytes !== body.capturedBytes
        ? `of ${bytesLabel(body.declaredBytes)}`
        : "",
      encoding ?? "",
      body.truncated ? "cut at capture" : "",
    ]
      .filter((part) => part !== "")
      .join(" · ");
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const asText = body.isText && (decoded || encoding === undefined);
    if (loaded === 0 && eof) ui.bodyView.textContent = "Empty body.";
    else if (asText) ui.bodyView.textContent = new TextDecoder().decode(bytes);
    else {
      ui.bodyView.textContent =
        hexDump(bytes.subarray(0, HEX_VIEW_BYTES)) +
        (bytes.length > HEX_VIEW_BYTES
          ? `\n… ${bytesLabel(bytes.length - HEX_VIEW_BYTES)} more loaded`
          : "");
    }
    ui.bodyProgress.textContent =
      total === undefined ? "" : `${bytesLabel(loaded)} of ${bytesLabel(total)} shown`;
    ui.bodyMore.hidden = eof || loaded >= MAX_BODY_VIEW_BYTES;
  };

  const loadChunk = async () => {
    if (client === undefined || detail === undefined || info() === undefined) return render();
    const run = generation;
    ui.bodyMore.disabled = true;
    try {
      const result = (await client.call("read_body", {
        requestId: detail.id,
        side,
        offset: loaded,
        length: CHUNK_BYTES,
        decoded,
      })) as ReadBodyResult;
      if (run !== generation) return;
      const chunk = fromBase64(result.base64);
      chunks.push(chunk);
      loaded += chunk.length;
      total = result.totalBytes;
      eof = result.eof || chunk.length === 0;
    } catch (error) {
      if (run !== generation) return;
      ui.bodyView.textContent = explainCallFailure(error);
      eof = true;
    } finally {
      ui.bodyMore.disabled = false;
    }
    render();
  };

  const open = async (next: "request" | "response", keep: boolean) => {
    if (keep && next === side && forRequest === detail?.id && loaded > 0) return render();
    side = next;
    forRequest = detail?.id;
    generation += 1;
    chunks = [];
    loaded = 0;
    total = undefined;
    eof = false;
    decoded = info()?.contentEncoding !== undefined ? decoded : true;
    ui.bodyView.textContent = "Loading…";
    await loadChunk();
  };

  ui.bodyMore.addEventListener("click", () => void loadChunk());
  ui.bodyDecoded.addEventListener("click", () => {
    if (decoded) return;
    decoded = true;
    void open(side, false);
  });
  ui.bodyRaw.addEventListener("click", () => {
    if (!decoded) return;
    decoded = false;
    void open(side, false);
  });
  return { open };
})();

const editor = (() => {
  let source: Detail | undefined;
  let originalUrl = "";
  let originalHeaders = "";
  let key: string | undefined;
  let preview: Preview | undefined;
  let previewError: string | undefined;
  let previewRun = 0;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  let draft: { text: string; draftId: string } | undefined;

  const render = () => {
    const notes: Array<Child> = [];
    const headersEdited = ui.rHeaders.value !== originalHeaders;
    if (headersEdited && ui.rHeaders.value.includes(REDACTED)) {
      notes.push(
        h(
          "div",
          { class: "notice warn" },
          `Edited headers still contain "${REDACTED}" placeholders, which would be sent literally. Turn on "Show credentials" in Headers before editing, or remove those lines.`,
        ),
      );
    }
    if (source?.request.body?.truncated === true && !ui.rBodyOn.checked) {
      notes.push(
        h(
          "div",
          { class: "faint" },
          "The captured body is incomplete. Replace the body to replay this request.",
        ),
      );
    }
    if (source?.request.headersTruncated === true) {
      notes.push(
        h(
          "div",
          { class: "faint" },
          "Some headers are too long to edit here; replay keeps the stored headers.",
        ),
      );
    }
    if (source?.pathTruncated === true) {
      notes.push(
        h(
          "div",
          { class: "faint" },
          "The URL is too long to edit here; replay keeps the stored URL.",
        ),
      );
    }
    fill(ui.rNotes, ...notes);

    if (previewError !== undefined) {
      ui.rDestination.replaceChildren(h("span", { class: "state-failed" }, previewError));
    } else if (preview === undefined) {
      ui.rDestination.textContent = "Checking destination…";
    } else {
      const { destination } = preview;
      fill(
        ui.rDestination,
        h(
          "div",
          {},
          h("span", { class: "muted" }, "Sends to "),
          `${destination.scheme}://${destination.host}:${destination.port}`,
        ),
        h(
          "div",
          {},
          `${preview.method} ${preview.path}`,
          h("span", { class: "muted" }, ` · ${bytesLabel(preview.bodyBytes)} body`),
        ),
        preview.refusal !== undefined && h("div", { class: "state-failed" }, preview.refusal),
      );
    }
    const full = tracker?.isFull() ?? false;
    ui.rSend.disabled =
      key === undefined ||
      sending ||
      preview === undefined ||
      preview.refusal !== undefined ||
      full;
    ui.rSend.title = full
      ? `${MAX_UNSETTLED_REPLAYS} replays have not settled yet. Wait for one to finish.`
      : key === undefined
        ? "Waiting for a fresh replay key."
        : "";
  };

  const bodyEdit = async (purpose: "preview" | "send"): Promise<BodyEdit | undefined> => {
    if (!ui.rBodyOn.checked) return undefined;
    const text = ui.rBody.value;
    const bytes = new TextEncoder().encode(text);
    const limit = purpose === "preview" ? CHUNK_BYTES : INLINE_BODY_BYTES;
    if (bytes.length <= limit) return { kind: "inline", base64: toBase64(bytes) };
    if (draft?.text === text) return { kind: "draft", draftId: draft.draftId };
    if (client === undefined) throw new Error("Not connected.");
    let draftId: string | undefined;
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      const result = await client.call("body_draft_write", {
        ...(draftId === undefined ? {} : { draftId }),
        offset,
        base64: toBase64(bytes.subarray(offset, offset + CHUNK_BYTES)),
      });
      if (!isRecord(result) || typeof result.draftId !== "string")
        throw new Error("The draft was not saved.");
      draftId = result.draftId;
    }
    if (draftId === undefined) return { kind: "inline", base64: "" };
    draft = { text, draftId };
    return { kind: "draft", draftId };
  };

  const edits = async (purpose: "preview" | "send"): Promise<Edits | undefined> => {
    if (source === undefined) return undefined;
    const result: Edits = {};
    const method = ui.rMethod.value.trim().toUpperCase();
    if (method !== "" && method !== source.method) result.method = method;
    if (source.pathTruncated !== true && ui.rUrl.value.trim() !== originalUrl)
      result.url = ui.rUrl.value.trim();
    if (source.request.headersTruncated !== true && ui.rHeaders.value !== originalHeaders)
      result.headers = parseHeaderLines(ui.rHeaders.value);
    const body = await bodyEdit(purpose);
    if (body !== undefined) result.body = body;
    return Object.keys(result).length === 0 ? undefined : result;
  };

  const runPreview = async () => {
    if (client === undefined || source === undefined) return;
    const run = ++previewRun;
    const requestId = source.id;
    preview = undefined;
    previewError = undefined;
    render();
    try {
      const input = await edits("preview");
      const result = (await client.call("preview_replay", {
        requestId,
        ...(input === undefined ? {} : { edits: input }),
      })) as Preview;
      if (run !== previewRun) return;
      preview = result;
      key = result.idempotencyKey;
    } catch (error) {
      if (run !== previewRun) return;
      previewError = explainCallFailure(error);
    }
    render();
  };

  const refreshPreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void runPreview(), 350);
  };

  /** The shown destination and its key no longer match the fields until the next preview. */
  const invalidatePreview = () => {
    previewRun += 1;
    key = undefined;
    preview = undefined;
    previewError = undefined;
  };

  const load = (value: Detail) => {
    source = value;
    originalUrl = `${value.scheme}://${requestOrigin(value)}${value.path}`;
    originalHeaders = headersText(value.request.headers);
    ui.rMethod.value = value.method;
    ui.rUrl.value = originalUrl;
    ui.rUrl.readOnly = value.pathTruncated === true;
    ui.rHeaders.value = originalHeaders;
    ui.rHeaders.readOnly = value.request.headersTruncated;
    ui.rBodyOn.checked = false;
    ui.rBody.hidden = true;
    ui.rBody.value = "";
    draft = undefined;
    key = undefined;
    preview = undefined;
    previewError = undefined;
    if (tab === "replay") void runPreview();
    render();
  };

  const loadBodyText = async () => {
    if (client === undefined || source?.request.body === undefined) return;
    const body = source.request.body;
    if (!body.isText || body.contentEncoding !== undefined || body.capturedBytes > CHUNK_BYTES)
      return;
    try {
      const result = (await client.call("read_body", {
        requestId: source.id,
        side: "request",
        offset: 0,
        length: CHUNK_BYTES,
      })) as ReadBodyResult;
      if (ui.rBody.value === "")
        ui.rBody.value = new TextDecoder().decode(fromBase64(result.base64));
    } catch {
      // Starting from an empty body is fine.
    }
  };

  const send = async () => {
    if (client === undefined || source === undefined || key === undefined || tracker === undefined)
      return;
    const idempotencyKey = key;
    sending = true;
    render();
    let request: ReplayRequest;
    try {
      const input = await edits("send");
      request = {
        requestId: source.id,
        idempotencyKey,
        ...(input === undefined ? {} : { edits: input }),
      };
    } catch (error) {
      sending = false;
      previewError = explainCallFailure(error);
      render();
      return;
    }
    const label = `${request.edits?.method ?? source.method} ${source.host}${source.path}`.slice(
      0,
      160,
    );
    if (
      JSON.stringify({ key: idempotencyKey, input: { request, label } }).length >
      MAX_SAVED_REPLAY_CHARS
    ) {
      sending = false;
      previewError =
        "These edits are too large to keep for a safe retry. Shorten the headers or URL.";
      render();
      return;
    }
    if (!tracker.begin(idempotencyKey, { request, label })) {
      sending = false;
      render();
      return;
    }
    // Two Sends never share a key: drop this one and wait for a fresh preview.
    key = undefined;
    draft = undefined;
    sending = false;
    const kept = await persistNow();
    void runPreview();
    if (!kept) {
      tracker.forget(idempotencyKey);
      setNotice(
        "dismiss:send",
        "error",
        "The replay was not sent: the panel could not save it for a safe retry. Try again.",
      );
      return;
    }
    ui.replays.open = true;
    await replays.submit(idempotencyKey);
  };

  const reset = () => {
    previewRun += 1;
    clearTimeout(previewTimer);
    source = undefined;
    key = undefined;
    preview = undefined;
    previewError = undefined;
  };

  ui.rSend.addEventListener("click", () => void send());
  ui.rReset.addEventListener("click", () => {
    if (source !== undefined) load(source);
    void runPreview();
  });
  for (const input of [ui.rMethod, ui.rUrl, ui.rHeaders, ui.rBody]) {
    input.addEventListener("input", () => {
      invalidatePreview();
      render();
      refreshPreview();
    });
  }
  ui.rBodyOn.addEventListener("change", () => {
    invalidatePreview();
    ui.rBody.hidden = !ui.rBodyOn.checked;
    if (ui.rBodyOn.checked) void loadBodyText().then(refreshPreview);
    else refreshPreview();
    render();
  });

  const syncHeaders = (value: Detail) => {
    if (source?.id !== value.id || ui.rHeaders.value !== originalHeaders) return;
    source = value;
    originalHeaders = headersText(value.request.headers);
    ui.rHeaders.value = originalHeaders;
    ui.rHeaders.readOnly = value.request.headersTruncated;
    render();
  };

  return { load, reset, render, syncHeaders, refreshPreview: () => void runPreview() };
})();

type SubmitOutcome = "maybe-sent" | "not-sent" | "unconfirmed";

const classifyRefusal = (error: unknown): SubmitOutcome => {
  if (!(error instanceof T3PluginError) || error.reason !== "operation-failed") {
    return error instanceof T3PluginError &&
      (error.reason === "too-large" ||
        error.reason === "unknown-operation" ||
        error.reason === "capability-denied" ||
        error.reason === "operation-mutates")
      ? "not-sent"
      : "unconfirmed";
  }
  return replayRefusalOutcome(messageOf(error));
};

const replays = (() => {
  const messages = new Map<string, { outcome: SubmitOutcome; text: string }>();
  const finished: Array<{
    key: string;
    label: string;
    replayId?: string;
    outcome?: SubmitOutcome;
    text?: string;
  }> = [];
  const inFlight = new Set<string>();
  const labels = new Map<string, string>();

  const remember = (entry: {
    key: string;
    label: string;
    replayId?: string;
    outcome?: SubmitOutcome;
    text?: string;
  }) => {
    const index = finished.findIndex((item) => item.key === entry.key);
    if (index !== -1) finished.splice(index, 1);
    finished.unshift(entry);
    finished.length = Math.min(finished.length, 10);
  };

  const describe = (status: ReplayStatus | undefined) => {
    if (status === undefined) return { cls: "state-pending", text: "Pending" };
    if (mayHaveBeenSent(status)) {
      return {
        cls: "state-maybe",
        text:
          status.state === "unknown" ? "Unknown, may have been sent" : "Failed, may have been sent",
      };
    }
    switch (status.state) {
      case "pending":
        return {
          cls: "state-pending",
          text: status.dispatched ? "Sent, waiting for response" : "Pending",
        };
      case "completed":
        return { cls: "state-completed", text: "Completed" };
      default:
        return { cls: "state-failed", text: "Not sent" };
    }
  };

  const render = () => {
    if (tracker === undefined) return;
    const items: Array<HTMLElement> = [];
    const tracked = tracker.tracked();
    for (const entry of tracked) {
      labels.set(entry.key, entry.input.label);
      const note = messages.get(entry.key);
      if (entry.replayId === undefined) {
        items.push(
          h(
            "li",
            {},
            h("span", { class: "what", title: entry.input.label }, entry.input.label),
            h("span", { class: "state-maybe" }, "Not confirmed"),
            h(
              "button",
              {
                type: "button",
                ...(inFlight.has(entry.key) ? { disabled: true } : {}),
                onclick: () => void submit(entry.key),
              },
              inFlight.has(entry.key) ? "Sending…" : "Retry",
            ),
            h(
              "span",
              { class: "why" },
              note?.text ??
                "The inspector has not confirmed this replay. Retry reuses the same key, so it cannot send twice.",
            ),
          ),
        );
        continue;
      }
      const state = describe(tracker.status(entry.replayId));
      items.push(
        h(
          "li",
          {},
          h("span", { class: "what", title: entry.input.label }, entry.input.label),
          h("span", { class: state.cls }, state.text),
        ),
      );
    }
    for (const item of finished) {
      if (tracked.some((entry) => entry.key === item.key)) continue;
      const status = item.replayId === undefined ? undefined : tracker.status(item.replayId);
      const state =
        item.outcome === "maybe-sent"
          ? { cls: "state-maybe", text: "Refused, may have been sent" }
          : item.outcome === "not-sent"
            ? { cls: "state-failed", text: "Not sent" }
            : status === undefined
              ? { cls: "faint", text: "No longer kept" }
              : describe(status);
      const detailText = item.text ?? status?.detail;
      items.push(
        h(
          "li",
          {},
          h("span", { class: "what", title: item.label }, item.label),
          h("span", { class: state.cls }, state.text),
          status?.resultRequestId !== undefined &&
            h(
              "button",
              { type: "button", onclick: () => select(status.resultRequestId ?? null) },
              "View response",
            ),
          detailText !== undefined && h("span", { class: "why" }, detailText),
        ),
      );
    }
    const unsettled = tracked.length;
    ui.replays.hidden = items.length === 0;
    ui.replaysSummary.textContent =
      unsettled === 0
        ? "Replays"
        : `Replays · ${unsettled} unsettled${unsettled >= MAX_UNSETTLED_REPLAYS ? " (limit reached)" : ""}`;
    ui.replayList.replaceChildren(...items);
    editor.render();
  };

  const submit = async (key: string) => {
    if (client === undefined || tracker === undefined || inFlight.has(key)) return;
    const entry = tracker.tracked().find((item) => item.key === key);
    if (entry === undefined) return;
    inFlight.add(key);
    messages.delete(key);
    render();
    try {
      const result = await client.call("replay_request", entry.input.request);
      if (!isRecord(result) || typeof result.replayId !== "string")
        throw new Error("The inspector gave no replay id.");
      remember({ key, label: entry.input.label, replayId: result.replayId });
      tracker.accepted(key, result.replayId);
    } catch (error) {
      const outcome = classifyRefusal(error);
      const text = messageOf(error);
      if (outcome === "unconfirmed") {
        messages.set(key, {
          outcome,
          text: `${text} Retry reuses the same key, so it cannot send twice.`,
        });
      } else {
        remember({
          key,
          label: entry.input.label,
          outcome,
          text: outcome === "maybe-sent" ? `${text} The earlier replay may have been sent.` : text,
        });
        tracker.forget(key);
      }
    } finally {
      inFlight.delete(key);
      render();
    }
  };

  const adopt = (entries: ReadonlyArray<TrackedReplay<ReplayEntryInput>>) => {
    for (const entry of entries) {
      if (entry.replayId !== undefined) {
        finished.push({ key: entry.key, label: entry.input.label, replayId: entry.replayId });
      }
    }
  };

  return { render, submit, adopt };
})();

const getReplay = async (replayId: string): Promise<GetReplayResult> => {
  if (client === undefined) throw new Error("Not connected.");
  try {
    const result = parseReplayStatus(await client.call("get_replay", { replayId, waitMs: 0 }));
    if (result === undefined) throw new Error("Malformed get_replay result.");
    return { found: true, replay: result };
  } catch (error) {
    if (error instanceof T3PluginError && messageOf(error) === REPLAY_DETAILS.replayMissing) {
      return { found: false };
    }
    throw error;
  }
};

const snapshotText = (value: Detail) => {
  const lines = [`${requestLine(value)} ${value.httpVersion}`, headersText(value.request.headers)];
  if (value.response !== undefined) {
    lines.push(
      "",
      `${value.response.httpVersion} ${value.response.status}${value.response.reason ? ` ${value.response.reason}` : ""}`,
      headersText(value.response.headers),
    );
  } else if (value.error !== undefined) {
    lines.push("", `Error: ${value.error}`);
  }
  const text = lines
    .join("\n")
    .replaceAll(
      /^(authorization|cookie|set-cookie|proxy-authorization): .*$/gim,
      `$1: ${REDACTED}`,
    );
  return text.length > SNAPSHOT_TEXT_CHARS ? `${text.slice(0, SNAPSHOT_TEXT_CHARS - 1)}…` : text;
};

const attach = async (kind: "reference" | "text") => {
  const value = detail;
  if (client === undefined || value === undefined) return;
  const text = snapshotText(value);
  const button = kind === "reference" ? ui.attachRef : ui.attachText;
  button.disabled = true;
  try {
    await client.attach(
      kind === "reference"
        ? {
            kind: "reference",
            label: `${value.method} ${value.host}${value.path}`.slice(0, 120),
            locator: { captureId: value.captureId, requestId: value.id },
            snapshot: text,
          }
        : { kind: "text", text: `\`\`\`http\n${text}\n\`\`\`` },
    );
  } catch (error) {
    ui.detailError.textContent = explainCallFailure(error);
  } finally {
    renderDetail();
  }
};
ui.attachRef.addEventListener("click", () => void attach("reference"));
ui.attachText.addEventListener("click", () => void attach("text"));

const applyContext = (context: PluginHostContext) => {
  const root = document.documentElement;
  root.dataset.theme = context.theme;
  for (const [name, value] of Object.entries(context.styles.variables))
    root.style.setProperty(name, value);
  renderDetail();
};

const onCaptureStatus = (event: PluginSubscriptionEvent) => {
  if (event.type === "snapshot" || event.type === "batch") {
    for (const item of event.items) {
      if (isRecord(item) && item.kind === "capture") {
        const previous = captureState?.running?.id;
        captureState = item as unknown as CaptureItem;
        if (previous !== captureState.running?.id || event.type === "snapshot") loadCaptures();
      }
    }
    setNotice("status", "warn", null);
    renderCapture();
    if (listLive !== "connecting") scheduleRender();
  } else if (event.type === "closed") {
    setNotice(
      "status",
      "warn",
      event.reason === "plugin-disabled"
        ? "The inspector was disabled. Enable it in Settings → Plugins."
        : `Status updates stopped (${event.reason}). Check the plugin in Settings → Plugins, then reopen the panel.`,
    );
  }
  tracker?.handleEvent(event);
  replays.render();
};

void connectT3().then(async (connected) => {
  client = connected;
  applyContext(connected.context);
  connected.onContextChange(applyContext);
  const stored = await connected.state.get().catch(() => null);
  const saved = readSavedState(stored?.value);
  if (saved.filter !== undefined) filter = saved.filter;
  ui.query.value = filter.query;
  ui.method.value = filter.method;
  ui.host.value = filter.host;
  ui.status.value = filter.status;
  renderCaptureOptions();
  tracker = createReplayTracker<ReplayEntryInput>({
    initial: saved.replays ?? [],
    getReplay,
    onTrackedChange: () => void persistNow(),
    onStatusChange: () => replays.render(),
  });
  replays.adopt(tracker.tracked());
  replays.render();
  connected.subscribe("capture_status", {}, onCaptureStatus);
  resubscribeRequests();
  if (saved.selected !== undefined && saved.selected !== null) select(saved.selected);
});
