// @effect-diagnostics globalTimers:off - Runs inside a sandboxed plugin frame, outside any Effect runtime.
import { MISSING_DETAILS } from "../../backend/refusals.ts";
import { requestOrigin } from "../../backend/origin.ts";
import type { ViewDefinition } from "../app/nav.ts";
import type { ReplayerTab, TabEdits } from "../app/replays.ts";
import {
  type App,
  type BodyEdit,
  CHUNK_BYTES,
  type Detail,
  type Edits,
  explainCallFailure,
  type ReadBodyResult,
  type ReplayRequest,
} from "../app/state.ts";
import {
  bytesLabel,
  type Child,
  fill,
  fromBase64,
  h,
  headersText,
  isRecord,
  messageOf,
  parseHeaderLines,
  statusClass,
  toBase64,
  uid,
} from "../dom.ts";
import { MAX_UNSETTLED_REPLAYS } from "../replayTracker.ts";
import { mountHistory, openInRequests, styles as historyStyles } from "./replays.ts";

/** A Send is kept in bridge state until it settles; larger edits are refused before sending. */
const MAX_SAVED_REPLAY_CHARS = 32 * 1024;

interface Preview {
  readonly destination: { scheme: string; host: string; port: number };
  readonly method: string;
  readonly path: string;
  readonly bodyBytes: number;
  readonly refusal?: string;
  readonly idempotencyKey: string;
}

const styles = `
.rp-tabs {
  display: flex;
  gap: 2px;
  padding: 6px 12px 0;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}
.rp-tab {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  max-width: 240px;
  border-bottom: 2px solid transparent;
}
.rp-tab[aria-selected="true"] {
  border-bottom-color: var(--text);
}
.rp-tab button {
  height: 30px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text-muted);
}
.rp-tab button:hover:not(:disabled) {
  background: transparent;
  color: var(--text);
}
.rp-tab[aria-selected="true"] .rp-tab-label {
  color: var(--text);
}
.rp-tab-label {
  min-width: 0;
  overflow: hidden;
  font: 12px/1 var(--mono);
  text-overflow: ellipsis;
}
.rp-tab-close {
  padding: 0 6px;
}
.rp-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
.rp-editor {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 10px 12px;
  overflow-y: auto;
}
.rp-editor h3 {
  margin: 0;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.rp-source {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}
.rp-source-line {
  flex: 1 1 200px;
  min-width: 0;
  overflow: hidden;
  font: 12px/1.5 var(--mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.replay-list .ghost.what {
  height: auto;
  padding: 0;
  color: var(--text);
  text-align: left;
}
.replay-list .ghost.what:hover:not(:disabled) {
  background: transparent;
  text-decoration: underline;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field label {
  color: var(--text-muted);
  font-size: 12px;
}
.destination {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) - 2px);
  font: 12px/1.5 var(--mono);
  overflow-wrap: anywhere;
}
`;

interface TabEditor {
  /** Called when the tab comes on screen: renders and checks the destination if it has to. */
  readonly activate: () => void;
  readonly dispose: () => void;
}

/** One tab's editor: load the source, edit, preview for a key, then Send through ReplayModel. */
const mountTabEditor = (
  root: HTMLElement,
  app: App,
  tab: ReplayerTab,
  isActive: () => boolean,
): TabEditor => {
  const { client } = app;
  const model = app.replays;
  const { requestId } = tab;
  const ids = { method: uid("rp-method"), url: uid("rp-url"), headers: uid("rp-headers") };
  const rSourceLine = h("span", { class: "rp-source-line" }, `Request ${requestId}`);
  const rStatus = h("span", { class: "mono" });
  const rOpenSource = h(
    "button",
    { type: "button", onclick: () => openInRequests(app, requestId) },
    "Open in Requests",
  );
  const rSourceTools = h("span", { class: "row" }, rOpenSource);
  const rMethod = h("input", {
    id: ids.method,
    class: "mono",
    spellcheck: "false",
  }) as HTMLInputElement;
  const rUrl = h("input", { id: ids.url, class: "mono", spellcheck: "false" }) as HTMLInputElement;
  const rHeaders = h("textarea", {
    id: ids.headers,
    rows: "8",
    spellcheck: "false",
  }) as HTMLTextAreaElement;
  const rBodyOn = h("input", { type: "checkbox" }) as HTMLInputElement;
  const rBody = h("textarea", {
    rows: "8",
    spellcheck: "false",
    hidden: true,
  }) as HTMLTextAreaElement;
  const rNotes = h("div", { class: "field" });
  const rDestination = h("div", { class: "destination" }, "Loading the request…");
  const rReset = h("button", { type: "button" }, "Reset to source") as HTMLButtonElement;
  const rSend = h(
    "button",
    { type: "button", class: "primary", disabled: true },
    "Send",
  ) as HTMLButtonElement;
  const rFields = h(
    "div",
    { class: "field", style: "gap: 10px" },
    h(
      "div",
      { class: "row" },
      h(
        "div",
        { class: "field", style: "flex: 0 0 96px" },
        h("label", { for: ids.method }, "Method"),
        rMethod,
      ),
      h(
        "div",
        { class: "field", style: "flex: 1 1 200px" },
        h("label", { for: ids.url }, "URL"),
        rUrl,
      ),
    ),
    h(
      "div",
      { class: "field" },
      h("label", { for: ids.headers }, 'Headers, one "Name: value" per line'),
      rHeaders,
    ),
    h("label", { class: "check" }, rBodyOn, " Replace the body"),
    rBody,
  );
  const historyRoot = h("div");
  root.replaceChildren(
    h("div", { class: "rp-source" }, rSourceLine, rStatus, rSourceTools),
    rFields,
    rNotes,
    rDestination,
    h(
      "div",
      { class: "row" },
      h("span", { class: "faint", style: "flex: 1 1 160px" }, "Each Send is a new replay."),
      rReset,
      rSend,
    ),
    historyRoot,
  );
  const history = mountHistory(historyRoot, app, { requestId, isVisible: isActive });

  let source: Detail | undefined;
  let loadError: string | undefined;
  let loadRun = 0;
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
    if (!isActive()) return;
    rFields.hidden = source === undefined;
    rSourceTools.hidden = loadError !== undefined;
    rReset.disabled = source === undefined;
    const notes: Array<Child> = [];
    if (source?.request.body?.truncated === true && !rBodyOn.checked) {
      notes.push(
        h(
          "div",
          { class: "faint" },
          "The captured body is incomplete. Replace the body to replay this request.",
        ),
      );
    }
    if (rBodyOn.checked) {
      notes.push(
        h("div", { class: "faint" }, "A replaced body is not kept when the panel reloads."),
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
    fill(rNotes, ...notes);

    if (loadError !== undefined) {
      rDestination.replaceChildren(h("span", { class: "state-failed" }, loadError));
    } else if (source === undefined) {
      rDestination.textContent = "Loading the request…";
    } else if (previewError !== undefined) {
      rDestination.replaceChildren(h("span", { class: "state-failed" }, previewError));
    } else if (preview === undefined) {
      rDestination.textContent = "Checking destination…";
    } else {
      const { destination } = preview;
      fill(
        rDestination,
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
    const full = model.tracker.isFull();
    rSend.disabled =
      source === undefined ||
      key === undefined ||
      sending ||
      preview === undefined ||
      preview.refusal !== undefined ||
      full;
    rSend.title = full
      ? `${MAX_UNSETTLED_REPLAYS} replays have not settled yet. Wait for one to finish.`
      : source !== undefined && key === undefined
        ? "Waiting for a fresh replay key."
        : "";
  };

  const writeDraft = async (bytes: Uint8Array): Promise<string | undefined> => {
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
    return draftId;
  };

  /**
   * A Send always takes a fresh draft: dispatch consumes it, and the inspector keeps only a few,
   * so one cached for an earlier Send or another tab may be gone. Previews reuse theirs.
   */
  const bodyEdit = async (purpose: "preview" | "send"): Promise<BodyEdit | undefined> => {
    if (!rBodyOn.checked) return undefined;
    const text = rBody.value;
    const bytes = new TextEncoder().encode(text);
    if (bytes.length === 0) return { kind: "inline", base64: "" };
    if (purpose === "preview" && bytes.length <= CHUNK_BYTES)
      return { kind: "inline", base64: toBase64(bytes) };
    if (purpose === "preview" && draft?.text === text)
      return { kind: "draft", draftId: draft.draftId };
    const draftId = await writeDraft(bytes);
    if (draftId === undefined) return { kind: "inline", base64: "" };
    draft = purpose === "preview" ? { text, draftId } : undefined;
    return { kind: "draft", draftId };
  };

  const edits = async (purpose: "preview" | "send"): Promise<Edits | undefined> => {
    if (source === undefined) return undefined;
    const result: Edits = {};
    const method = rMethod.value.trim().toUpperCase();
    if (method !== "" && method !== source.method) result.method = method;
    if (source.pathTruncated !== true && rUrl.value.trim() !== originalUrl)
      result.url = rUrl.value.trim();
    if (source.request.headersTruncated !== true && rHeaders.value !== originalHeaders)
      result.headers = parseHeaderLines(rHeaders.value);
    const body = await bodyEdit(purpose);
    if (body !== undefined) result.body = body;
    return Object.keys(result).length === 0 ? undefined : result;
  };

  const runPreview = async () => {
    if (source === undefined) return;
    clearTimeout(previewTimer);
    const run = ++previewRun;
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

  const schedulePreview = () => {
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

  const savedEdits = (): TabEdits => {
    if (source === undefined) return tab.edits;
    const method = rMethod.value.trim().toUpperCase();
    return {
      ...(method !== "" && method !== source.method ? { method: rMethod.value } : {}),
      ...(rUrl.value !== originalUrl ? { url: rUrl.value } : {}),
      ...(rHeaders.value !== originalHeaders ? { headers: rHeaders.value } : {}),
    };
  };

  const fillFields = (value: Detail, kept: TabEdits) => {
    originalUrl = `${value.scheme}://${requestOrigin(value)}${value.path}`;
    originalHeaders = headersText(value.request.headers);
    rMethod.value = kept.method ?? value.method;
    rUrl.value = value.pathTruncated === true ? originalUrl : (kept.url ?? originalUrl);
    rUrl.readOnly = value.pathTruncated === true;
    rHeaders.value = value.request.headersTruncated
      ? originalHeaders
      : (kept.headers ?? originalHeaders);
    rHeaders.readOnly = value.request.headersTruncated;
  };

  const showSource = (value: Detail) => {
    source = value;
    const line = `${value.method} ${value.scheme}://${requestOrigin(value)}${value.path}`;
    rSourceLine.textContent = line;
    rSourceLine.title = line;
    const status = value.response?.status;
    rStatus.className = `mono ${statusClass(status, value.error)}`;
    rStatus.textContent =
      value.error !== undefined ? "error" : status === undefined ? "" : `${status}`;
    const label = `${value.method} ${value.host}${value.path}`.slice(0, 160);
    if (tab.label !== label) model.tabs.update(requestId, { label });
  };

  const load = async () => {
    const run = ++loadRun;
    try {
      const result = (await client.call("get_request", { requestId, bodies: "none" })) as Detail;
      if (run !== loadRun) return;
      loadError = undefined;
      fillFields(result, tab.edits);
      showSource(result);
      invalidatePreview();
      if (isActive()) void runPreview();
    } catch (error) {
      if (run !== loadRun) return;
      loadError =
        messageOf(error) === MISSING_DETAILS.request
          ? "The source request is no longer kept, so it cannot be replayed. Close this tab."
          : explainCallFailure(error);
    }
    render();
  };

  const loadBodyText = async () => {
    if (source?.request.body === undefined) return;
    const body = source.request.body;
    if (!body.isText || body.contentEncoding !== undefined || body.capturedBytes > CHUNK_BYTES)
      return;
    try {
      const result = (await client.call("read_body", {
        requestId,
        side: "request",
        offset: 0,
        length: CHUNK_BYTES,
      })) as ReadBodyResult;
      if (rBody.value === "") rBody.value = new TextDecoder().decode(fromBase64(result.base64));
    } catch {
      // Starting from an empty body is fine.
    }
  };

  const send = async () => {
    if (source === undefined || key === undefined) return;
    const idempotencyKey = key;
    sending = true;
    render();
    let request: ReplayRequest;
    try {
      const input = await edits("send");
      request = { requestId, idempotencyKey, ...(input === undefined ? {} : { edits: input }) };
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
    // Two Sends never share a key: drop this one and wait for a fresh preview.
    key = undefined;
    sending = false;
    const sent = model.send(idempotencyKey, { request, label });
    void runPreview();
    if ((await sent) === "not-kept") {
      app.notices.set(
        "dismiss:send",
        "error",
        "The replay was not sent: the panel could not save it for a safe retry. Try again.",
      );
    }
  };

  const reset = () => {
    if (source === undefined) return;
    fillFields(source, {});
    rBodyOn.checked = false;
    rBody.hidden = true;
    rBody.value = "";
    draft = undefined;
    model.tabs.update(requestId, { edits: {} });
    void runPreview();
  };

  rSend.addEventListener("click", () => void send());
  rReset.addEventListener("click", reset);
  for (const input of [rMethod, rUrl, rHeaders]) {
    input.addEventListener("input", () => {
      model.tabs.update(requestId, { edits: savedEdits() });
      invalidatePreview();
      render();
      schedulePreview();
    });
  }
  rBody.addEventListener("input", () => {
    invalidatePreview();
    render();
    schedulePreview();
  });
  rBodyOn.addEventListener("change", () => {
    invalidatePreview();
    rBody.hidden = !rBodyOn.checked;
    if (rBodyOn.checked) void loadBodyText().then(schedulePreview);
    else schedulePreview();
    render();
  });

  const offChanged = model.changed.on(render);
  void load();
  return {
    activate: () => {
      history.render();
      if (source !== undefined && key === undefined && preview === undefined) void runPreview();
      else render();
    },
    dispose: () => {
      offChanged();
      history.dispose();
      loadRun += 1;
      previewRun += 1;
      clearTimeout(previewTimer);
    },
  };
};

const mount = (root: HTMLElement, app: App): (() => void) => {
  const tabs = app.replays.tabs;
  const strip = h("div", { class: "rp-tabs", role: "tablist", "aria-label": "Replayer tabs" });
  const empty = h(
    "div",
    { class: "empty" },
    "No requests here yet. Use “Send to Replayer” on a request to edit and replay it.",
  );
  const body = h("div", { class: "rp-body" });
  const historyRoot = h("div");
  root.replaceChildren(strip, empty, body, historyRoot);
  const editors = new Map<string, { root: HTMLElement; editor: TabEditor }>();
  const visible = () => app.view.get() === "replayer";
  const history = mountHistory(historyRoot, app, { isVisible: visible });

  const renderStrip = () => {
    const active = tabs.active();
    strip.replaceChildren(
      ...tabs.list().map((tab) =>
        h(
          "div",
          { class: "rp-tab", "aria-selected": String(tab.requestId === active) },
          h(
            "button",
            {
              type: "button",
              role: "tab",
              class: "rp-tab-label",
              title: tab.label,
              "aria-selected": String(tab.requestId === active),
              onclick: () => tabs.focus(tab.requestId),
            },
            tab.label,
          ),
          h(
            "button",
            {
              type: "button",
              class: "rp-tab-close",
              title: "Close tab",
              "aria-label": `Close ${tab.label}`,
              onclick: () => tabs.close(tab.requestId),
            },
            "×",
          ),
        ),
      ),
    );
  };

  const sync = () => {
    renderStrip();
    const list = tabs.list();
    const active = tabs.active();
    strip.hidden = list.length === 0;
    empty.hidden = list.length > 0;
    for (const [requestId, entry] of editors) {
      if (list.some((tab) => tab.requestId === requestId)) continue;
      entry.editor.dispose();
      entry.root.remove();
      editors.delete(requestId);
    }
    const tab = list.find((candidate) => candidate.requestId === active);
    if (tab !== undefined && !editors.has(tab.requestId)) {
      const editorRoot = h("div", { class: "rp-editor", role: "tabpanel" });
      body.append(editorRoot);
      const editor = mountTabEditor(
        editorRoot,
        app,
        tab,
        () => visible() && tabs.active() === tab.requestId,
      );
      editors.set(tab.requestId, { root: editorRoot, editor });
    }
    for (const [requestId, entry] of editors) entry.root.hidden = requestId !== active;
  };

  let shownActive: string | null = null;
  const activate = () => {
    sync();
    const active = tabs.active();
    if (!visible() || active === null) return;
    if (active !== shownActive) editors.get(active)?.editor.activate();
    shownActive = active;
    history.render();
  };

  const offTabs = tabs.changed.on(activate);
  const offView = app.view.subscribe((slot) => {
    if (slot !== "replayer") {
      shownActive = null;
      return;
    }
    activate();
  });
  activate();
  return () => {
    offTabs();
    offView();
    history.dispose();
    for (const { editor } of editors.values()) editor.dispose();
    editors.clear();
  };
};

export const view: ViewDefinition = {
  slot: "replayer",
  styles: [historyStyles, styles],
  mount,
};
