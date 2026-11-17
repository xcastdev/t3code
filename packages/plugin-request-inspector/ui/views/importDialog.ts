import { type App, CHUNK_BYTES, explainCallFailure } from "../app/state.ts";
import { bytesLabel, h, isRecord, toBase64, uid } from "../dom.ts";
import { injectSheetStyles } from "./exportDialog.ts";

/** `import_flows` and `get_import` results. */
export interface ImportView {
  readonly recordingId: string;
  readonly proxyId: string;
  readonly name: string;
  readonly state: "running" | "completed" | "failed";
  readonly imported: number;
  readonly skipped: number;
  readonly dropped: number;
  readonly detail?: string;
}

export interface ImportDialogOptions {
  /** Called once the inspector created the recording and started reading the file. */
  readonly onStarted: (view: ImportView) => void;
  /** Called when the import ends, even after the dialog closed. */
  readonly onSettled: (view: ImportView) => void;
}

const MAX_NAME_CHARS = 128;
const WAIT_MS = 20_000;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export const importSummary = (view: ImportView) => {
  const parts = [
    view.state === "running"
      ? `Importing ${view.name}…`
      : `${view.state === "completed" ? "Imported" : "Stopped importing"} ${view.name}: ${plural(view.imported, "request")}.`,
    view.skipped > 0 ? `Skipped ${plural(view.skipped, "non-HTTP flow")}.` : "",
    view.dropped > 0
      ? `Dropped ${plural(view.dropped, "request")}: the storage budget or request limit was reached.`
      : "",
    view.detail ?? "",
  ];
  return parts.filter((part) => part !== "").join(" ");
};

const isImportView = (value: unknown): value is ImportView =>
  isRecord(value) && typeof value.recordingId === "string" && typeof value.state === "string";

/** Opens the import dialog: upload a flow file from this device, or name one on the T3 machine. */
export function openImportDialog(app: App, options: ImportDialogOptions): void {
  injectSheetStyles();
  const { client, proxies } = app;

  const proxyId = uid("import-proxy");
  const live = proxies.list().filter((proxy) => proxy.deletedAt === null);
  const preferred = proxies.selected.get() ?? proxies.defaultProxyId();
  const proxy = h(
    "select",
    { id: proxyId },
    ...live.map((item) => h("option", { value: item.id }, item.name)),
  ) as HTMLSelectElement;
  if (preferred !== null && live.some((item) => item.id === preferred)) proxy.value = preferred;

  const file = h("input", { type: "file", hidden: true }) as HTMLInputElement;
  const fromDevice = h(
    "button",
    { type: "button", class: "primary" },
    "Upload from this device…",
  ) as HTMLButtonElement;
  const { destination } = client.context;
  const machine = destination.kind === "environment" ? destination.label : "the T3 machine";
  // The host's file browser is the command palette, which mobile does not have.
  const canPickOnMachine =
    destination.kind === "environment" && client.context.platform !== "mobile";
  const fromMachine = h(
    "button",
    { type: "button", title: `Browse ${machine} in the command palette` },
    `Choose on ${machine}…`,
  ) as HTMLButtonElement;
  const pathId = uid("import-path");
  const path = h("input", {
    id: pathId,
    type: "text",
    placeholder: "~/captures/session.mitm",
    spellcheck: "false",
    autocomplete: "off",
  }) as HTMLInputElement;
  const fromPath = h("button", { type: "button" }, "Import") as HTMLButtonElement;
  const status = h("div", { class: "status muted", role: "status" });
  const closeButton = h("button", { type: "button", class: "ghost" }, "Close") as HTMLButtonElement;
  const dialog = h(
    "dialog",
    { class: "sheet", "aria-label": "Import flows" },
    h(
      "form",
      { method: "dialog" },
      h("h2", {}, "Import flows"),
      h(
        "p",
        { class: "muted" },
        "Adds a mitmproxy .mitm dump or a HAR file as a new recording. Only HTTP and WebSocket flows are kept.",
      ),
      h("div", { class: "row" }, h("label", { for: proxyId, class: "muted" }, "Proxy"), proxy),
      h("div", { class: "row" }, fromDevice, canPickOnMachine && fromMachine, file),
      !canPickOnMachine &&
        h(
          "fieldset",
          {},
          h("legend", {}, h("label", { for: pathId }, `Or a path on ${machine}`)),
          h("div", { class: "row" }, path, fromPath),
        ),
      status,
      h("div", { class: "row" }, h("span", { class: "spacer" }), closeButton),
    ),
  ) as HTMLDialogElement;

  let busy = false;
  let closed = false;
  const render = () => {
    const blocked = busy || live.length === 0;
    fromDevice.disabled = blocked;
    fromMachine.disabled = blocked;
    fromPath.disabled = blocked || path.value.trim() === "";
    path.disabled = busy;
    proxy.disabled = busy;
  };
  const report = (tone: "muted" | "error", text: string) => {
    if (closed) return;
    status.className = `status ${tone === "error" ? "notice error" : "muted"}`;
    status.textContent = text;
  };

  /** Waits for the import to end. It keeps waiting after the dialog closes. */
  const follow = async (started: ImportView) => {
    options.onStarted(started);
    let view = started;
    report("muted", `${importSummary(view)} It keeps going if you close this.`);
    try {
      while (view.state === "running") {
        const next = await client.call("get_import", {
          recordingId: view.recordingId,
          waitMs: WAIT_MS,
        });
        if (!isImportView(next)) throw new Error("The inspector sent an unexpected import status.");
        view = next;
        if (view.state === "running") {
          report("muted", `Importing ${view.name}… ${plural(view.imported, "request")} so far.`);
        }
      }
    } catch (error) {
      view = { ...view, state: "failed", detail: explainCallFailure(error) };
    }
    options.onSettled(view);
    if (closed && view.state === "failed") {
      app.notices.set("dismiss:import", "error", importSummary(view));
    }
    report(view.state === "failed" ? "error" : "muted", importSummary(view));
  };

  /** `start` resolves undefined when the user backed out before anything began. */
  const run = async (start: () => Promise<unknown>) => {
    busy = true;
    render();
    try {
      const started = await start();
      if (started === undefined) return;
      if (!isImportView(started)) throw new Error("The inspector did not start the import.");
      await follow(started);
    } catch (error) {
      report("error", explainCallFailure(error));
    } finally {
      busy = false;
      render();
    }
  };

  fromDevice.addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    const chosen = file.files?.[0];
    file.value = "";
    if (chosen === undefined) return;
    void run(async () => {
      if (chosen.size === 0) throw new Error("The file is empty.");
      let uploadId: string | undefined;
      try {
        for (let offset = 0; offset < chosen.size; offset += CHUNK_BYTES) {
          if (closed) throw new Error("Upload cancelled.");
          const bytes = new Uint8Array(
            await chosen.slice(offset, offset + CHUNK_BYTES).arrayBuffer(),
          );
          const result = await client.call("import_upload_write", {
            ...(uploadId === undefined ? { size: chosen.size } : { uploadId }),
            offset,
            base64: toBase64(bytes),
          });
          if (!isRecord(result) || typeof result.uploadId !== "string") {
            throw new Error("The upload was not saved.");
          }
          uploadId = result.uploadId;
          report(
            "muted",
            `Uploading ${chosen.name}: ${bytesLabel(offset + bytes.length)} of ${bytesLabel(chosen.size)}.`,
          );
        }
      } catch (error) {
        if (uploadId !== undefined) {
          void client.call("import_upload_discard", { uploadId }).catch(() => undefined);
        }
        throw error;
      }
      return client
        .call("import_flows", {
          uploadId,
          name: chosen.name.slice(0, MAX_NAME_CHARS),
          proxyId: proxy.value,
        })
        .catch((error: unknown) => {
          // A refused import never took the upload; drop it so it stops counting against storage.
          void client.call("import_upload_discard", { uploadId }).catch(() => undefined);
          throw error;
        });
    });
  });
  fromMachine.addEventListener("click", () => {
    // pickFile must be called inside the click, while the panel holds the user's activation.
    void run(async () => {
      const picked = await client.pickFile();
      if (picked === null) return undefined;
      report("muted", `Importing ${picked}…`);
      return client.call("import_flows", { path: picked, proxyId: proxy.value });
    });
  });
  fromPath.addEventListener("click", () => {
    void run(() => client.call("import_flows", { path: path.value.trim(), proxyId: proxy.value }));
  });
  path.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!fromPath.disabled) fromPath.click();
  });
  path.addEventListener("input", render);

  closeButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener(
    "close",
    () => {
      closed = true;
      dialog.remove();
    },
    { once: true },
  );
  document.body.append(dialog);
  render();
  if (live.length === 0) report("error", "Create a proxy first: every recording belongs to one.");
  dialog.showModal();
}
