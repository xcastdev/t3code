import type { PluginSubscriptionEvent } from "@t3tools/contracts";
import { connectT3, type PluginHostContext } from "@t3tools/plugin-sdk/ui";

import { mountNav, navStyles, type NavSlot, type ViewDefinition } from "./app/nav.ts";
import { createProxiesFeed } from "./app/proxies.ts";
import { createReplayModel } from "./app/replays.ts";
import {
  type App,
  type DecoderInput,
  type Emitter,
  createEmitter,
  createNotices,
  createPersistence,
  createSignal,
} from "./app/state.ts";
import { h, injectStyles } from "./dom.ts";
import * as decoder from "./views/decoder.ts";
import * as proxies from "./views/proxies.ts";
import * as proxyStrip from "./views/proxyStrip.ts";
import * as replayer from "./views/replayer.ts";
import * as requests from "./views/requests.ts";

/** Registered views, one per nav slot. Add a view here to show its slot. */
/** Shows the target view before emitting, so a lazily mounted listener exists to receive it. */
const switchingEmitter = <T>(show: () => void): Emitter<T> => {
  const inner = createEmitter<T>();
  return {
    emit: (value) => {
      show();
      inner.emit(value);
    },
    on: inner.on,
  };
};

const VIEWS: ReadonlyArray<ViewDefinition> = [
  requests.view,
  replayer.view,
  decoder.view,
  proxies.view,
];

const applyContext = (context: PluginHostContext) => {
  const root = document.documentElement;
  root.dataset.theme = context.theme;
  for (const [name, value] of Object.entries(context.styles.variables))
    root.style.setProperty(name, value);
};

/** Only a different chat or machine can change which proxy is the default. */
const contextKey = (context: PluginHostContext) =>
  JSON.stringify([context.chatTarget?.key ?? null, context.destination]);

const $ = (id: string) => document.getElementById(id) as HTMLElement;

/** Host API 1.1 added file saves, clipboard writes, and chat targets. */
const hasHostTools = (hostApi: string) => {
  const [major = 0, minor = 0] = hostApi.split(".").map(Number);
  return major > 1 || (major === 1 && minor >= 1);
};

const hostToolsStyles = `
:root[data-old-host] [data-host-tools] {
  display: none !important;
}
`;

void connectT3().then(async (client) => {
  applyContext(client.context);
  const feed = createProxiesFeed(client);
  let lastContextKey = contextKey(client.context);
  const offContext = client.onContextChange((context) => {
    applyContext(context);
    const key = contextKey(context);
    if (key === lastContextKey) return;
    lastContextKey = key;
    feed.contextChanged();
  });
  const stored = await client.state.get().catch(() => null);

  const notices = createNotices($("notices"));
  if (!hasHostTools(client.hostApi)) {
    document.documentElement.dataset.oldHost = "";
    notices.set("host", "warn", "Update T3 Code to copy, download, or link chats.");
  }
  const persistence = createPersistence(client, stored?.value);
  const app: App = {
    client,
    view: createSignal<NavSlot>("requests"),
    notices,
    persistence,
    selection: createSignal<string | null>(null),
    requestUpdated: createEmitter<string>(),
    proxies: feed.feed,
    replays: createReplayModel(client, persistence),
    checked: createSignal<ReadonlySet<string>>(new Set()),
    sendToReplayer: createEmitter<string>(),
    sendToDecoder: switchingEmitter<DecoderInput>(() => app.view.set("decoder")),
  };
  // The Replayer mounts lazily, so its tab model (created eagerly) takes the request here.
  app.sendToReplayer.on((requestId) => {
    app.replays.tabs.open(requestId);
    app.view.set("replayer");
  });

  const onProxies = (event: PluginSubscriptionEvent) => {
    feed.handleEvent(event);
    if (event.type === "snapshot" || event.type === "batch") {
      notices.set("status", "warn", null);
    } else if (event.type === "closed") {
      notices.set(
        "status",
        "warn",
        event.reason === "plugin-disabled"
          ? "The inspector was disabled. Enable it in Settings → Plugins."
          : `Status updates stopped (${event.reason}). Check the plugin in Settings → Plugins, then reopen the panel.`,
      );
    }
    app.replays.handleEvent(event);
  };

  for (const css of new Set([
    navStyles,
    hostToolsStyles,
    proxyStrip.styles,
    ...VIEWS.flatMap((view) => view.styles),
  ])) {
    injectStyles(css);
  }
  const header = h("header", { class: "appbar" });
  document.body.insertBefore(header, $("nav"));
  const disposeStrip = proxyStrip.mount(header, app);
  const closeProxies = client.subscribe("proxies", {}, onProxies);
  feed.start();
  const disposeViews = mountNav($("nav"), $("views"), VIEWS, app);
  window.addEventListener(
    "pagehide",
    () => {
      disposeViews();
      disposeStrip();
      closeProxies();
      offContext();
      feed.dispose();
    },
    { once: true },
  );
});
