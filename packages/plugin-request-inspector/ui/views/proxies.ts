// @effect-diagnostics globalTimers:off globalDate:off - Runs inside a sandboxed plugin frame, outside any Effect runtime.
import type { PluginChatTargets } from "@t3tools/plugin-sdk/ui";

import { isInvalidHostPatternDetail, NSS_DETAILS } from "../../backend/refusals.ts";
import type { ViewDefinition } from "../app/nav.ts";
import { CALLER_LINK_LABELS, destinationLabel, proxyFailureText } from "../app/proxies.ts";
import type { App, ProxyView } from "../app/state.ts";
import { fill, h, isRecord, messageOf, uid } from "../dom.ts";
import { copyButton, proxyDotClass } from "./proxyStrip.ts";

interface CertificateInfo {
  readonly exists: boolean;
  readonly files: { readonly pem: string; readonly cer: string; readonly p12: string };
  readonly combinedBundle?: string;
  readonly systemTrust: ReadonlyArray<{
    readonly os: string;
    readonly variant: string;
    readonly install: ReadonlyArray<string>;
    readonly remove: ReadonlyArray<string>;
  }>;
  readonly env: Readonly<Record<string, string>>;
  readonly nss: {
    readonly certutil: boolean;
    readonly dbs: ReadonlyArray<{
      readonly path: string;
      readonly kind: string;
      readonly installed: boolean;
    }>;
  };
}

type LinkTarget = { readonly threadId: string } | { readonly projectId: string };

const NSS_KINDS: Record<string, string> = {
  chromium: "Chrome / Chromium",
  firefox: "Firefox",
  "firefox-snap": "Firefox (snap)",
};

const MODE_LABELS: Record<ProxyView["mode"]["kind"], string> = {
  regular: "HTTP(S)",
  socks5: "SOCKS5",
  upstream: "via upstream",
};

export const styles = `
.proxies {
  overflow-y: auto;
}
.proxies-head {
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--border);
}
.proxies-head h2,
.proxy-detail h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.proxy-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.proxy-item {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 8px;
  width: 100%;
  height: auto;
  padding: 6px 12px;
  border: 0;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  background: transparent;
  text-align: left;
}
.proxy-item[aria-current="true"] {
  background: var(--muted);
}
.proxy-item .addr {
  color: var(--text-muted);
  font: 12px/1.4 var(--mono);
  text-align: right;
}
.proxy-item .meta {
  grid-column: 1 / 3;
  color: var(--text-faint);
  font-size: 11px;
}
.proxy-detail,
.cert {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid var(--border);
}
.proxy-form {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px 12px;
}
.proxy-form .wide {
  grid-column: 1 / -1;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.field > label,
.field > .label {
  color: var(--text-muted);
  font-size: 12px;
}
.field-error {
  color: var(--danger);
  font-size: 12px;
}
.links {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.target-results {
  max-height: 220px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) - 2px);
  list-style: none;
}
.target-results button {
  width: 100%;
  border: 0;
  border-radius: 0;
  background: transparent;
  text-align: left;
}
.target-results .group {
  padding: 4px 8px;
  color: var(--text-faint);
  font-size: 11px;
}
.cert summary {
  cursor: pointer;
  font-weight: 600;
}
.cert pre {
  margin: 0;
  padding: 6px 8px;
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) - 2px);
  background: var(--surface);
  font: 12px/1.5 var(--mono);
  white-space: pre;
}
.cert .path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font: 12px/1.4 var(--mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.proxy-detail p,
.cert p {
  margin: 0;
}
.proxy-detail h3,
.cert h3 {
  margin: 4px 0 0;
  font-size: 12px;
  font-weight: 600;
}
`;

const linesOf = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** The pattern an `invalidHostPatternDetail` refusal names, and why it was refused. */
const invalidPatternOf = (detail: string) => {
  const match = /^Invalid host pattern ("(?:[^"\\]|\\.)*"): ([\s\S]*)$/.exec(detail);
  if (match === null) return undefined;
  try {
    return { pattern: JSON.parse(match[1] ?? '""') as string, reason: match[2] ?? "" };
  } catch {
    return undefined;
  }
};

/** The proxy list, the picked proxy's links and options, and the shared CA certificate. */
export const mount = (root: HTMLElement, app: App): (() => void) => {
  const { client, notices, proxies } = app;
  const field = (label: string, control: HTMLElement, extra?: HTMLElement, wide = false) => {
    const id = uid("pf");
    control.id = id;
    return h(
      "div",
      { class: wide ? "field wide" : "field" },
      h("label", { for: id }, label),
      control,
      extra,
    );
  };
  const input = (props: Record<string, string> = {}) => h("input", props) as HTMLInputElement;

  const newProxy = h("button", { type: "button" }, "New proxy") as HTMLButtonElement;
  const list = h("ul", { class: "proxy-list", "aria-label": "Proxies" });
  const detail = h("section", { class: "proxy-detail" });
  const cert = h("details", { class: "cert" }) as HTMLDetailsElement;
  root.classList.add("proxies");
  root.replaceChildren(
    h("header", { class: "proxies-head row" }, h("h2", { class: "spacer" }, "Proxies"), newProxy),
    list,
    detail,
    cert,
  );

  // Detail: heading, state notices, links, form, delete.
  const title = h("h2", { class: "spacer" });
  const restart = h("button", { type: "button" }, "Restart now") as HTMLButtonElement;
  const restartNotice = h(
    "div",
    { class: "notice warn row", hidden: true },
    h("span", { class: "spacer" }, "Saved changes to the address or mode apply on the next start."),
    restart,
  );
  const failedNotice = h("div", { class: "notice error", hidden: true });
  const linkList = h("div", { class: "links" });
  const linkThread = h("button", { type: "button" }, "Link to this chat") as HTMLButtonElement;
  const linkProject = h("button", { type: "button" }, "Link to this project") as HTMLButtonElement;
  const linkOther = h(
    "button",
    { type: "button", "aria-expanded": "false", "data-host-tools": "" },
    "Link to…",
  ) as HTMLButtonElement;
  const targetQuery = input({
    type: "search",
    placeholder: "Search chats and projects",
    "aria-label": "Search chats and projects",
  });
  const targetResults = h("ul", { class: "target-results" });
  const targetPicker = h("div", { class: "field", hidden: true }, targetQuery, targetResults);

  const name = input({ maxlength: "64" });
  const listenHost = input({ placeholder: "127.0.0.1" });
  const portMode = h(
    "select",
    { "aria-label": "Port choice" },
    h("option", { value: "auto" }, "Auto"),
    h("option", { value: "fixed" }, "Fixed"),
  ) as HTMLSelectElement;
  const port = input({ type: "number", min: "1", max: "65535", "aria-label": "Port number" });
  const mode = h(
    "select",
    {},
    h("option", { value: "regular" }, "Regular HTTP(S) proxy"),
    h("option", { value: "socks5" }, "SOCKS5"),
    h("option", { value: "upstream" }, "Through an upstream proxy"),
  ) as HTMLSelectElement;
  const upstreamUrl = input({ placeholder: "http://proxy.example:3128" });
  const username = input({ autocomplete: "off" });
  const password = input({ type: "password", autocomplete: "new-password" });
  const authState = h("span", { class: "muted" });
  const clearAuth = h("button", { type: "button" }, "Clear saved credentials") as HTMLButtonElement;
  const passthrough = h("textarea", {
    rows: "3",
    spellcheck: "false",
    placeholder: "*.bank.example",
  }) as HTMLTextAreaElement;
  const ignored = h("textarea", {
    rows: "3",
    spellcheck: "false",
    placeholder: "telemetry.example:443",
  }) as HTMLTextAreaElement;
  const passthroughError = h("div", { class: "field-error", hidden: true });
  const ignoredError = h("div", { class: "field-error", hidden: true });
  const formError = h("div", { class: "field-error", hidden: true });
  const save = h("button", { type: "submit", class: "primary" }, "Save") as HTMLButtonElement;
  const saved = h("span", { class: "muted" });
  const upstreamFields = h(
    "div",
    { class: "proxy-form wide" },
    field("Upstream URL", upstreamUrl, undefined, true),
    field("Username", username),
    field("Password", password),
    h("div", { class: "row wide" }, authState, clearAuth),
  );
  const form = h(
    "form",
    { class: "proxy-form" },
    field("Name", name),
    field("Listen host", listenHost),
    h(
      "div",
      { class: "field" },
      h("span", { class: "label" }, "Port"),
      h("div", { class: "row" }, portMode, port),
    ),
    field("Mode", mode),
    upstreamFields,
    field(
      "Pass-through hosts: forwarded without decrypting, recorded as tunnels. One pattern per line.",
      passthrough,
      passthroughError,
      true,
    ),
    field(
      "Ignored hosts: forwarded without decrypting and not recorded. One pattern per line.",
      ignored,
      ignoredError,
      true,
    ),
    h("div", { class: "row wide" }, save, saved, formError),
  ) as HTMLFormElement;
  const deleteProxy = h("button", { type: "button" }, "Delete proxy") as HTMLButtonElement;
  const deleteWhy = h("span", { class: "muted" });

  let formFor: string | undefined;
  let dirty = false;
  let clearingAuth = false;
  let busy = false;
  let deleteArmed = false;
  let targetNames = new Map<string, string>();
  let targetsTimer: ReturnType<typeof setTimeout> | undefined;
  let targetsGeneration = 0;
  let renderQueued = false;
  let renderFrame: number | undefined;

  const current = () => {
    const id = proxies.selected.get();
    return id === null ? undefined : proxies.get(id);
  };

  const call = async (operation: string, input: Record<string, unknown>) => {
    busy = true;
    scheduleRender();
    notices.set("dismiss:proxies", "error", null);
    try {
      return await client.call(operation, input);
    } catch (error) {
      notices.set("dismiss:proxies", "error", proxyFailureText(error));
      return undefined;
    } finally {
      busy = false;
      scheduleRender();
    }
  };

  const renderList = () => {
    const selectedId = proxies.selected.get();
    const items = proxies.list();
    fill(
      list,
      ...items.map((proxy) => {
        const link = proxy.callerLink === null ? null : CALLER_LINK_LABELS[proxy.callerLink];
        return h(
          "li",
          {},
          h(
            "button",
            {
              type: "button",
              class: "proxy-item",
              "aria-current": String(proxy.id === selectedId),
              "data-proxy": proxy.id,
            },
            h("span", {}, h("span", { class: proxyDotClass(proxy) }), proxy.name),
            h(
              "span",
              { class: "addr" },
              proxy.listen === null
                ? `${proxy.requested.host}:${proxy.requested.port}`
                : `${proxy.listen.host}:${proxy.listen.port}`,
            ),
            h(
              "span",
              { class: "meta" },
              proxy.deletedAt !== null && h("span", { class: "tag" }, "deleted"),
              h("span", { class: "tag" }, MODE_LABELS[proxy.mode.kind]),
              proxy.recording !== null && h("span", { class: "tag" }, "recording"),
              proxy.restartRequired && h("span", { class: "tag" }, "restart needed"),
              link !== null && h("span", { class: "tag info" }, link),
              proxy.links.length > 0 &&
                `${proxy.links.length} link${proxy.links.length === 1 ? "" : "s"}`,
            ),
          ),
        );
      }),
      items.length === 0 && h("li", { class: "empty" }, "No proxies yet. Create one to start."),
    );
  };

  const linkLabel = (link: ProxyView["links"][number]) => {
    const caller = proxies.caller();
    const mine =
      link.kind === "thread" ? caller?.threadId === link.id : caller?.projectId === link.id;
    const known = targetNames.get(`${link.kind}:${link.id}`);
    const kind = link.kind === "thread" ? "Chat" : "Project";
    return `${kind}: ${known ?? link.id}${mine ? ` (this ${link.kind === "thread" ? "chat" : "project"})` : ""}`;
  };

  const linkTarget = (link: ProxyView["links"][number]): LinkTarget =>
    link.kind === "thread" ? { threadId: link.id } : { projectId: link.id };

  const renderLinks = (proxy: ProxyView) => {
    fill(
      linkList,
      proxy.links.length === 0 &&
        h(
          "span",
          { class: "muted" },
          "Not linked. Agents in a linked chat or project use this proxy when they omit proxyId.",
        ),
      ...proxy.links.map((link) =>
        h(
          "div",
          { class: "row" },
          h("span", { class: "spacer" }, linkLabel(link)),
          h(
            "button",
            {
              type: "button",
              class: "ghost",
              disabled: busy,
              onclick: () =>
                void call("unlink_proxy", { target: linkTarget(link), proxyId: proxy.id }),
            },
            "Unlink",
          ),
        ),
      ),
    );
    const caller = proxies.caller();
    const live = proxy.deletedAt === null;
    linkThread.hidden =
      !live ||
      caller?.threadId == null ||
      proxy.links.some((link) => link.kind === "thread" && link.id === caller.threadId);
    linkProject.hidden =
      !live ||
      caller?.projectId == null ||
      proxy.links.some((link) => link.kind === "project" && link.id === caller.projectId);
    linkOther.hidden = !live;
    for (const button of [linkThread, linkProject, linkOther]) button.disabled = busy;
  };

  const populate = (proxy: ProxyView) => {
    if (formFor !== proxy.id) saved.textContent = "";
    formFor = proxy.id;
    dirty = false;
    clearingAuth = false;
    name.value = proxy.name;
    listenHost.value = proxy.requested.host;
    portMode.value = proxy.requested.port === "auto" ? "auto" : "fixed";
    port.value = proxy.requested.port === "auto" ? "" : String(proxy.requested.port);
    mode.value = proxy.mode.kind;
    upstreamUrl.value = proxy.mode.url ?? "";
    username.value = "";
    password.value = "";
    passthrough.value = proxy.passthroughHosts.join("\n");
    ignored.value = proxy.ignoredHosts.join("\n");
    for (const error of [passthroughError, ignoredError, formError]) error.hidden = true;
  };

  const renderFormState = (proxy: ProxyView) => {
    port.hidden = portMode.value === "auto";
    upstreamFields.hidden = mode.value !== "upstream";
    const hasAuth = proxy.mode.kind === "upstream" && proxy.mode.hasAuth === true && !clearingAuth;
    authState.textContent = clearingAuth
      ? "Saved credentials will be cleared on save."
      : hasAuth
        ? "Credentials saved. Leave both fields empty to keep them."
        : "No credentials saved.";
    clearAuth.hidden = !hasAuth;
    username.placeholder = hasAuth ? "saved" : "optional";
    password.placeholder = hasAuth ? "saved" : "optional";
    save.disabled = busy;
  };

  const renderDetail = () => {
    const proxy = current();
    if (proxy === undefined) {
      formFor = undefined;
      fill(
        detail,
        h(
          "p",
          { class: "muted" },
          proxies.ready()
            ? "Pick a proxy in the list or the header to see its links and options."
            : "Loading proxies…",
        ),
      );
      return;
    }
    title.textContent = proxy.name;
    if (proxy.deletedAt !== null) {
      formFor = undefined;
      fill(
        detail,
        h("div", { class: "row" }, title),
        h(
          "p",
          { class: "muted" },
          `Deleted ${new Date(proxy.deletedAt).toLocaleString()}. Its recordings stay until you delete them from the Requests view.`,
        ),
      );
      return;
    }
    if (formFor !== proxy.id || !dirty) populate(proxy);
    const running = proxy.state === "running" || proxy.state === "starting";
    restartNotice.hidden = !(running && proxy.restartRequired);
    restart.disabled = busy;
    failedNotice.hidden = proxy.state !== "failed";
    failedNotice.textContent = `Failed to start${proxy.stateDetail === undefined ? "." : `: ${proxy.stateDetail}`}`;
    renderLinks(proxy);
    renderFormState(proxy);
    deleteProxy.disabled = busy || running;
    if (running && deleteArmed) {
      deleteArmed = false;
      deleteProxy.textContent = "Delete proxy";
    }
    deleteWhy.textContent = running
      ? "Stop the proxy before deleting it."
      : proxy.recording !== null
        ? "Stop the recording before deleting it."
        : "Its recordings are kept.";
    if (!detail.contains(form)) {
      fill(
        detail,
        h("div", { class: "row" }, title),
        failedNotice,
        restartNotice,
        h("h3", {}, "Links"),
        linkList,
        h("div", { class: "row" }, linkThread, linkProject, linkOther),
        targetPicker,
        h("h3", {}, "Options"),
        form,
        h("div", { class: "row" }, deleteProxy, deleteWhy),
      );
    }
  };

  const render = () => {
    renderList();
    renderDetail();
  };

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    renderFrame = requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  list.addEventListener("click", (event) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>("[data-proxy]")?.dataset.proxy;
    if (id !== undefined) proxies.select(id);
  });

  newProxy.addEventListener("click", async () => {
    const created = await call("create_proxy", {});
    if (isRecord(created) && typeof created.id === "string") {
      proxies.select(created.id);
      proxies.refresh();
    }
  });

  restart.addEventListener("click", () => {
    const proxy = current();
    if (proxy !== undefined)
      void call("update_proxy", { proxyId: proxy.id, options: {}, restart: true });
  });

  const link = async (target: "thread" | "project" | LinkTarget) => {
    const proxy = current();
    if (proxy === undefined) return;
    await call("link_proxy", { proxyId: proxy.id, target });
    proxies.refresh();
  };
  linkThread.addEventListener("click", () => void link("thread"));
  linkProject.addEventListener("click", () => void link("project"));

  const rememberTargets = (targets: PluginChatTargets) => {
    for (const thread of targets.threads) {
      targetNames.set(`thread:${thread.threadId}`, `${thread.title} · ${thread.projectName}`);
    }
    for (const project of targets.projects)
      targetNames.set(`project:${project.projectId}`, project.name);
  };

  const renderTargets = (targets: PluginChatTargets) => {
    const pick = (label: string, target: LinkTarget) =>
      h(
        "li",
        {},
        h(
          "button",
          {
            type: "button",
            onclick: () => {
              closeTargets();
              void link(target);
            },
          },
          label,
        ),
      );
    fill(
      targetResults,
      targets.threads.length > 0 && h("li", { class: "group" }, "Chats"),
      ...targets.threads.map((thread) =>
        pick(`${thread.title} · ${thread.projectName}`, { threadId: thread.threadId }),
      ),
      targets.projects.length > 0 && h("li", { class: "group" }, "Projects"),
      ...targets.projects.map((project) => pick(project.name, { projectId: project.projectId })),
      targets.threads.length === 0 &&
        targets.projects.length === 0 &&
        h("li", { class: "empty" }, "No chats or projects match."),
    );
  };

  const searchTargets = () => {
    clearTimeout(targetsTimer);
    targetsTimer = setTimeout(async () => {
      targetsGeneration += 1;
      const generation = targetsGeneration;
      const query = targetQuery.value.trim();
      try {
        const targets = await client.listChatTargets(query === "" ? undefined : query);
        if (generation !== targetsGeneration) return;
        rememberTargets(targets);
        renderTargets(targets);
      } catch (error) {
        if (generation !== targetsGeneration) return;
        fill(targetResults, h("li", { class: "empty" }, messageOf(error)));
      }
    }, 200);
  };

  const closeTargets = () => {
    targetPicker.hidden = true;
    linkOther.setAttribute("aria-expanded", "false");
  };
  linkOther.addEventListener("click", () => {
    const opening = targetPicker.hidden;
    if (!opening) return closeTargets();
    targetPicker.hidden = false;
    linkOther.setAttribute("aria-expanded", "true");
    targetQuery.value = "";
    fill(targetResults, h("li", { class: "empty" }, "Loading…"));
    searchTargets();
    targetQuery.focus();
  });
  targetQuery.addEventListener("input", searchTargets);
  targetQuery.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeTargets();
  });

  /** Names for links come from the host's chat list; ids it does not list are shown raw. */
  const loadTargetNames = async () => {
    try {
      const targets = await client.listChatTargets();
      targetNames = new Map();
      rememberTargets(targets);
      scheduleRender();
    } catch {
      // Links still show their ids.
    }
  };

  form.addEventListener("input", () => {
    dirty = true;
    saved.textContent = "";
    const proxy = current();
    if (proxy !== undefined) renderFormState(proxy);
  });
  form.addEventListener("change", () => {
    const proxy = current();
    if (proxy !== undefined) renderFormState(proxy);
  });
  clearAuth.addEventListener("click", () => {
    clearingAuth = true;
    dirty = true;
    saved.textContent = "";
    const proxy = current();
    if (proxy !== undefined) renderFormState(proxy);
  });

  const showFormError = (detail: string) => {
    const invalid = isInvalidHostPatternDetail(detail) ? invalidPatternOf(detail) : undefined;
    if (invalid !== undefined) {
      for (const [area, error] of [
        [passthrough, passthroughError],
        [ignored, ignoredError],
      ] as const) {
        const line = linesOf(area.value).indexOf(invalid.pattern);
        if (line < 0) continue;
        error.textContent = `Line ${line + 1}, ${JSON.stringify(invalid.pattern)}: ${invalid.reason}`;
        error.hidden = false;
        return;
      }
    }
    formError.textContent = detail;
    formError.hidden = false;
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const proxy = current();
    if (proxy === undefined) return;
    for (const error of [passthroughError, ignoredError, formError]) error.hidden = true;
    const portNumber = Number(port.value);
    if (
      portMode.value === "fixed" &&
      (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535)
    ) {
      showFormError("The port must be a number from 1 to 65535.");
      return;
    }
    const user = username.value;
    const pass = password.value;
    if ((user === "") !== (pass === "")) {
      showFormError("Enter both a username and a password, or neither.");
      return;
    }
    const modeInput =
      mode.value === "upstream"
        ? {
            kind: "upstream",
            url: upstreamUrl.value.trim(),
            ...(user !== ""
              ? { auth: { username: user, password: pass } }
              : clearingAuth
                ? { auth: null }
                : {}),
          }
        : { kind: mode.value };
    busy = true;
    renderFormState(proxy);
    try {
      const result = await client.call("update_proxy", {
        proxyId: proxy.id,
        ...(name.value.trim() === "" || name.value.trim() === proxy.name
          ? {}
          : { name: name.value.trim() }),
        options: {
          listenHost: listenHost.value.trim(),
          listenPort: portMode.value === "auto" ? "auto" : portNumber,
          mode: modeInput,
          passthroughHosts: linesOf(passthrough.value),
          ignoredHosts: linesOf(ignored.value),
        },
      });
      dirty = false;
      clearingAuth = false;
      const updated =
        isRecord(result) && isRecord(result.proxy)
          ? (result.proxy as unknown as ProxyView)
          : undefined;
      if (updated !== undefined) populate(updated);
      saved.textContent =
        isRecord(result) && result.restartRequired === true
          ? "Saved. The address or mode applies after a restart."
          : "Saved.";
    } catch (error) {
      showFormError(proxyFailureText(error));
    } finally {
      busy = false;
      scheduleRender();
    }
  });

  deleteProxy.addEventListener("blur", () => {
    deleteArmed = false;
    deleteProxy.textContent = "Delete proxy";
  });
  deleteProxy.addEventListener("click", async () => {
    const proxy = current();
    if (proxy === undefined) return;
    if (!deleteArmed) {
      deleteArmed = true;
      deleteProxy.textContent = `Delete ${proxy.name}?`;
      return;
    }
    deleteArmed = false;
    deleteProxy.textContent = "Delete proxy";
    if ((await call("delete_proxy", { proxyId: proxy.id })) !== undefined) proxies.refresh();
  });

  // The CA certificate, shared by every proxy. Loads on first open: it may start mitmdump once.
  let certLoaded = false;
  let certGeneration = 0;
  const certBody = h("div", { class: "links" });
  const certSummary = h("summary", {}, "CA certificate");

  const pathRow = (label: string, path: string) =>
    h(
      "div",
      { class: "row" },
      h("span", { class: "muted" }, label),
      h("span", { class: "path", title: path }, path),
      copyButton(app, "Copy", () => path),
    );

  const commandBlock = (label: string, commands: ReadonlyArray<string>) => {
    const text = commands.join("\n");
    return h(
      "div",
      { class: "field" },
      h(
        "div",
        { class: "row" },
        h("span", { class: "label spacer" }, label),
        copyButton(app, "Copy", () => text),
      ),
      h("pre", {}, text),
    );
  };

  const renderCert = (info: CertificateInfo) => {
    const where = destinationLabel(client);
    const envText = Object.entries(info.env)
      .map(([key, value]) => `export ${key}=${value}`)
      .join("\n");
    const nssAction = (operation: string, label: string) =>
      h(
        "button",
        {
          type: "button",
          disabled: !info.nss.certutil || info.nss.dbs.length === 0,
          onclick: async () => {
            const result = await call(operation, {});
            const failures =
              isRecord(result) && Array.isArray(result.results)
                ? (
                    result.results as ReadonlyArray<{ path: string; ok: boolean; detail?: string }>
                  ).filter((entry) => !entry.ok)
                : [];
            if (failures.length > 0) {
              notices.set(
                "dismiss:proxies",
                "error",
                failures.map((entry) => `${entry.path}: ${entry.detail ?? "failed"}`).join("\n"),
              );
            }
            await loadCert();
          },
        },
        label,
      );
    fill(
      certBody,
      !info.exists &&
        h(
          "p",
          { class: "muted" },
          "mitmproxy has not created the CA yet. Start any proxy once, then reload.",
        ),
      h("h3", {}, "Files"),
      pathRow("PEM", info.files.pem),
      pathRow("CER", info.files.cer),
      pathRow("P12", info.files.p12),
      info.combinedBundle !== undefined && pathRow("System bundle + CA", info.combinedBundle),
      h("h3", {}, `Trust it system-wide on ${where}`),
      h(
        "p",
        { class: "muted" },
        "Run these yourself in a terminal there; they need sudo or an elevated prompt.",
      ),
      info.systemTrust.length === 0 && h("p", { class: "muted" }, "No commands for this system."),
      ...info.systemTrust.flatMap((entry) => [
        commandBlock(`${entry.variant}: install`, entry.install),
        commandBlock(`${entry.variant}: remove`, entry.remove),
      ]),
      h("h3", {}, "Environment for clients"),
      envText === ""
        ? h("p", { class: "muted" }, "None.")
        : commandBlock("Shell exports", envText.split("\n")),
      h("h3", {}, `Browsers on ${where}`),
      !info.nss.certutil && h("div", { class: "notice warn" }, NSS_DETAILS.certutilMissing),
      info.nss.dbs.length === 0 &&
        h("p", { class: "muted" }, "No Chrome, Chromium or Firefox certificate databases found."),
      ...info.nss.dbs.map((db) =>
        h(
          "div",
          { class: "row" },
          h("span", { class: "tag" }, db.installed ? "installed" : "not installed"),
          h("span", { class: "muted" }, NSS_KINDS[db.kind] ?? db.kind),
          h("span", { class: "path", title: db.path }, db.path),
        ),
      ),
      h(
        "div",
        { class: "row" },
        nssAction("install_certificate_nss", `Install in browsers on ${where}`),
        nssAction("uninstall_certificate_nss", `Remove from browsers on ${where}`),
        h("span", { class: "spacer" }),
        h("button", { type: "button", class: "ghost", onclick: () => void loadCert() }, "Reload"),
      ),
    );
  };

  async function loadCert() {
    certGeneration += 1;
    const generation = certGeneration;
    if (!certLoaded) fill(certBody, h("p", { class: "muted" }, "Loading the certificate…"));
    const proxyId = proxies.selected.get();
    try {
      const info = await client.call("certificate_info", proxyId === null ? {} : { proxyId });
      if (generation !== certGeneration) return;
      certLoaded = true;
      renderCert(info as CertificateInfo);
    } catch (error) {
      if (generation !== certGeneration) return;
      fill(
        certBody,
        h("div", { class: "notice error" }, proxyFailureText(error)),
        h("button", { type: "button", onclick: () => void loadCert() }, "Retry"),
      );
    }
  }
  cert.replaceChildren(certSummary, certBody);
  cert.addEventListener("toggle", () => {
    if (cert.open && !certLoaded) void loadCert();
  });

  let linksKey = "";
  const onProxies = () => {
    // Links to chats outside the first page of names would show raw ids; reload names when links change.
    const key = proxies
      .list()
      .flatMap((proxy) => proxy.links.map((entry) => `${entry.kind}:${entry.id}`))
      .join(",");
    if (key !== linksKey) {
      linksKey = key;
      if (key !== "") void loadTargetNames();
    }
    scheduleRender();
  };
  const offProxies = proxies.on(onProxies);
  let certProxy = proxies.selected.get();
  const offSelected = proxies.selected.subscribe((id) => {
    closeTargets();
    deleteArmed = false;
    deleteProxy.textContent = "Delete proxy";
    // The env block names the picked proxy's URL.
    if (certLoaded && cert.open && id !== certProxy) void loadCert();
    certProxy = id;
    scheduleRender();
  });
  onProxies();
  render();

  return () => {
    offProxies();
    offSelected();
    clearTimeout(targetsTimer);
    targetsGeneration += 1;
    certGeneration += 1;
    if (renderFrame !== undefined) cancelAnimationFrame(renderFrame);
  };
};

export const view: ViewDefinition = { slot: "proxies", styles: [styles], mount };
