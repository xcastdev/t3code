// @effect-diagnostics globalTimers:off globalDate:off - Runs inside a sandboxed plugin frame, outside any Effect runtime.
import type { PluginSubscriptionEvent } from "@t3tools/contracts";

import type { ViewDefinition } from "../app/nav.ts";
import { proxyFailureText } from "../app/proxies.ts";
import {
  type App,
  explainCallFailure,
  type FlowType,
  type RecordingView,
  type Summary,
} from "../app/state.ts";
import { bytesLabel, compareIdsDesc, h, isRecord, statusClass, timeLabel } from "../dom.ts";
import * as detailView from "./detail.ts";
import { openExportDialog } from "./exportDialog.ts";

interface Filter {
  query: string;
  method: string;
  host: string;
  status: string;
  recordingId: string;
  flowType: "" | Exclude<FlowType, "other">;
}

const PAGE_LIMIT = 100;
const MAX_ROWS = 500;
/** Rows past this many, oldest first, can never be shown and are dropped. */
const MAX_HELD_ROWS = 1000;
/** The Replayer keeps 20 tabs; sending more at once would only evict them. */
const MAX_SEND_TO_REPLAYER = 10;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const FLOW_TYPES = [
  ["", "Any type"],
  ["http", "HTTP"],
  ["websocket", "WebSocket"],
  ["tunnel", "Tunnel"],
] as const;

export const styles = `
.bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--border);
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.filters .f-query {
  flex: 1 1 160px;
}
.filters .f-method,
.filters .f-type {
  flex: 0 0 auto;
}
.filters .f-status {
  flex: 0 0 70px;
}
.filters .f-host {
  flex: 1 1 120px;
}
.filters .f-recording {
  flex: 1 1 160px;
}
.requests-main {
  display: flex;
  flex: 1;
  min-height: 0;
}
.pane {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.list-tools {
  padding: 4px 12px;
  border-bottom: 1px solid var(--border);
}
.list {
  flex: 1;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}
.req-row {
  display: flex;
  align-items: flex-start;
  border-bottom: 1px solid var(--border);
}
.req-row > input {
  flex: 0 0 auto;
  height: auto;
  margin: 9px 0 0 12px;
}
.req {
  display: grid;
  flex: 1;
  grid-template-columns: 58px 1fr auto;
  gap: 2px 8px;
  align-items: baseline;
  min-width: 0;
  height: auto;
  padding: 6px 12px 6px 8px;
  border: 0;
  border-radius: 0;
  background: transparent;
  text-align: left;
}
.req-row:has(.req[aria-current="true"]) {
  background: var(--muted);
}
.req .method {
  font: 600 11px/1.4 var(--mono);
  color: var(--text-muted);
}
.req .path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 12px/1.4 var(--mono);
}
.req .status {
  font: 12px/1.4 var(--mono);
  text-align: right;
}
.req .meta {
  grid-column: 2 / 4;
  overflow: hidden;
  color: var(--text-faint);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.req.tunnel .method {
  color: var(--info);
}
.req.tunnel .path {
  color: var(--text-muted);
}
.row-menu {
  position: fixed;
  z-index: 10;
  display: flex;
  flex-direction: column;
  min-width: 160px;
  padding: 4px;
  border: 1px solid var(--input-border);
  border-radius: var(--radius);
  background: var(--surface);
}
.row-menu button {
  border: 0;
  background: transparent;
  text-align: left;
}
.footer {
  padding: 6px 12px;
  border-top: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 12px;
}
/* Narrow: one pane at a time. */
.has-detail .list-pane {
  display: none;
}
@media (min-width: 760px) {
  .has-detail .list-pane {
    display: flex;
    flex: 0 0 42%;
    max-width: 520px;
  }
  .detail-pane {
    border-left: 1px solid var(--border);
  }
}
`;

const readFilter = (value: unknown): Filter => {
  const raw = isRecord(value) ? value : {};
  const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : "");
  const flowType = text("flowType");
  return {
    query: text("query"),
    method: text("method"),
    host: text("host"),
    status: text("status"),
    recordingId: text("recordingId"),
    flowType: FLOW_TYPES.some(([value]) => value === flowType)
      ? (flowType as Filter["flowType"])
      : "",
  };
};

const isSummary = (value: unknown): value is Summary =>
  isRecord(value) &&
  value.kind === "request" &&
  typeof value.id === "string" &&
  typeof value.seq === "number";

const durationLabel = (ms: number) =>
  ms < 1000
    ? `${ms} ms`
    : ms < 60_000
      ? `${(ms / 1000).toFixed(1)} s`
      : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

const tunnelOutcome = (row: Summary) =>
  row.error !== undefined ? "ERR" : row.endedAt === undefined ? "open" : "closed";

const rowParts = (row: Summary) => {
  if (row.flowType === "tunnel") {
    const address = `${row.host ?? ""}${row.port === undefined ? "" : `:${row.port}`}`;
    return {
      method: "CONNECT",
      path: address,
      title: row.error === undefined ? address : `${address}: ${row.error}`,
      status: tunnelOutcome(row),
      statusClass:
        row.error !== undefined ? "s5" : row.endedAt === undefined ? "state-pending" : "faint",
      tags: ["tunnel"],
      meta: [
        row.sni !== undefined && row.sni !== row.host ? `SNI ${row.sni}` : "",
        `↑ ${bytesLabel(row.bytesUp ?? 0)} ↓ ${bytesLabel(row.bytesDown ?? 0)}`,
        row.endedAt !== undefined && row.startedAt !== undefined
          ? durationLabel(row.endedAt - row.startedAt)
          : "",
        row.error ?? "",
        timeLabel(row.startedAt),
      ],
    };
  }
  return {
    method: row.method ?? "",
    path: row.path ?? "",
    title: `${row.host ?? ""}${row.path ?? ""}`,
    status: row.error !== undefined ? "ERR" : row.status === undefined ? "…" : String(row.status),
    statusClass: statusClass(row.status, row.error),
    tags: [
      ...(row.replayOf === undefined ? [] : ["replay"]),
      ...(row.flowType === undefined || row.flowType === "http" ? [] : [row.flowType]),
    ],
    meta: [row.host ?? "", timeLabel(row.startedAt), bytesLabel(row.responseBytes)],
  };
};

const recordingTimeFormat = new Intl.DateTimeFormat([], {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Filters, the request list with multi-select, and the detail pane for the open request. */
export const mount = (root: HTMLElement, app: App): (() => void) => {
  const { client, notices, persistence, proxies } = app;
  const input = (props: Record<string, string>) => h("input", props) as HTMLInputElement;

  const query = input({
    class: "f-query",
    type: "search",
    placeholder: "Search host or path",
    "aria-label": "Search",
  });
  const method = h(
    "select",
    { class: "f-method", "aria-label": "Method" },
    h("option", { value: "" }, "Any method"),
    ...METHODS.map((name) => h("option", {}, name)),
  ) as HTMLSelectElement;
  const flowType = h(
    "select",
    { class: "f-type", "aria-label": "Flow type" },
    ...FLOW_TYPES.map(([value, label]) => h("option", { value }, label)),
  ) as HTMLSelectElement;
  const status = input({
    class: "f-status",
    inputmode: "numeric",
    placeholder: "Status",
    "aria-label": "Status code",
  });
  const host = input({ class: "f-host", placeholder: "Exact host", "aria-label": "Host" });
  const recording = h("select", {
    class: "f-recording",
    "aria-label": "Recording",
  }) as HTMLSelectElement;
  const deleteRecording = h(
    "button",
    { type: "button", hidden: true },
    "Delete recording",
  ) as HTMLButtonElement;
  const selectToggle = h(
    "button",
    {
      type: "button",
      class: "toggle",
      "aria-pressed": "false",
      title: "Pick requests to send or export together",
    },
    "Select",
  ) as HTMLButtonElement;
  const selectAll = input({ type: "checkbox", "aria-label": "Select all shown requests" });
  const checkedCount = h("span", {}, "All shown");
  const selectAllLabel = h("label", { class: "check", hidden: true }, selectAll, checkedCount);
  const sendToReplayer = h(
    "button",
    { type: "button", disabled: true },
    "Send to replayer",
  ) as HTMLButtonElement;
  const exportButton = h(
    "button",
    { type: "button", "data-host-tools": "" },
    "Export…",
  ) as HTMLButtonElement;
  const list = h("ul", { class: "list", "aria-label": "Recorded requests" });
  const listCount = h("span");
  const loadOlder = h(
    "button",
    { type: "button", hidden: true },
    "Load older",
  ) as HTMLButtonElement;
  const detailPane = h("section", { class: "pane detail-pane", hidden: true });
  const menu = h("div", { class: "row-menu", role: "menu", hidden: true });
  root.classList.add("requests");
  root.replaceChildren(
    h(
      "header",
      { class: "bar" },
      h(
        "div",
        { class: "filters" },
        query,
        method,
        flowType,
        status,
        host,
        recording,
        deleteRecording,
      ),
    ),
    h(
      "main",
      { class: "requests-main" },
      h(
        "section",
        { class: "pane list-pane" },
        h(
          "div",
          { class: "list-tools row" },
          selectToggle,
          selectAllLabel,
          h("span", { class: "spacer" }),
          sendToReplayer,
          exportButton,
        ),
        list,
        h("div", { class: "footer row" }, listCount, h("span", { class: "spacer" }), loadOlder),
      ),
      detailPane,
    ),
    menu,
  );

  let filter = readFilter(persistence.restored.filter);
  let scopeProxyId = proxies.selected.get();
  let scopeRecordingId: string | null = null;
  let recordings: ReadonlyArray<RecordingView> = [];
  let recordingsTimer: ReturnType<typeof setTimeout> | undefined;
  let recordingsGeneration = 0;
  let filterTimer: ReturnType<typeof setTimeout> | undefined;
  // Sandboxed frames cannot open confirm(), so the first click arms the button.
  let deleteArmedFor: string | undefined;
  /** Row checkboxes show only in select mode; leaving it clears `app.checked`. */
  let selecting = false;

  const rows = new Map<string, Summary>();
  /** seq of each recent removal, so a stale page cannot bring a pruned row back. */
  const removedRows = new Map<string, number>();
  /** The ids the list shows, newest first, for select-all. */
  let shownIds: ReadonlyArray<string> = [];
  let snapshotRevision: string | null = null;
  let pageCursor: string | null = null;
  let listLive: "connecting" | "live" | "resyncing" | "closed" = "connecting";
  let closeRequests: (() => void) | undefined;
  let requestsGeneration = 0;
  /** Bumped by every snapshot and resubscribe; a page fetched under an older list is dropped. */
  let listGeneration = 0;
  let renderQueued = false;
  let renderFrame: number | undefined;
  /** Set while the view is hidden; the list renders once when it is shown again. */
  let renderStale = false;

  const scopeParams = () => ({
    ...(scopeProxyId === null ? { allProxies: true } : { proxyId: scopeProxyId }),
    ...(filter.recordingId === "" ? {} : { recordingId: filter.recordingId }),
  });

  const recordingLabel = (item: RecordingView) => {
    const when = recordingTimeFormat.format(item.startedAt);
    const proxyName = scopeProxyId === null ? proxies.get(item.proxyId)?.name : undefined;
    return [
      proxyName,
      item.name ?? `#${item.id}`,
      when,
      `${item.requestCount} request${item.requestCount === 1 ? "" : "s"}`,
      item.stoppedAt === undefined ? "live" : undefined,
    ]
      .filter((part) => part !== undefined)
      .join(" · ");
  };

  const renderRecordingOptions = () => {
    const options = [h("option", { value: "" }, "All recordings")];
    for (const item of recordings)
      options.push(h("option", { value: item.id }, recordingLabel(item)));
    if (filter.recordingId !== "" && !recordings.some((item) => item.id === filter.recordingId)) {
      options.push(h("option", { value: filter.recordingId }, `#${filter.recordingId}`));
    }
    recording.replaceChildren(...options);
    recording.value = filter.recordingId;
    const chosen = recordings.find((item) => item.id === filter.recordingId);
    deleteRecording.hidden = chosen === undefined || chosen.stoppedAt === undefined;
  };

  const loadRecordings = () => {
    clearTimeout(recordingsTimer);
    recordingsTimer = setTimeout(async () => {
      recordingsGeneration += 1;
      const generation = recordingsGeneration;
      try {
        const result = await client.call(
          "list_recordings",
          scopeProxyId === null ? { allProxies: true } : { proxyId: scopeProxyId },
        );
        if (generation !== recordingsGeneration) return;
        if (isRecord(result) && Array.isArray(result.items)) {
          recordings = result.items as ReadonlyArray<RecordingView>;
          renderRecordingOptions();
        }
      } catch {
        // The list is a convenience; the recording filter still works by id.
      }
    }, 150);
  };

  deleteRecording.addEventListener("blur", () => {
    deleteArmedFor = undefined;
    deleteRecording.textContent = "Delete recording";
  });
  deleteRecording.addEventListener("click", async () => {
    if (filter.recordingId === "") return;
    const recordingId = filter.recordingId;
    if (deleteArmedFor !== recordingId) {
      deleteArmedFor = recordingId;
      deleteRecording.textContent = "Delete it and its requests?";
      return;
    }
    deleteArmedFor = undefined;
    deleteRecording.textContent = "Delete recording";
    try {
      await client.call("delete_recording", { recordingId });
      filter = { ...filter, recordingId: "" };
      recordings = recordings.filter((item) => item.id !== recordingId);
      renderRecordingOptions();
      resubscribeRequests();
      persistence.soon();
    } catch (error) {
      notices.set("dismiss:delete", "error", proxyFailureText(error));
    }
  });

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

  /** Ids the replayer can take: checked rows, else the open one. Tunnels carry no request. */
  const replayTargets = () => {
    const checked = app.checked.get();
    const ids = checked.size > 0 ? [...checked] : [app.selection.get()].filter((id) => id !== null);
    return ids.filter((id) => rows.get(id)?.flowType !== "tunnel");
  };

  const renderTools = () => {
    const checked = app.checked.get();
    selectToggle.setAttribute("aria-pressed", String(selecting));
    selectAllLabel.hidden = !selecting;
    checkedCount.textContent = checked.size === 0 ? "All shown" : `${checked.size} selected`;
    selectAll.checked = shownIds.length > 0 && shownIds.every((id) => checked.has(id));
    selectAll.indeterminate = checked.size > 0 && !selectAll.checked;
    selectAll.disabled = shownIds.length === 0;
    const targets = replayTargets();
    sendToReplayer.disabled = targets.length === 0;
    sendToReplayer.title =
      targets.length > MAX_SEND_TO_REPLAYER ? `Sends the first ${MAX_SEND_TO_REPLAYER}` : "";
  };

  const emptyText = () => {
    if (listLive === "connecting") return "Loading requests…";
    const hasFilter =
      filter.query !== "" ||
      filter.method !== "" ||
      filter.host !== "" ||
      filter.status !== "" ||
      filter.recordingId !== "" ||
      filter.flowType !== "";
    if (hasFilter) return "No requests match these filters.";
    const proxy = scopeProxyId === null ? undefined : proxies.get(scopeProxyId);
    if (proxy === undefined) return "No recorded requests yet.";
    if (proxy.recording !== null)
      return "Recording. Send requests through the proxy to see them here.";
    if (proxy.state === "running")
      return "The proxy forwards traffic but keeps nothing until you start recording.";
    return "Nothing recorded yet. Start the proxy, start recording, and route a client through it.";
  };

  const renderList = () => {
    const selectedId = app.selection.get();
    const checked = app.checked.get();
    const visible = [...rows.values()].sort((a, b) => compareIdsDesc(a.id, b.id));
    for (const row of visible.splice(MAX_HELD_ROWS)) rows.delete(row.id);
    const shown = visible.slice(0, MAX_ROWS);
    shownIds = shown.map((row) => row.id);
    const fragment = document.createDocumentFragment();
    for (const row of shown) {
      const parts = rowParts(row);
      const meta = parts.meta.filter((part) => part !== "").join(" · ");
      fragment.append(
        h(
          "li",
          { class: "req-row" },
          selecting &&
            h("input", {
              type: "checkbox",
              "data-check": row.id,
              "aria-label": `Select ${parts.method} ${parts.path}`,
              checked: checked.has(row.id),
            }),
          h(
            "button",
            {
              type: "button",
              class: row.flowType === "tunnel" ? "req tunnel" : "req",
              "aria-current": String(row.id === selectedId),
              "data-id": row.id,
            },
            h("span", { class: "method" }, parts.method),
            h("span", { class: "path", title: parts.title }, parts.path),
            h("span", { class: `status ${parts.statusClass}` }, parts.status),
            h(
              "span",
              { class: "meta" },
              ...parts.tags.map((tag) => h("span", { class: "tag" }, tag)),
              meta,
            ),
          ),
        ),
      );
    }
    if (visible.length === 0) fragment.append(h("li", { class: "empty" }, emptyText()));
    list.replaceChildren(fragment);
    listCount.textContent =
      listLive === "resyncing"
        ? "Resyncing…"
        : listLive === "closed"
          ? "Updates stopped"
          : visible.length > MAX_ROWS
            ? `Showing ${shown.length} of ${visible.length}; narrow the filters`
            : `${visible.length} request${visible.length === 1 ? "" : "s"}`;
    loadOlder.hidden = pageCursor === null || listLive !== "live";
    renderTools();
  };

  const scheduleRender = () => {
    if (app.view.get() !== "requests") {
      renderStale = true;
      return;
    }
    if (renderQueued) return;
    renderQueued = true;
    renderFrame = requestAnimationFrame(() => {
      renderQueued = false;
      renderList();
    });
  };

  const filterParams = () => {
    const code = Number.parseInt(filter.status, 10);
    return {
      ...(filter.query.trim() === "" ? {} : { query: filter.query.trim() }),
      ...(filter.method === "" ? {} : { method: filter.method }),
      ...(filter.host.trim() === "" ? {} : { host: filter.host.trim() }),
      ...(Number.isInteger(code) && code >= 100 && code <= 999 ? { status: code } : {}),
      ...(filter.flowType === "" ? {} : { flowType: filter.flowType }),
    };
  };

  const pruneChecked = (ids: Iterable<string>) => {
    const checked = app.checked.get();
    let next: Set<string> | undefined;
    for (const id of ids) {
      if (!checked.has(id)) continue;
      next ??= new Set(checked);
      next.delete(id);
    }
    if (next !== undefined) app.checked.set(next);
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
        notices.set("requests", "warn", null);
        break;
      }
      case "batch": {
        const selectedId = app.selection.get();
        let touchedSelection = false;
        const removed: Array<string> = [];
        for (const item of event.items) {
          if (!isSummary(item) || !mergeSummary(item)) continue;
          if (item.removed === true) removed.push(item.id);
          if (item.id === selectedId) touchedSelection = true;
        }
        pruneChecked(removed);
        if (touchedSelection && selectedId !== null) app.requestUpdated.emit(selectedId);
        break;
      }
      case "resync":
        listGeneration += 1;
        listLive = "resyncing";
        break;
      case "closed":
        listLive = "closed";
        notices.set(
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
    closeRequests?.();
    requestsGeneration += 1;
    const generation = requestsGeneration;
    listGeneration += 1;
    clearRows();
    if (app.checked.get().size > 0) app.checked.set(new Set());
    snapshotRevision = null;
    pageCursor = null;
    listLive = "connecting";
    scheduleRender();
    closeRequests = client.subscribe(
      "requests",
      { ...scopeParams(), filter: filterParams() },
      (event) => onRequestsEvent(generation, event),
    );
  };

  loadOlder.addEventListener("click", async () => {
    if (pageCursor === null) return;
    const generation = listGeneration;
    loadOlder.disabled = true;
    try {
      const page = await client.call("search_requests", {
        ...filterParams(),
        ...scopeParams(),
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
      notices.set("dismiss:page", "error", explainCallFailure(error));
    } finally {
      loadOlder.disabled = false;
    }
  });

  const setSelecting = (on: boolean) => {
    if (selecting === on) return;
    selecting = on;
    if (!on && app.checked.get().size > 0) app.checked.set(new Set());
    renderList();
  };
  selectToggle.addEventListener("click", () => setSelecting(!selecting));

  const toggleChecked = (id: string, on: boolean) => {
    const next = new Set(app.checked.get());
    if (on) next.add(id);
    else next.delete(id);
    app.checked.set(next);
    setSelecting(true);
  };

  list.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target instanceof HTMLInputElement && target.dataset.check !== undefined) {
      toggleChecked(target.dataset.check, target.checked);
      return;
    }
    const id = target.closest<HTMLElement>("[data-id]")?.dataset.id;
    if (id !== undefined) app.selection.set(id);
  });
  selectAll.addEventListener("change", () => {
    app.checked.set(selectAll.checked ? new Set(shownIds) : new Set());
  });

  const send = (ids: ReadonlyArray<string>) => {
    for (const id of ids.slice(0, MAX_SEND_TO_REPLAYER)) app.sendToReplayer.emit(id);
  };
  sendToReplayer.addEventListener("click", () => send(replayTargets()));
  exportButton.addEventListener("click", () => {
    openExportDialog(app, { filter: { ...scopeParams(), ...filterParams() } });
  });

  const closeMenu = () => {
    menu.hidden = true;
    menu.replaceChildren();
  };
  list.addEventListener("contextmenu", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-id]");
    const id = button?.dataset.id;
    if (button == null || id === undefined) return;
    event.preventDefault();
    const tunnel = rows.get(id)?.flowType === "tunnel";
    const item = (label: string, action: () => void, disabled = false) =>
      h(
        "button",
        {
          type: "button",
          role: "menuitem",
          disabled,
          onclick: () => {
            closeMenu();
            action();
          },
        },
        label,
      );
    menu.replaceChildren(
      item("Open", () => app.selection.set(id)),
      item("Send to replayer", () => send([id]), tunnel),
      app.checked.get().has(id)
        ? item("Unselect", () => toggleChecked(id, false))
        : item("Select", () => toggleChecked(id, true)),
    );
    const rect = button.getBoundingClientRect();
    const mouse = event instanceof MouseEvent && event.clientX + event.clientY > 0;
    menu.style.left = `${Math.min(mouse ? event.clientX : rect.left + 24, window.innerWidth - 180)}px`;
    menu.style.top = `${Math.min(mouse ? event.clientY : rect.bottom, window.innerHeight - 110)}px`;
    menu.hidden = false;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });
  menu.addEventListener("focusout", (event) => {
    if (!menu.contains(event.relatedTarget as Node | null)) closeMenu();
  });

  const onFilterInput = () => {
    filter = {
      query: query.value,
      method: method.value,
      host: host.value,
      status: status.value,
      recordingId: recording.value,
      flowType: flowType.value as Filter["flowType"],
    };
    deleteRecording.hidden = !recordings.some(
      (item) => item.id === filter.recordingId && item.stoppedAt !== undefined,
    );
    clearTimeout(filterTimer);
    filterTimer = setTimeout(resubscribeRequests, 250);
    persistence.soon();
  };
  for (const field of [query, host, status]) field.addEventListener("input", onFilterInput);
  for (const field of [method, flowType, recording])
    field.addEventListener("change", onFilterInput);

  let subscribed = false;
  const onProxies = () => {
    if (!proxies.ready()) return;
    const proxyId = proxies.selected.get();
    const proxy = proxyId === null ? undefined : proxies.get(proxyId);
    const recordingId = proxy?.recording?.id ?? null;
    if (!subscribed || proxyId !== scopeProxyId) {
      if (subscribed) {
        // A recording id from another proxy would match nothing.
        filter = { ...filter, recordingId: "" };
        const selectedId = app.selection.get();
        const selected = selectedId === null ? undefined : rows.get(selectedId);
        if (selectedId !== null && proxyId !== null && selected?.proxyId !== proxyId)
          app.selection.set(null);
      }
      subscribed = true;
      scopeProxyId = proxyId;
      scopeRecordingId = recordingId;
      recordings = [];
      renderRecordingOptions();
      loadRecordings();
      resubscribeRequests();
      return;
    }
    if (recordingId !== scopeRecordingId) {
      scopeRecordingId = recordingId;
      loadRecordings();
    }
    if (listLive !== "connecting") scheduleRender();
  };
  const offProxies = proxies.on(onProxies);
  const offSelectedProxy = proxies.selected.subscribe(onProxies);
  const offChecked = app.checked.subscribe((checked) => {
    for (const box of list.querySelectorAll<HTMLInputElement>("input[data-check]"))
      box.checked = checked.has(box.dataset.check ?? "");
    renderTools();
  });
  const offSelection = app.selection.subscribe((id) => {
    root.classList.toggle("has-detail", id !== null);
    detailPane.hidden = id === null;
    persistence.soon();
    for (const row of list.querySelectorAll('[aria-current="true"]'))
      row.setAttribute("aria-current", "false");
    if (id !== null)
      list.querySelector(`[data-id="${CSS.escape(id)}"]`)?.setAttribute("aria-current", "true");
    renderTools();
  });
  const offView = app.view.subscribe((slot) => {
    if (slot !== "requests" || !renderStale) return;
    renderStale = false;
    scheduleRender();
  });
  const offFilterSlice = persistence.register("filter", () => filter);
  const offSelectedSlice = persistence.register("selected", () => app.selection.get());

  query.value = filter.query;
  method.value = filter.method;
  flowType.value = filter.flowType;
  host.value = filter.host;
  status.value = filter.status;
  renderRecordingOptions();
  scheduleRender();
  const disposeDetail = detailView.mount(detailPane, app);
  onProxies();
  const restored = persistence.restored.selected;
  if (typeof restored === "string") app.selection.set(restored);

  return () => {
    closeRequests?.();
    requestsGeneration += 1;
    recordingsGeneration += 1;
    clearTimeout(recordingsTimer);
    clearTimeout(filterTimer);
    if (renderFrame !== undefined) cancelAnimationFrame(renderFrame);
    offProxies();
    offSelectedProxy();
    offChecked();
    offSelection();
    offView();
    offFilterSlice();
    offSelectedSlice();
    disposeDetail();
  };
};

export const view: ViewDefinition = {
  slot: "requests",
  styles: [styles, detailView.styles],
  mount,
};
