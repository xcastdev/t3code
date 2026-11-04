// @effect-diagnostics globalTimers:off globalDate:off - Runs inside a sandboxed plugin frame, outside any Effect runtime.
import { requestOrigin } from "../../backend/origin.ts";
import { MISSING_DETAILS } from "../../backend/refusals.ts";
import {
  formatHeaders,
  type HeaderFormat,
  parseCookieHeader,
  parseSetCookie,
} from "../../shared/headerFormats.ts";
import {
  type BodyInput,
  headerValue,
  isPseudoHeader,
  rawRequest,
  rawResponse,
} from "../../shared/httpText.ts";
import {
  type App,
  type BodyInfo,
  CHUNK_BYTES,
  type Detail,
  explainCallFailure,
  type Headers,
  type ReadBodyResult,
} from "../app/state.ts";
import { highlightInto, highlightStyles } from "../body/highlight.ts";
import { type BodyKind, prettify, sniffKind } from "../body/pretty.ts";
import {
  bytesLabel,
  type Child,
  fill,
  fromBase64,
  h,
  headersText,
  hexDump,
  messageOf,
  statusClass,
} from "../dom.ts";

type Tab = "headers" | "request" | "response" | "raw";
type Side = "request" | "response";

const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ["headers", "Headers"],
  ["request", "Request"],
  ["response", "Response"],
  ["raw", "Raw"],
];

const HEADER_FORMATS: ReadonlyArray<readonly [HeaderFormat, string]> = [
  ["raw", "Raw lines"],
  ["json", "JSON"],
  ["curl", "cURL -H flags"],
  ["cookie-header", "Cookie header"],
  ["netscape", "Netscape cookie jar"],
  ["js", "JavaScript Headers"],
  ["python", "Python dict"],
];

const MAX_BODY_VIEW_BYTES = 4 * 1024 * 1024;
const HEX_VIEW_BYTES = 64 * 1024;
const SNAPSHOT_TEXT_CHARS = 3000;
// The host refuses clipboard payloads over 240 KiB, and JSON escaping adds to the text.
const COPY_MAX_BYTES = 200 * 1024;

export const styles = `
${highlightStyles}
.detail-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.detail-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font: 12px/1.4 var(--mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tabs {
  display: flex;
  gap: 2px;
  padding: 6px 12px 0;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}
.tabs button {
  height: 30px;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: transparent;
  color: var(--text-muted);
}
.tabs button[aria-selected="true"] {
  border-bottom-color: var(--text);
  color: var(--text);
}
.tab {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 10px 12px;
  overflow-y: auto;
}
.tab h3 {
  margin: 0;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.line {
  font: 12px/1.5 var(--mono);
  overflow-wrap: anywhere;
}
table.headers {
  width: 100%;
  border-collapse: collapse;
  font: 12px/1.5 var(--mono);
}
table.headers td {
  padding: 1px 0;
  vertical-align: top;
  overflow-wrap: anywhere;
}
table.headers td.pick {
  width: 1%;
  padding-right: 6px;
}
table.headers td.pick input {
  height: auto;
  margin: 3px 0 0;
}
table.headers td.name {
  width: 1%;
  padding-right: 10px;
  color: var(--text-muted);
  white-space: nowrap;
}
table.headers tr.cookie td.name {
  padding-left: 14px;
  color: var(--text-faint);
}
table.headers td.act {
  width: 1%;
  padding-left: 6px;
}
button.mini {
  height: 20px;
  padding: 0 6px;
  font-size: 11px;
}
pre.body {
  flex: 1;
  min-height: 120px;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) - 2px);
  background: var(--surface);
  font: 12px/1.5 var(--mono);
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
pre.raw {
  flex: none;
  min-height: 0;
}
.seg {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}
.seg button {
  height: 22px;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
}
.seg button[aria-pressed="true"] {
  background: var(--muted);
  color: var(--text);
}
details.menu {
  position: relative;
}
details.menu summary {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--input-border);
  border-radius: calc(var(--radius) - 2px);
  background: var(--surface);
  font-size: 12px;
  cursor: pointer;
  list-style: none;
}
details.menu summary::-webkit-details-marker {
  display: none;
}
.menu-list {
  position: absolute;
  z-index: 5;
  right: 0;
  display: flex;
  flex-direction: column;
  min-width: 180px;
  margin-top: 4px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
}
.menu-list button {
  border: 0;
  background: transparent;
  text-align: left;
}
.actions {
  padding: 8px 12px;
  border-top: 1px solid var(--border);
}
@media (min-width: 760px) {
  .detail-head .back {
    display: none;
  }
}
`;

export const requestLine = (value: Detail) =>
  `${value.method} ${value.scheme}://${requestOrigin(value)}${value.path}${value.pathTruncated ? "…" : ""}`;

/** The 0.2 detail carries `recordingId`; older shells mapped it to `captureId`. */
const recordingIdOf = (value: Detail) => {
  const record = value as unknown as Record<string, unknown>;
  return String(record.recordingId ?? record.captureId ?? "");
};

const statusLine = (response: NonNullable<Detail["response"]>) =>
  `${response.httpVersion} ${response.status}${response.reason ? ` ${response.reason}` : ""}`;

const snapshotText = (value: Detail) => {
  const lines = [`${requestLine(value)} ${value.httpVersion}`, headersText(value.request.headers)];
  if (value.response !== undefined) {
    lines.push("", statusLine(value.response), headersText(value.response.headers));
  } else if (value.error !== undefined) {
    lines.push("", `Error: ${value.error}`);
  }
  const text = lines.join("\n");
  return text.length > SNAPSHOT_TEXT_CHARS ? `${text.slice(0, SNAPSHOT_TEXT_CHARS - 1)}…` : text;
};

const cookieHeaderName = (side: Side) => (side === "request" ? "cookie" : "set-cookie");

const cookiesIn = (side: Side, value: string) =>
  side === "request"
    ? parseCookieHeader(value)
    : [parseSetCookie(value)].filter((cookie) => cookie !== undefined);

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/** Header and cookie names the user unticked in a side's select mode. Everything starts ticked. */
interface Unticked {
  readonly headers: Set<string>;
  readonly cookies: Set<string>;
}

interface LoadedBody {
  chunks: Array<Uint8Array>;
  loaded: number;
  total: number | undefined;
  eof: boolean;
}

const emptyLoaded = (): LoadedBody => ({ chunks: [], loaded: 0, total: undefined, eof: false });

const joinChunks = (body: LoadedBody) => {
  const bytes = new Uint8Array(body.loaded);
  let offset = 0;
  for (const chunk of body.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

/** The detail pane for `app.selection`: headers, bodies, raw HTTP, and attach. */
export const mount = (root: HTMLElement, app: App): (() => void) => {
  const { client } = app;
  const button = (props: Record<string, string | boolean>, label: string) =>
    h("button", { type: "button", ...props }, label) as HTMLButtonElement;

  const title = h("div", { class: "detail-title" });
  const back = button({ class: "ghost back", "aria-label": "Back to list" }, "←");
  const close = button({ class: "ghost", "aria-label": "Close" }, "✕");
  const toReplayer = button({ disabled: true }, "Send to replayer");
  const tabs = TABS.map(([id, label]) =>
    button({ role: "tab", "data-tab": id, "aria-selected": String(id === "headers") }, label),
  );
  const tabHeaders = h("div", { class: "tab" });
  const bodyDecoded = button({ "aria-pressed": "true" }, "Decoded");
  const bodyEncoded = button({ "aria-pressed": "false" }, "Raw");
  const bodyPretty = button({ "aria-pressed": "true" }, "Pretty");
  const bodyPlain = button({ "aria-pressed": "false" }, "Plain");
  const bodyDecode = button({ class: "mini", title: "Open this body in the Decoder" }, "Decode");
  const bodyMeta = h("span", { class: "muted" });
  const bodyNote = h("span", { class: "faint" });
  const bodyView = h("pre", { class: "body" });
  const bodyProgress = h("span", { class: "faint" });
  const bodyMore = button({ hidden: true }, "Load more");
  const tabBody = h(
    "div",
    { class: "tab", hidden: true },
    h(
      "div",
      { class: "row" },
      h(
        "div",
        { class: "seg", role: "group", "aria-label": "Body encoding" },
        bodyDecoded,
        bodyEncoded,
      ),
      h("div", { class: "seg", role: "group", "aria-label": "Body layout" }, bodyPretty, bodyPlain),
      bodyMeta,
      h("span", { class: "spacer" }),
      bodyDecode,
    ),
    bodyNote,
    bodyView,
    h("div", { class: "row" }, bodyProgress, h("span", { class: "spacer" }), bodyMore),
  );
  const copyRequest = button({ "data-host-tools": "" }, "Copy request");
  const copyResponse = button({ "data-host-tools": "" }, "Copy response");
  const copyBoth = button({ "data-host-tools": "" }, "Copy both");
  const rawStatus = h("span", { class: "faint", role: "status" });
  const rawRequestView = h("pre", { class: "body raw" });
  const rawResponseView = h("pre", { class: "body raw" });
  const rawNote = h("span", { class: "faint" });
  const rawFull = button({ hidden: true }, "Load full bodies");
  const tabRaw = h(
    "div",
    { class: "tab", hidden: true },
    h("div", { class: "row" }, copyRequest, copyResponse, copyBoth, rawStatus),
    h("h3", {}, "Request"),
    rawRequestView,
    h("h3", {}, "Response"),
    rawResponseView,
    h("div", { class: "row" }, rawNote, h("span", { class: "spacer" }), rawFull),
  );
  const detailError = h("span", { class: "faint" });
  const attachText = button({ disabled: true }, "Attach as text");
  const attachRef = button({ class: "primary", disabled: true }, "Attach to chat");
  root.replaceChildren(
    h("div", { class: "detail-head" }, back, title, toReplayer, close),
    h("div", { class: "tabs", role: "tablist" }, ...tabs),
    tabHeaders,
    tabBody,
    tabRaw,
    h(
      "div",
      { class: "actions row" },
      detailError,
      h("span", { class: "spacer" }),
      attachText,
      attachRef,
    ),
  );

  let detail: Detail | undefined;
  let detailMissing = false;
  let tab: Tab = "headers";
  let detailGeneration = 0;
  let detailTimer: ReturnType<typeof setTimeout> | undefined;
  let unticked: Record<Side, Unticked> = {
    request: { headers: new Set(), cookies: new Set() },
    response: { headers: new Set(), cookies: new Set() },
  };
  /** Pick boxes show only in a side's select mode; outside it Copy takes every header. */
  let selecting: Record<Side, boolean> = { request: false, response: false };
  let headerStatus: { side: Side; text: string } | undefined;

  const sideOf = (value: Detail, side: Side) =>
    side === "request" ? value.request : value.response;
  const bodyInfoOf = (side: Side): BodyInfo | undefined =>
    detail === undefined ? undefined : sideOf(detail, side)?.body;
  const contentTypeOf = (side: Side) => {
    const headers = detail === undefined ? undefined : sideOf(detail, side)?.headers;
    return headers === undefined ? undefined : headerValue(headers, "content-type");
  };

  const readChunk = async (side: Side, offset: number, decoded: boolean) => {
    const result = (await client.call("read_body", {
      requestId: detail?.id,
      side,
      offset,
      length: CHUNK_BYTES,
      decoded,
    })) as ReadBodyResult;
    return { chunk: fromBase64(result.base64), total: result.totalBytes, eof: result.eof };
  };

  /** Copies inside the click, while the host still sees the user activation. */
  const copy = async (text: string, done: (message: string) => void) => {
    const bytes = utf8Length(text);
    if (bytes > COPY_MAX_BYTES) {
      done(`Too large to copy (${bytesLabel(bytes)}). Export and download it instead.`);
      return false;
    }
    try {
      await client.copyText(text);
      return true;
    } catch (error) {
      done(explainCallFailure(error));
      return false;
    }
  };

  const bodyViewer = (() => {
    let side: Side = "request";
    let decoded = true;
    let pretty = true;
    let body = emptyLoaded();
    let generation = 0;
    let forRequest: string | undefined;
    let openedBytes: number | undefined;
    /** Bumped on every change to `body`, so render decodes and highlights only new bytes. */
    let revision = 0;
    let decodedFor:
      | { revision: number; text?: string; kind?: BodyKind; bytes: Uint8Array }
      | undefined;
    let shownFor: { revision: number; pretty: boolean } | undefined;

    const render = () => {
      const info = bodyInfoOf(side);
      bodyDecoded.setAttribute("aria-pressed", String(decoded));
      bodyEncoded.setAttribute("aria-pressed", String(!decoded));
      const encoding = info?.contentEncoding;
      bodyDecoded.disabled = encoding === undefined;
      bodyEncoded.disabled = encoding === undefined;
      bodyDecode.disabled = info === undefined;
      if (info === undefined) {
        shownFor = undefined;
        bodyNote.textContent = "";
        bodyMeta.textContent = "";
        bodyPretty.disabled = true;
        bodyPlain.disabled = true;
        bodyView.textContent =
          side === "response" && detail?.response === undefined ? "No response." : "No body.";
        bodyProgress.textContent = "";
        bodyMore.hidden = true;
        return;
      }
      bodyMeta.textContent = [
        `${bytesLabel(info.capturedBytes)} captured`,
        info.declaredBytes !== undefined && info.declaredBytes !== info.capturedBytes
          ? `of ${bytesLabel(info.declaredBytes)}`
          : "",
        encoding ?? "",
        info.truncated ? "cut at capture" : "",
      ]
        .filter((part) => part !== "")
        .join(" · ");
      if (decodedFor?.revision !== revision) {
        const bytes = joinChunks(body);
        const asText = info.isText && (decoded || encoding === undefined);
        const text = asText ? new TextDecoder().decode(bytes) : undefined;
        const kind = text === undefined ? undefined : sniffKind(contentTypeOf(side), text);
        decodedFor = {
          revision,
          bytes,
          ...(text === undefined ? {} : { text }),
          ...(kind === undefined ? {} : { kind }),
        };
      }
      const { bytes, text, kind } = decodedFor;
      bodyPretty.disabled = kind === undefined;
      bodyPlain.disabled = kind === undefined;
      bodyPretty.setAttribute("aria-pressed", String(pretty && kind !== undefined));
      bodyPlain.setAttribute("aria-pressed", String(!pretty || kind === undefined));
      bodyProgress.textContent =
        body.total === undefined
          ? ""
          : `${bytesLabel(body.loaded)} of ${bytesLabel(body.total)} shown`;
      bodyMore.hidden = body.eof || body.loaded >= MAX_BODY_VIEW_BYTES;
      const shownPretty = pretty && kind !== undefined;
      if (shownFor?.revision === revision && shownFor.pretty === shownPretty) return;
      shownFor = { revision, pretty: shownPretty };
      bodyNote.textContent = "";
      if (body.loaded === 0 && body.eof) bodyView.textContent = "Empty body.";
      else if (text !== undefined && kind !== undefined && pretty) {
        const view = prettify(kind, text);
        if (view.language === undefined) bodyView.textContent = view.text;
        else highlightInto(bodyView, view.text, view.language);
        bodyNote.textContent = view.note ?? "";
      } else if (text !== undefined) bodyView.textContent = text;
      else {
        bodyView.textContent =
          hexDump(bytes.subarray(0, HEX_VIEW_BYTES)) +
          (bytes.length > HEX_VIEW_BYTES
            ? `\n… ${bytesLabel(bytes.length - HEX_VIEW_BYTES)} more loaded`
            : "");
      }
    };

    const loadChunk = async () => {
      if (detail === undefined || bodyInfoOf(side) === undefined) return render();
      const run = generation;
      bodyMore.disabled = true;
      try {
        const result = await readChunk(side, body.loaded, decoded);
        if (run !== generation) return;
        body.chunks.push(result.chunk);
        body.loaded += result.chunk.length;
        body.total = result.total;
        body.eof = result.eof || result.chunk.length === 0;
        revision += 1;
      } catch (error) {
        if (run !== generation) return;
        bodyView.textContent = explainCallFailure(error);
        body.eof = true;
        revision += 1;
      } finally {
        bodyMore.disabled = false;
      }
      render();
    };

    const open = async (next: Side, keep: boolean) => {
      // A kept reload shows the held bytes unless the capture grew since they were read.
      const captured = detail === undefined ? undefined : sideOf(detail, next)?.body?.capturedBytes;
      if (
        keep &&
        next === side &&
        forRequest === detail?.id &&
        body.loaded > 0 &&
        captured === openedBytes
      )
        return render();
      side = next;
      forRequest = detail?.id;
      openedBytes = captured;
      generation += 1;
      revision += 1;
      body = emptyLoaded();
      decoded = bodyInfoOf(side)?.contentEncoding !== undefined ? decoded : true;
      shownFor = undefined;
      bodyView.textContent = "Loading…";
      await loadChunk();
    };

    bodyMore.addEventListener("click", () => void loadChunk());
    bodyDecoded.addEventListener("click", () => {
      if (decoded) return;
      decoded = true;
      void open(side, false);
    });
    bodyEncoded.addEventListener("click", () => {
      if (!decoded) return;
      decoded = false;
      void open(side, false);
    });
    bodyPretty.addEventListener("click", () => {
      pretty = true;
      render();
    });
    bodyPlain.addEventListener("click", () => {
      pretty = false;
      render();
    });
    bodyDecode.addEventListener("click", () => {
      if (detail === undefined) return;
      app.sendToDecoder.emit({ kind: "body", requestId: detail.id, side });
    });
    return { open };
  })();

  const rawViewer = (() => {
    let bodies: Record<Side, LoadedBody> = { request: emptyLoaded(), response: emptyLoaded() };
    let forRequest: string | undefined;
    let generation = 0;
    let loading = false;

    const bodyInput = (value: Detail, side: Side): BodyInput | undefined => {
      const info = sideOf(value, side)?.body;
      if (info === undefined) return undefined;
      const loaded = bodies[side];
      return {
        bytes: joinChunks(loaded),
        truncated: info.truncated && loaded.eof,
        declaredBytes: info.declaredBytes,
        contentType: contentTypeOf(side),
      };
    };

    const cutNote = (side: Side) => {
      const loaded = bodies[side];
      return loaded.eof || loaded.total === undefined
        ? ""
        : `\n[truncated: showing ${bytesLabel(loaded.loaded)} of ${bytesLabel(loaded.total)}]`;
    };

    const texts = () => {
      const value = detail;
      if (value === undefined) return undefined;
      const request =
        rawRequest({
          ...value,
          headers: value.request.headers,
          body: bodyInput(value, "request"),
        }) + cutNote("request");
      const response =
        value.response === undefined
          ? undefined
          : rawResponse({ ...value.response, body: bodyInput(value, "response") }) +
            cutNote("response");
      return { request, response };
    };

    const render = () => {
      const value = detail;
      const text = texts();
      rawRequestView.textContent = text?.request ?? "";
      rawResponseView.textContent =
        text?.response ?? (value?.error === undefined ? "No response." : `Error: ${value.error}`);
      copyResponse.disabled = text?.response === undefined;
      copyBoth.disabled = text?.response === undefined;
      const cut = (["request", "response"] as const).some(
        (side) => bodyInfoOf(side) !== undefined && !bodies[side].eof,
      );
      const decodedNote =
        bodyInfoOf("request")?.contentEncoding !== undefined ||
        bodyInfoOf("response")?.contentEncoding !== undefined
          ? "Bodies are shown with their content-encoding removed."
          : "";
      const headersCut =
        value?.request.headersTruncated === true || value?.response?.headersTruncated === true
          ? "Long header values are cut here."
          : "";
      rawNote.textContent = [decodedNote, headersCut].filter((part) => part !== "").join(" ");
      rawFull.hidden = !cut || loading;
    };

    const load = async (full: boolean) => {
      const value = detail;
      if (value === undefined) return;
      const run = ++generation;
      loading = true;
      render();
      try {
        for (const side of ["request", "response"] as const) {
          if (sideOf(value, side)?.body === undefined) continue;
          const loaded = bodies[side];
          while (!loaded.eof && loaded.loaded < MAX_BODY_VIEW_BYTES) {
            const result = await readChunk(side, loaded.loaded, true);
            if (run !== generation) return;
            loaded.chunks.push(result.chunk);
            loaded.loaded += result.chunk.length;
            loaded.total = result.total;
            loaded.eof = result.eof || result.chunk.length === 0;
            if (!full) break;
          }
        }
      } catch (error) {
        if (run !== generation) return;
        rawStatus.textContent = explainCallFailure(error);
      }
      loading = false;
      render();
    };

    const open = (keep: boolean) => {
      if (keep && forRequest === detail?.id) return render();
      forRequest = detail?.id;
      bodies = { request: emptyLoaded(), response: emptyLoaded() };
      rawStatus.textContent = "";
      void load(false);
    };

    const copyPart = (part: "request" | "response" | "both") => {
      const text = texts();
      if (text === undefined) return;
      const value =
        part === "request"
          ? text.request
          : part === "response"
            ? text.response
            : [text.request, text.response].filter((item) => item !== undefined).join("\n\n");
      if (value === undefined) return;
      const report = (message: string) => {
        rawStatus.textContent = message;
      };
      const note = /\n\[truncated: showing/.test(value)
        ? " Bodies are cut; load them in full first."
        : "";
      void copy(value, report).then((copied) => {
        if (copied) report(`Copied.${note}`);
      });
    };

    rawFull.addEventListener("click", () => void load(true));
    copyRequest.addEventListener("click", () => copyPart("request"));
    copyResponse.addEventListener("click", () => copyPart("response"));
    copyBoth.addEventListener("click", () => copyPart("both"));
    return { open, reset: () => (generation += 1) };
  })();

  const pickBox = (checked: boolean, label: string, onChange: (checked: boolean) => void) =>
    h("input", {
      type: "checkbox",
      "aria-label": label,
      ...(checked ? { checked: true } : {}),
      onchange: (event: Event) => onChange((event.target as HTMLInputElement).checked),
    });

  const copyHeaders = (value: Detail, side: Side, format: HeaderFormat) => {
    const headers = sideOf(value, side)?.headers ?? [];
    const skip: Unticked = selecting[side]
      ? unticked[side]
      : { headers: new Set(), cookies: new Set() };
    const names = [...new Set(headers.map(([name]) => name.toLowerCase()))].filter(
      (name) => !isPseudoHeader(name),
    );
    const cookieName = cookieHeaderName(side);
    const cookieNames = [
      ...new Set(
        headers
          .filter(([name]) => name.toLowerCase() === cookieName)
          .flatMap(([, headerText]) => cookiesIn(side, headerText).map((cookie) => cookie.name)),
      ),
    ];
    const keptNames = names.filter((name) => !skip.headers.has(name));
    const keptCookies = cookieNames.filter((name) => !skip.cookies.has(name));
    const text = formatHeaders({
      headers,
      side,
      request: { host: value.host, path: value.path },
      capturedAt: value.startedAt,
      ...(skip.headers.size === 0 ? {} : { names: keptNames }),
      ...(skip.cookies.size === 0
        ? {}
        : { cookies: keptCookies.length === 0 ? false : keptCookies }),
      format,
    });
    const report = (text: string) => {
      headerStatus = { side, text };
      renderDetail();
    };
    if (text.trim() === "" || text === "# Netscape HTTP Cookie File") {
      report("Nothing selected to copy.");
      return;
    }
    const label = HEADER_FORMATS.find(([id]) => id === format)?.[1] ?? format;
    void copy(text, report).then((copied) => {
      if (!copied) return;
      report(`Copied as ${label}.`);
    });
  };

  const copyMenu = (value: Detail, side: Side) => {
    const menu = h("details", { class: "menu", "data-host-tools": "" });
    menu.append(
      h("summary", {}, "Copy as…"),
      h(
        "div",
        { class: "menu-list", role: "menu" },
        ...HEADER_FORMATS.map(([format, label]) =>
          h(
            "button",
            {
              type: "button",
              role: "menuitem",
              onclick: () => {
                (menu as HTMLDetailsElement).open = false;
                copyHeaders(value, side, format);
              },
            },
            label,
          ),
        ),
      ),
    );
    return menu;
  };

  const headerRows = (value: Detail, side: Side, headers: Headers): Array<Child> => {
    const skip = unticked[side];
    const picking = selecting[side];
    const cookieName = cookieHeaderName(side);
    const rows: Array<HTMLElement> = [];
    for (const [name, headerText] of headers) {
      const lower = name.toLowerCase();
      const pseudo = isPseudoHeader(name);
      const isCookie = lower === cookieName;
      const cookies = isCookie ? cookiesIn(side, headerText) : [];
      rows.push(
        h(
          "tr",
          {},
          picking &&
            h(
              "td",
              { class: "pick" },
              !pseudo &&
                pickBox(!skip.headers.has(lower), `Include ${name}`, (checked) => {
                  if (checked) skip.headers.delete(lower);
                  else skip.headers.add(lower);
                  for (const cookie of cookies) {
                    if (checked) skip.cookies.delete(cookie.name);
                    else skip.cookies.add(cookie.name);
                  }
                  renderDetail();
                }),
            ),
          h("td", { class: "name" }, name),
          h("td", {}, headerText),
          h(
            "td",
            { class: "act" },
            h(
              "button",
              {
                type: "button",
                class: "ghost mini",
                title: `Open ${name} in the Decoder`,
                onclick: () =>
                  app.sendToDecoder.emit({
                    kind: "header",
                    requestId: value.id,
                    side,
                    header: name,
                  }),
              },
              "Decode",
            ),
          ),
        ),
      );
      for (const cookie of cookies) {
        rows.push(
          h(
            "tr",
            { class: "cookie" },
            picking &&
              h(
                "td",
                { class: "pick" },
                pickBox(
                  !skip.cookies.has(cookie.name),
                  `Include cookie ${cookie.name}`,
                  (checked) => {
                    if (checked) {
                      skip.cookies.delete(cookie.name);
                      skip.headers.delete(lower);
                    } else skip.cookies.add(cookie.name);
                    renderDetail();
                  },
                ),
              ),
            h("td", { class: "name" }, cookie.name === "" ? "(unnamed)" : cookie.name),
            h("td", {}, cookie.value),
            h("td", {}),
          ),
        );
      }
    }
    return [h("table", { class: "headers" }, h("tbody", {}, ...rows))];
  };

  const sideHeading = (value: Detail, side: Side, label: string) =>
    h(
      "div",
      { class: "row" },
      h("h3", {}, label),
      h("span", { class: "spacer" }),
      headerStatus?.side === side &&
        h("span", { class: "faint", role: "status" }, headerStatus.text),
      h(
        "button",
        {
          type: "button",
          class: "ghost mini toggle",
          "aria-pressed": String(selecting[side]),
          title: selecting[side]
            ? "Stop picking; Copy takes every header"
            : "Pick which headers and cookies Copy takes",
          onclick: () => {
            selecting = { ...selecting, [side]: !selecting[side] };
            unticked = { ...unticked, [side]: { headers: new Set(), cookies: new Set() } };
            headerStatus = undefined;
            renderDetail();
          },
        },
        "Select",
      ),
      copyMenu(value, side),
    );

  const renderHeadersTab = (value: Detail) => {
    const response = value.response;
    const anyTruncated = value.request.headersTruncated || response?.headersTruncated === true;
    fill(
      tabHeaders,
      sideHeading(value, "request", "Request"),
      h("div", { class: "line" }, `${requestLine(value)} ${value.httpVersion}`),
      value.replayOf !== undefined &&
        h("div", { class: "muted" }, `Replay result (replay ${value.replayOf.slice(0, 8)})`),
      ...headerRows(value, "request", value.request.headers),
      response === undefined ? h("h3", {}, "Response") : sideHeading(value, "response", "Response"),
      response === undefined
        ? h(
            "div",
            { class: value.error === undefined ? "muted" : "notice error" },
            value.error ?? "No response yet.",
          )
        : h(
            "div",
            { class: `line ${statusClass(response.status, undefined)}` },
            statusLine(response),
          ),
      ...(response === undefined ? [] : headerRows(value, "response", response.headers)),
      anyTruncated &&
        h(
          "div",
          { class: "faint" },
          "Long header values are cut here. Replay uses the full stored headers.",
        ),
    );
  };

  const renderDetail = () => {
    const selectedId = app.selection.get();
    for (const tabButton of tabs)
      tabButton.setAttribute("aria-selected", String(tabButton.dataset.tab === tab));
    tabHeaders.hidden = tab !== "headers";
    tabBody.hidden = tab !== "request" && tab !== "response";
    tabRaw.hidden = tab !== "raw";
    const value = detail?.id === selectedId ? detail : undefined;
    title.textContent =
      value === undefined ? (detailMissing ? "Request deleted" : "Loading…") : requestLine(value);
    title.title = title.textContent;
    toReplayer.disabled = value === undefined || value.flowType === "tunnel";
    if (detailMissing) {
      tabHeaders.replaceChildren(
        h(
          "div",
          { class: "empty" },
          "This request no longer exists. It may have been pruned or its recording deleted.",
        ),
      );
      tabHeaders.hidden = false;
      tabBody.hidden = true;
      tabRaw.hidden = true;
    } else if (value !== undefined) {
      renderHeadersTab(value);
    }
    const target = client.context.chatTarget;
    const canAttach = value !== undefined && target != null;
    attachRef.disabled = !canAttach;
    attachText.disabled = !canAttach;
    attachRef.title =
      target == null ? "Open a chat to attach this request." : `Attach to ${target.title}`;
    attachText.title = attachRef.title;
  };

  const openTab = (keep: boolean) => {
    if (tab === "request" || tab === "response") void bodyViewer.open(tab, keep);
    if (tab === "raw") rawViewer.open(keep);
  };

  const loadDetail = async () => {
    const requestId = app.selection.get();
    if (requestId === null) return;
    const generation = ++detailGeneration;
    renderDetail();
    try {
      const result = await client.call("get_request", { requestId, bodies: "none" });
      if (generation !== detailGeneration) return;
      const previous = detail;
      detail = result as Detail;
      detailMissing = false;
      detailError.textContent = "";
      openTab(previous?.id === detail.id && tab !== "raw");
    } catch (error) {
      if (generation !== detailGeneration) return;
      detailMissing = messageOf(error) === MISSING_DETAILS.request;
      detailError.textContent = detailMissing ? "" : explainCallFailure(error);
    }
    renderDetail();
  };

  const attach = async (kind: "reference" | "text") => {
    const value = detail;
    if (value === undefined) return;
    const text = snapshotText(value);
    const attachButton = kind === "reference" ? attachRef : attachText;
    attachButton.disabled = true;
    try {
      await client.attach(
        kind === "reference"
          ? {
              kind: "reference",
              label: `${value.method} ${value.host}${value.path}`.slice(0, 120),
              locator: { recordingId: recordingIdOf(value), requestId: value.id },
              snapshot: text,
            }
          : { kind: "text", text: `\`\`\`http\n${text}\n\`\`\`` },
      );
    } catch (error) {
      detailError.textContent = explainCallFailure(error);
    } finally {
      renderDetail();
    }
  };

  for (const tabButton of tabs) {
    tabButton.addEventListener("click", () => {
      tab = tabButton.dataset.tab as Tab;
      renderDetail();
      openTab(tab === "raw");
    });
  }
  const closeMenus = (event: Event) => {
    for (const menu of root.querySelectorAll<HTMLDetailsElement>("details.menu[open]")) {
      if (!menu.contains(event.target as Node)) menu.open = false;
    }
  };
  root.addEventListener("pointerdown", closeMenus);
  back.addEventListener("click", () => app.selection.set(null));
  close.addEventListener("click", () => app.selection.set(null));
  toReplayer.addEventListener("click", () => {
    if (detail !== undefined) app.sendToReplayer.emit(detail.id);
  });
  attachRef.addEventListener("click", () => void attach("reference"));
  attachText.addEventListener("click", () => void attach("text"));

  const offSelection = app.selection.subscribe((id) => {
    clearTimeout(detailTimer);
    detailTimer = undefined;
    detail = undefined;
    detailMissing = false;
    headerStatus = undefined;
    selecting = { request: false, response: false };
    unticked = {
      request: { headers: new Set(), cookies: new Set() },
      response: { headers: new Set(), cookies: new Set() },
    };
    rawViewer.reset();
    if (id !== null) void loadDetail();
    else renderDetail();
  });
  // At most one reload per 300 ms while a live request keeps changing.
  const offUpdated = app.requestUpdated.on((id) => {
    if (id !== app.selection.get() || detailTimer !== undefined) return;
    detailTimer = setTimeout(() => {
      detailTimer = undefined;
      void loadDetail();
    }, 300);
  });
  const offContext = client.onContextChange(renderDetail);
  if (app.selection.get() !== null) void loadDetail();

  return () => {
    offSelection();
    offUpdated();
    offContext();
    root.removeEventListener("pointerdown", closeMenus);
    clearTimeout(detailTimer);
    detailGeneration += 1;
    rawViewer.reset();
  };
};
