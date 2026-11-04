// @effect-diagnostics globalTimers:off globalDate:off - Runs inside a sandboxed plugin frame, outside any Effect runtime.
import { CALLER_LINK_LABELS, proxyEnvText, proxyFailureText, proxyUrlOf } from "../app/proxies.ts";
import type { App, CallerLink, ProxyView } from "../app/state.ts";
import { fill, h, isRecord, timeLabel } from "../dom.ts";

/** Shared by every view: the app bar, the status dot and small tags. */
export const styles = `
.appbar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.proxy-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.icon-btn {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 999px;
  color: var(--text-faint);
}
.icon-btn svg {
  display: block;
}
.icon-btn.power[data-tone="live"] {
  border-color: color-mix(in srgb, var(--success) 45%, transparent);
  background: color-mix(in srgb, var(--success) 14%, transparent);
  color: var(--success);
}
.icon-btn.power[data-tone="warn"] {
  border-color: color-mix(in srgb, var(--warning) 45%, transparent);
  color: var(--warning);
}
.icon-btn.power[data-tone="fail"] {
  border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  color: var(--danger);
}
.rec-btn {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  color: var(--text-muted);
}
.rec-btn svg {
  display: block;
  color: var(--text-faint);
}
.rec-btn:not(:disabled):hover svg {
  color: var(--danger);
}
.rec-btn[aria-pressed="true"] {
  border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  background: color-mix(in srgb, var(--danger) 16%, transparent);
  color: var(--danger);
}
.rec-btn[aria-pressed="true"] svg {
  color: var(--danger);
}
.proxy-state {
  min-width: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.proxy-state[data-tone="live"] {
  color: var(--success);
}
.proxy-state[data-tone="rec"],
.proxy-state[data-tone="fail"] {
  color: var(--danger);
}
.proxy-state[data-tone="warn"] {
  color: var(--warning);
}
.picker {
  position: relative;
  flex: 0 1 auto;
  min-width: 0;
}
.picker-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  height: 30px;
  padding: 0 8px 0 10px;
}
.picker-trigger .picker-label {
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.picker-trigger .dot,
.menu .dot {
  margin-right: 0;
}
.picker-name {
  min-width: 0;
  max-width: 20ch;
  overflow: hidden;
  text-overflow: ellipsis;
}
.picker-port {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 11px;
}
@media (max-width: 400px) {
  .picker-trigger .picker-label {
    display: none;
  }
}
.picker-caret {
  display: inline-flex;
  color: var(--text-faint);
}
.menu {
  position: absolute;
  z-index: 20;
  top: calc(100% + 4px);
  right: 0;
  width: max-content;
  min-width: 240px;
  max-width: min(340px, calc(100vw - 24px));
  max-height: min(360px, 70vh);
  padding: 4px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.menu-heading {
  padding: 6px 8px 4px;
  color: var(--text-faint);
  font-size: 11px;
}
.menu-row {
  display: flex;
  align-items: center;
  gap: 2px;
  border-radius: calc(var(--radius) - 3px);
}
.menu-row:hover,
.menu-row:focus-within {
  background: var(--muted);
}
.menu-item {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border: 0;
  background: transparent;
  text-align: left;
}
.menu-item:hover:not(:disabled) {
  background: transparent;
}
.menu-item:focus-visible {
  outline-offset: -2px;
}
.menu-item .picker-name {
  flex: 0 1 auto;
  max-width: none;
}
.menu-item .tag {
  margin: 0 0 0 auto;
}
.menu-item .check {
  display: inline-flex;
  width: 14px;
  margin-left: auto;
  color: var(--text);
}
.menu-x {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-right: 2px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-faint);
}
.menu-x:hover:not(:disabled) {
  background: var(--danger-bg);
  color: var(--danger);
}
.menu-sep {
  height: 1px;
  margin: 4px 0;
  background: var(--border);
}
.menu-action {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: 0;
  background: transparent;
  color: var(--text);
  text-align: left;
}
.menu-action:focus-visible {
  outline-offset: -2px;
}
.menu-empty {
  padding: 4px 8px 6px;
  color: var(--text-muted);
  font-size: 12px;
}
dialog.confirm {
  width: min(380px, calc(100vw - 24px));
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
}
dialog.confirm::backdrop {
  background: rgba(0, 0, 0, 0.45);
}
dialog.confirm form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
}
dialog.confirm h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
dialog.confirm .confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
dialog.confirm p {
  margin: 0;
  color: var(--text-muted);
}
button.danger {
  border-color: transparent;
  background: var(--danger);
  color: var(--bg);
}
button.danger:hover:not(:disabled) {
  background: var(--danger);
  opacity: 0.9;
}
.appbar details.hint p {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.dot {
  display: inline-block;
  flex: none;
  width: 7px;
  height: 7px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--text-faint);
  vertical-align: 1px;
}
.dot.live {
  background: var(--success);
}
.dot.rec {
  background: var(--danger);
}
.dot.warn {
  background: var(--warning);
}
.dot.fail {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--danger);
}
.tag {
  display: inline-block;
  margin-right: 4px;
  padding: 0 4px;
  border: 1px solid var(--input-border);
  border-radius: 4px;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 14px;
  white-space: nowrap;
}
.tag.info {
  border-color: transparent;
  background: var(--muted);
  color: var(--info);
}
details.hint {
  color: var(--text-muted);
  font-size: 12px;
}
details.hint summary {
  cursor: pointer;
}
details.hint p {
  margin: 4px 0 0;
}
button.toggle[aria-pressed="true"] {
  border-color: var(--text-faint);
  background: var(--muted);
  color: var(--text);
}
button.link {
  height: auto;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--info);
  text-decoration: underline;
}
button.link:hover:not(:disabled) {
  background: transparent;
}
`;

/** Stopped is grey, starting amber, running green, recording solid red, failed a red ring. */
export const proxyDotClass = (proxy: ProxyView) => {
  if (proxy.recording !== null) return "dot rec";
  switch (proxy.state) {
    case "running":
      return "dot live";
    case "starting":
      return "dot warn";
    case "failed":
      return "dot fail";
    default:
      return "dot";
  }
};

/** Copies on click and briefly says so; `copyText` needs the click's user activation. */
export const copyButton = (app: App, label: string, text: () => string, title?: string) => {
  const button = h(
    "button",
    { type: "button", "data-host-tools": "", ...(title === undefined ? {} : { title }) },
    label,
  ) as HTMLButtonElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener("click", () => {
    app.client.copyText(text()).then(
      () => {
        button.textContent = "Copied";
        clearTimeout(timer);
        timer = setTimeout(() => (button.textContent = label), 1500);
      },
      (error: unknown) => app.notices.set("dismiss:copy", "error", proxyFailureText(error)),
    );
  });
  return button;
};

const svg = (body: string, size = 14) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const POWER_ICON = svg('<path d="M8 1.8v5.6"/><path d="M11.6 3.9a5.4 5.4 0 1 1-7.2 0"/>');
const RECORD_ICON =
  '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor"/></svg>';
const CARET_ICON = svg('<path d="M4.5 6.5 8 10l3.5-3.5"/>', 12);
const CHECK_ICON = svg('<path d="m3.5 8.5 3 3 6-7"/>', 12);
const X_ICON = svg('<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>', 12);
const PLUS_ICON = svg('<path d="M8 3v10M3 8h10"/>', 12);
const BACK_ICON = svg('<path d="M9.5 3.5 5 8l4.5 4.5"/>', 12);

const icon = (markup: string, className = "") => {
  const span = h("span", className === "" ? {} : { class: className });
  span.innerHTML = markup;
  return span;
};

type Tone = "idle" | "live" | "rec" | "warn" | "fail";

const proxyState = (proxy: ProxyView | undefined): { text: string; tone: Tone } => {
  if (proxy === undefined) return { text: "No proxy", tone: "idle" };
  if (proxy.deletedAt !== null) return { text: "Deleted", tone: "idle" };
  const port = proxy.listen === null ? "" : ` :${proxy.listen.port}`;
  if (proxy.recording !== null) return { text: `Recording${port}`, tone: "rec" };
  switch (proxy.state) {
    case "running":
      return { text: `Running${port}`, tone: "live" };
    case "starting":
      return { text: "Starting…", tone: "warn" };
    case "failed":
      return { text: "Failed", tone: "fail" };
    default:
      return { text: "Stopped", tone: "idle" };
  }
};

const LINK_TAGS: Record<CallerLink, string | null> = {
  thread: null,
  project: "project",
  parentThread: "parent chat",
  rootThread: "root chat",
};

/**
 * Asks before removing a proxy from the menu. Sandboxed frames cannot open confirm(), so this
 * is a modal dialog. Resolves to the chosen action, or null when cancelled.
 */
const confirmRemoval = (proxy: ProxyView, place: string | null) =>
  new Promise<"disconnect" | "delete" | null>((resolve) => {
    let choice: "disconnect" | "delete" | null = null;
    const pick = (value: typeof choice) => () => {
      choice = value;
      dialog.close();
    };
    const active = proxy.state === "running" || proxy.state === "starting";
    const dialog = h(
      "dialog",
      { class: "confirm", "aria-label": `Remove ${proxy.name}` },
      h(
        "form",
        { method: "dialog" },
        h("h2", {}, `Remove ${proxy.name}?`),
        h(
          "p",
          {},
          place === null ? "" : `Disconnect removes it from ${place} and keeps it for others. `,
          active ? "Delete stops and removes the proxy. " : "Delete removes the proxy. ",
          "Recorded requests are kept either way.",
        ),
        h(
          "div",
          { class: "confirm-actions" },
          h("button", { type: "button", class: "ghost", onclick: pick(null) }, "Cancel"),
          place !== null &&
            h("button", { type: "button", onclick: pick("disconnect") }, "Disconnect"),
          h("button", { type: "button", class: "danger", onclick: pick("delete") }, "Delete"),
        ),
      ),
    ) as HTMLDialogElement;
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener(
      "close",
      () => {
        dialog.remove();
        resolve(choice);
      },
      { once: true },
    );
    document.body.append(dialog);
    dialog.showModal();
  });

/**
 * The app bar. Left: the selected proxy's power and record buttons and its state. Right: a
 * picker listing the proxies connected to the panel's chat, with ways to connect or create
 * one. With no chat or project (the page route) every live proxy is listed. Below sit the
 * instructions for routing traffic through the selected proxy.
 */
export const mount = (root: HTMLElement, app: App): (() => void) => {
  const { client, notices, proxies } = app;
  const powerButton = h("button", { type: "button", class: "icon-btn power" }) as HTMLButtonElement;
  powerButton.innerHTML = POWER_ICON;
  const recordButton = h("button", {
    type: "button",
    class: "rec-btn",
    "aria-pressed": "false",
  }) as HTMLButtonElement;
  recordButton.innerHTML = RECORD_ICON;
  recordButton.append("Record");
  const stateLabel = h("span", { class: "proxy-state", role: "status" });

  const trigger = h("button", {
    type: "button",
    class: "picker-trigger",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
  }) as HTMLButtonElement;
  const connectButton = h(
    "button",
    { type: "button", class: "picker-trigger" },
    icon(PLUS_ICON, "picker-caret"),
    "New or connect proxy",
  ) as HTMLButtonElement;
  const menu = h("div", { class: "menu", role: "menu", hidden: true });
  const picker = h("div", { class: "picker" }, trigger, connectButton, menu);
  const loading = h("span", { class: "faint" }, "Loading proxies…");

  const urlText = h("span", { class: "mono" });
  const usage = h(
    "details",
    { class: "hint", hidden: true },
    h("summary", {}, "Use this proxy"),
    h(
      "p",
      {},
      urlText,
      copyButton(app, "Copy URL", () => currentUrl() ?? ""),
      copyButton(
        app,
        "Copy env",
        () => proxyEnvText(currentUrl() ?? ""),
        "HTTP_PROXY, HTTPS_PROXY and ALL_PROXY as shell exports",
      ),
    ),
    h(
      "p",
      {},
      "Only traffic you route here is seen. For HTTPS, trust the CA certificate:",
      h(
        "button",
        { type: "button", class: "link", onclick: () => app.view.set("proxies") },
        "Proxies → CA certificate",
      ),
    ),
  ) as HTMLDetailsElement;
  root.replaceChildren(
    h(
      "div",
      { class: "proxy-bar" },
      powerButton,
      stateLabel,
      h("span", { class: "spacer" }),
      recordButton,
      picker,
      loading,
    ),
    usage,
  );

  let busy = false;
  let menuPage: "list" | "connect" | null = null;

  const current = () => {
    const id = proxies.selected.get();
    return id === null ? undefined : proxies.get(id);
  };
  const currentUrl = () => {
    const proxy = current();
    return proxy === undefined ? null : proxyUrlOf(proxy);
  };
  const hasChat = () => {
    const caller = proxies.caller();
    return caller !== null && (caller.threadId !== null || caller.projectId !== null);
  };
  const live = () => proxies.list().filter((proxy) => proxy.deletedAt === null);
  /** The menu's proxies: those this chat reaches through a link, or every one with no chat. */
  const listed = () => (hasChat() ? live().filter((proxy) => proxy.callerLink !== null) : live());

  const unlinkTarget = (link: CallerLink): string | Record<string, string> | null => {
    const caller = proxies.caller();
    switch (link) {
      case "thread":
        return "thread";
      case "project":
        return "project";
      case "parentThread":
        return caller?.parentThreadId == null ? null : { threadId: caller.parentThreadId };
      case "rootThread":
        return caller?.rootThreadId == null ? null : { threadId: caller.rootThreadId };
    }
  };

  const run = async (operation: string, input: Record<string, unknown>) => {
    busy = true;
    render();
    notices.set("dismiss:proxy", "error", null);
    try {
      return await client.call(operation, input);
    } catch (error) {
      notices.set("dismiss:proxy", "error", proxyFailureText(error));
      return undefined;
    } finally {
      busy = false;
      render();
    }
  };

  const openMenu = (page: "list" | "connect") => {
    menuPage = page;
    renderMenu();
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  };
  const closeMenu = (focusTrigger = false) => {
    if (menuPage === null) return;
    menuPage = null;
    renderMenu();
    if (focusTrigger) (trigger.hidden ? connectButton : trigger).focus();
  };

  const proxyItem = (proxy: ProxyView, onPick: () => void, trailing: Node | null) => {
    const port = proxy.state === "running" && proxy.listen !== null ? `:${proxy.listen.port}` : "";
    const tag = proxy.callerLink === null ? null : LINK_TAGS[proxy.callerLink];
    const item = h(
      "button",
      {
        type: "button",
        class: "menu-item",
        role: "menuitem",
        title: `${proxy.name}, ${proxyState(proxy).text.toLowerCase()}`,
        onclick: onPick,
      },
      h("span", { class: proxyDotClass(proxy) }),
      h("span", { class: "picker-name" }, proxy.name),
      port !== "" && h("span", { class: "picker-port" }, port),
      tag !== null && h("span", { class: "tag" }, tag),
      trailing,
    );
    return item;
  };

  const renderListPage = () => {
    const items = listed();
    const selectedId = proxies.selected.get();
    const rows = items.map((proxy) => {
      const remove = h(
        "button",
        {
          type: "button",
          class: "menu-x",
          title: `Remove ${proxy.name}`,
          "aria-label": `Remove ${proxy.name}`,
        },
        icon(X_ICON),
      ) as HTMLButtonElement;
      remove.disabled = busy;
      remove.addEventListener("click", () => void removeProxy(proxy));
      return h(
        "div",
        { class: "menu-row" },
        proxyItem(
          proxy,
          () => {
            proxies.select(proxy.id);
            closeMenu(true);
          },
          proxy.id === selectedId ? icon(CHECK_ICON, "check") : null,
        ),
        remove,
      );
    });
    menu.replaceChildren(
      h("div", { class: "menu-heading" }, hasChat() ? "Connected to this chat" : "Proxies"),
      ...rows,
      h("div", { class: "menu-sep" }),
      h(
        "button",
        {
          type: "button",
          class: "menu-action",
          role: "menuitem",
          onclick: () => openMenu("connect"),
        },
        icon(PLUS_ICON),
        hasChat() ? "Connect or create proxy" : "New proxy",
      ),
    );
  };

  const renderConnectPage = () => {
    const others = hasChat() ? live().filter((proxy) => proxy.callerLink === null) : [];
    const back =
      listed().length > 0 &&
      h(
        "button",
        {
          type: "button",
          class: "menu-action",
          role: "menuitem",
          onclick: () => openMenu("list"),
        },
        icon(BACK_ICON),
        "Back",
      );
    const create = h(
      "button",
      { type: "button", class: "menu-action", role: "menuitem", onclick: () => void createProxy() },
      icon(PLUS_ICON),
      "New proxy",
    ) as HTMLButtonElement;
    create.disabled = busy;
    fill(
      menu,
      ...(back === false ? [] : [back, h("div", { class: "menu-sep" })]),
      create,
      ...(hasChat()
        ? [
            h("div", { class: "menu-sep" }),
            h("div", { class: "menu-heading" }, "Connect an existing proxy"),
            others.length === 0
              ? h("div", { class: "menu-empty" }, "Every proxy is already connected.")
              : null,
            ...others.map((proxy) => {
              const item = proxyItem(proxy, () => void connectProxy(proxy), null);
              (item as HTMLButtonElement).disabled = busy;
              return item;
            }),
          ]
        : []),
    );
  };

  const renderMenu = () => {
    menu.hidden = menuPage === null;
    trigger.setAttribute("aria-expanded", String(menuPage !== null));
    if (menuPage === "list") renderListPage();
    else if (menuPage === "connect") renderConnectPage();
    else menu.replaceChildren();
  };

  const renderTrigger = () => {
    const ready = proxies.ready();
    loading.hidden = ready;
    const items = listed();
    const proxy = current();
    const empty = items.length === 0 && (proxy === undefined || proxy.deletedAt !== null);
    trigger.hidden = !ready || empty;
    connectButton.hidden = !ready || !empty;
    connectButton.disabled = busy;
    if (trigger.hidden) return;
    const port = proxy?.state === "running" && proxy.listen !== null ? `:${proxy.listen.port}` : "";
    fill(
      trigger,
      h("span", { class: "picker-label" }, "Proxy"),
      proxy === undefined ? null : h("span", { class: proxyDotClass(proxy) }),
      h("span", { class: "picker-name" }, proxy?.name ?? "Choose a proxy"),
      port !== "" && h("span", { class: "picker-port" }, port),
      icon(CARET_ICON, "picker-caret"),
    );
    trigger.title = proxy === undefined ? "Choose a proxy" : `Proxy: ${proxy.name}`;
  };

  const render = () => {
    renderTrigger();
    if (menuPage !== null) renderMenu();
    const proxy = current();
    const isLive = proxy !== undefined && proxy.deletedAt === null;
    const running = proxy?.state === "running";
    const recording = proxy?.recording ?? null;
    const state = proxies.ready() ? proxyState(proxy) : { text: "Connecting…", tone: "idle" };
    stateLabel.textContent = state.text;
    stateLabel.dataset.tone = state.tone;
    stateLabel.title =
      recording !== null ? `Recording since ${timeLabel(recording.startedAt)}` : state.text;

    const stopping = running || proxy?.state === "starting";
    const powerLabel = !isLive ? "No proxy selected" : stopping ? "Stop proxy" : "Start proxy";
    powerButton.title = powerLabel;
    powerButton.setAttribute("aria-label", powerLabel);
    powerButton.dataset.tone =
      !isLive || proxy.state === "stopped"
        ? "idle"
        : proxy.state === "running"
          ? "live"
          : proxy.state === "starting"
            ? "warn"
            : "fail";
    powerButton.disabled = busy || !isLive || proxy.state === "starting";

    const recordLabel = !isLive
      ? "No proxy selected"
      : recording !== null
        ? "Stop recording"
        : running
          ? "Start recording"
          : "Start the proxy to record";
    recordButton.title = recordLabel;
    recordButton.setAttribute("aria-pressed", String(recording !== null));
    recordButton.disabled = busy || !isLive || (!running && recording === null);

    const url = currentUrl();
    usage.hidden = url === null;
    if (url !== null) urlText.textContent = url;

    notices.set(
      "proxy-failed",
      "error",
      isLive && proxy.state === "failed"
        ? `${proxy.name} failed to start${proxy.stateDetail === undefined ? "." : `: ${proxy.stateDetail}`}`
        : null,
    );
    const dropped = recording?.droppedFlows ?? 0;
    notices.set(
      "dropped",
      "warn",
      dropped > 0
        ? `${dropped} flow${dropped === 1 ? " was" : "s were"} dropped: the storage budget is full or the recording reached its request limit. Delete old recordings or raise the limits in the plugin's settings.`
        : null,
    );
    notices.set(
      "blocked",
      "warn",
      proxies.storageBlocked()
        ? "Storage is blocked: another program is holding the inspector database open, so new flows are dropped until it closes."
        : null,
    );
  };

  const createProxy = async () => {
    closeMenu();
    const created = await run("create_proxy", {});
    if (isRecord(created) && typeof created.id === "string") {
      proxies.select(created.id);
      proxies.refresh();
      app.view.set("proxies");
    }
  };

  const connectProxy = async (proxy: ProxyView) => {
    closeMenu(true);
    const caller = proxies.caller();
    const target = caller?.threadId != null ? "thread" : "project";
    if ((await run("link_proxy", { proxyId: proxy.id, target })) !== undefined) {
      proxies.select(proxy.id);
      proxies.refresh();
    }
  };

  const removeProxy = async (proxy: ProxyView) => {
    closeMenu();
    const target = proxy.callerLink === null ? null : unlinkTarget(proxy.callerLink);
    const place =
      target === null || proxy.callerLink === null ? null : CALLER_LINK_LABELS[proxy.callerLink];
    const choice = await confirmRemoval(proxy, place);
    if (choice === "disconnect" && target !== null) {
      await run("unlink_proxy", { target, proxyId: proxy.id });
    } else if (choice === "delete") {
      if (
        proxy.recording !== null &&
        (await run("stop_recording", { proxyId: proxy.id })) === undefined
      )
        return;
      if (
        (proxy.state === "running" || proxy.state === "starting") &&
        (await run("stop_proxy", { proxyId: proxy.id })) === undefined
      )
        return;
      await run("delete_proxy", { proxyId: proxy.id });
    } else {
      return;
    }
    if (proxies.selected.get() === proxy.id) proxies.followDefault();
    else proxies.refresh();
  };

  powerButton.addEventListener("click", () => {
    const proxy = current();
    if (proxy === undefined) return;
    const stopping = proxy.state === "running" || proxy.state === "starting";
    void run(stopping ? "stop_proxy" : "start_proxy", { proxyId: proxy.id });
  });
  recordButton.addEventListener("click", () => {
    const proxy = current();
    if (proxy === undefined) return;
    void run(proxy.recording === null ? "start_recording" : "stop_recording", {
      proxyId: proxy.id,
    });
  });
  trigger.addEventListener("click", () => (menuPage === null ? openMenu("list") : closeMenu()));
  connectButton.addEventListener("click", () =>
    menuPage === null ? openMenu("connect") : closeMenu(),
  );
  const onPointerDown = (event: PointerEvent) => {
    if (menuPage !== null && !picker.contains(event.target as Node)) closeMenu();
  };
  document.addEventListener("pointerdown", onPointerDown);
  picker.addEventListener("keydown", (event) => {
    if (menuPage === null) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  });

  const offFeed = proxies.on(render);
  const offSelected = proxies.selected.subscribe(render);
  render();
  return () => {
    offFeed();
    offSelected();
    document.removeEventListener("pointerdown", onPointerDown);
  };
};
