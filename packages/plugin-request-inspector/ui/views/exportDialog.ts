// @effect-diagnostics globalDate:off - Runs inside a sandboxed plugin frame, outside any Effect runtime.
import { EXPORT_DETAILS } from "../../backend/refusals.ts";
import type { ExportFormat } from "../../shared/exportFormats.ts";
import { type App, explainCallFailure } from "../app/state.ts";
import { bytesLabel, fromBase64, h, injectStyles, messageOf, uid } from "../dom.ts";

/** The `export_requests` filter: the list's current scope and filters. */
export interface ExportFilter {
  readonly proxyId?: string;
  readonly recordingId?: string;
  readonly allProxies?: boolean;
  readonly query?: string;
  readonly method?: string;
  readonly host?: string;
  readonly status?: number;
  readonly flowType?: string;
}

export interface ExportDialogOptions {
  /** Enables the "Current filter" scope. */
  readonly filter?: ExportFilter;
}

type Scope = "checked" | "filter" | "all";

interface ExportResult {
  readonly count: number;
  readonly bytes: number;
  readonly missing?: ReadonlyArray<string>;
  readonly truncated?: boolean;
  readonly matched?: number;
  readonly inline?: string;
  readonly file?: { readonly exportId: string; readonly bytes: number };
}

interface ReadExportResult {
  readonly base64: string;
  readonly totalBytes: number;
  readonly eof: boolean;
}

const FORMATS: ReadonlyArray<
  readonly [format: ExportFormat, label: string, extension: string, mime: string]
> = [
  ["har", "HAR", "har", "application/json"],
  ["curl", "cURL", "sh", "text/x-shellscript"],
  ["raw", "Raw HTTP", "txt", "text/plain"],
  ["json", "JSON", "json", "application/json"],
  ["fetch", "fetch", "js", "text/javascript"],
  ["python", "Python requests", "py", "text/x-python"],
];

const MAX_EXPORT_IDS = 500;
const READ_EXPORT_BYTES = 131072;

const styles = `
dialog.sheet {
  width: min(440px, calc(100vw - 24px));
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
}
dialog.sheet::backdrop {
  background: rgba(0, 0, 0, 0.45);
}
dialog.sheet form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
}
dialog.sheet h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
dialog.sheet fieldset {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  border: 0;
}
dialog.sheet legend {
  margin-bottom: 4px;
  color: var(--text-muted);
  font-size: 12px;
}
dialog.sheet .status {
  min-height: 1.4em;
  font-size: 12px;
  overflow-wrap: anywhere;
}
`;

let stylesInjected = false;

/** Styles for `dialog.sheet`, the panel's modal dialogs. */
export const injectSheetStyles = () => {
  if (stylesInjected) return;
  injectStyles(styles);
  stylesInjected = true;
};

const fileStamp = () => new Date().toISOString().slice(0, 19).replaceAll(":", "-");

const missingText = (result: ExportResult) => {
  const missing = result.missing ?? [];
  if (missing.length === 0) return "";
  const shown = missing.slice(0, 5).join(", ");
  return ` ${missing.length} not found: ${shown}${missing.length > 5 ? "…" : ""}.`;
};

const truncatedText = (result: ExportResult) =>
  result.truncated === true && result.matched !== undefined
    ? ` Only the newest ${result.count} of ${result.matched} matching requests are included.`
    : "";

const summary = (result: ExportResult) =>
  `${result.count} request${result.count === 1 ? "" : "s"}, ${bytesLabel(result.bytes)}.${missingText(result)}${truncatedText(result)}`;

/** Opens the export dialog over the panel. It removes itself when closed. */
export function openExportDialog(app: App, options: ExportDialogOptions = {}): void {
  injectSheetStyles();
  const { client } = app;
  const checked = [...app.checked.get()];
  const filter = options.filter;

  const formatId = uid("export-format");
  const format = h(
    "select",
    { id: formatId },
    ...FORMATS.map(([id, label]) => h("option", { value: id }, label)),
  ) as HTMLSelectElement;
  const scopeName = uid("export-scope");
  const scopeOption = (scope: Scope, label: string, enabled: boolean) =>
    h(
      "label",
      { class: enabled ? "check" : "check faint" },
      h("input", {
        type: "radio",
        name: scopeName,
        value: scope,
        ...(enabled ? {} : { disabled: true }),
      }),
      label,
    );
  const bodies = h("input", { type: "checkbox", checked: true }) as HTMLInputElement;
  const status = h("div", { class: "status muted", role: "status" });
  const copyButton = h("button", { type: "button" }, "Copy") as HTMLButtonElement;
  const downloadButton = h(
    "button",
    { type: "button", class: "primary" },
    "Download",
  ) as HTMLButtonElement;
  const closeButton = h("button", { type: "button", class: "ghost" }, "Close") as HTMLButtonElement;
  const dialog = h(
    "dialog",
    { class: "sheet", "aria-label": "Export requests" },
    h(
      "form",
      { method: "dialog" },
      h("h2", {}, "Export requests"),
      h("div", { class: "row" }, h("label", { for: formatId, class: "muted" }, "Format"), format),
      h(
        "fieldset",
        {},
        h("legend", {}, "Requests"),
        checked.length > 0 &&
          scopeOption("checked", `Checked in the list (${checked.length})`, true),
        scopeOption("filter", "Matching the current filter", filter !== undefined),
        scopeOption("all", "All recorded, every proxy", true),
      ),
      h(
        "fieldset",
        {},
        h("legend", {}, "Include"),
        h("label", { class: "check" }, bodies, "Bodies"),
      ),
      status,
      h(
        "div",
        { class: "row" },
        h("span", { class: "spacer" }),
        closeButton,
        copyButton,
        downloadButton,
      ),
    ),
  ) as HTMLDialogElement;

  const defaultScope: Scope =
    checked.length > 0 ? "checked" : filter !== undefined ? "filter" : "all";
  const radio = dialog.querySelector<HTMLInputElement>(`input[value="${defaultScope}"]`);
  if (radio !== null) radio.checked = true;

  const scope = () =>
    (dialog.querySelector<HTMLInputElement>(`input[name="${scopeName}"]:checked`)?.value ??
      "all") as Scope;
  const chosenFormat = () =>
    FORMATS.find(([id]) => id === format.value) ?? (FORMATS[0] as (typeof FORMATS)[number]);

  const input = (output: "inline" | "file") => {
    const target = scope();
    return {
      ...(target === "checked"
        ? { requestIds: checked.slice(0, MAX_EXPORT_IDS) }
        : { filter: target === "filter" && filter !== undefined ? filter : { allProxies: true } }),
      format: chosenFormat()[0],
      includeBodies: bodies.checked,
      output,
    };
  };

  const report = (tone: "muted" | "error", text: string) => {
    status.className = `status ${tone === "error" ? "notice error" : "muted"}`;
    status.textContent = text;
  };
  const tooMany =
    checked.length > MAX_EXPORT_IDS
      ? ` Only the first ${MAX_EXPORT_IDS} checked requests are exported.`
      : "";

  // Copy must call copyText inside the click, so the inline export is prepared ahead of it.
  let prepared: { key: string; result?: ExportResult; error?: string } | undefined;
  let prepareRun = 0;
  let downloading = false;
  let closed = false;
  const prepare = () => {
    const request = input("inline");
    const key = JSON.stringify(request);
    if (prepared?.key === key) return;
    const run = ++prepareRun;
    prepared = { key };
    copyButton.disabled = true;
    if (!downloading) report("muted", "Preparing…");
    client.call("export_requests", request).then(
      (value) => {
        if (run !== prepareRun) return;
        const result = value as ExportResult;
        if (typeof result.inline !== "string") {
          prepared = { key, error: "Too large to copy. Download it instead." };
        } else {
          prepared = { key, result };
          copyButton.disabled = false;
        }
        if (!downloading) report("muted", prepared.error ?? `Ready: ${summary(result)}${tooMany}`);
      },
      (error: unknown) => {
        if (run !== prepareRun) return;
        prepared = {
          key,
          error:
            messageOf(error) === EXPORT_DETAILS.inlineTooLarge
              ? "Too large to copy. Download it instead."
              : explainCallFailure(error),
        };
        if (!downloading) report("error", prepared.error ?? "");
      },
    );
  };
  dialog.addEventListener("change", prepare);

  copyButton.addEventListener("click", () => {
    const ready = prepared?.key === JSON.stringify(input("inline")) ? prepared : undefined;
    const result = ready?.result;
    if (result?.inline === undefined) {
      report(ready?.error === undefined ? "muted" : "error", ready?.error ?? "Still preparing…");
      return;
    }
    client.copyText(result.inline).then(
      () => report("muted", `Copied ${summary(result)}${tooMany}`),
      (error: unknown) => report("error", explainCallFailure(error)),
    );
  });

  downloadButton.addEventListener("click", () => {
    const [, , extension, mime] = chosenFormat();
    const request = input("file");
    let result: ExportResult | undefined;
    // Throwing makes saveFile abort the host's save, so closing the dialog stops the download.
    const stopIfClosed = () => {
      if (closed) throw new Error("Download cancelled.");
    };
    async function* chunks() {
      result = (await client.call("export_requests", request)) as ExportResult;
      stopIfClosed();
      const exportId = result.file?.exportId;
      if (exportId === undefined) throw new Error("The inspector did not write an export file.");
      report("muted", `Downloading ${summary(result)}`);
      let offset = 0;
      for (;;) {
        const part = (await client.call("read_export", {
          exportId,
          offset,
          length: READ_EXPORT_BYTES,
        })) as ReadExportResult;
        stopIfClosed();
        const bytes = fromBase64(part.base64);
        offset += bytes.length;
        if (bytes.length > 0) yield bytes;
        if (part.eof || bytes.length === 0) return;
      }
    }
    downloading = true;
    downloadButton.disabled = true;
    report("muted", "Exporting…");
    // saveFile must start inside the click, before any await, while the activation holds.
    client
      .saveFile(`requests-${fileStamp()}.${extension}`, mime, chunks)
      .then((outcome) => {
        if (outcome === "cancelled") report("muted", "Download cancelled.");
        else if (result !== undefined) report("muted", `Saved ${summary(result)}${tooMany}`);
      })
      .catch((error: unknown) => report("error", explainCallFailure(error)))
      .finally(() => {
        downloading = false;
        downloadButton.disabled = false;
      });
  });

  closeButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener(
    "close",
    () => {
      closed = true;
      prepareRun += 1;
      dialog.remove();
    },
    { once: true },
  );
  document.body.append(dialog);
  dialog.showModal();
  prepare();
}
