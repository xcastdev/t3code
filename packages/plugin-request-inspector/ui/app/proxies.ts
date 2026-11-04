// @effect-diagnostics globalTimers:off - Runs inside a sandboxed plugin frame, outside any Effect runtime.
import type { PluginSubscriptionEvent } from "@t3tools/contracts";
import type { T3PluginClient } from "@t3tools/plugin-sdk/ui";

import {
  isNoDefaultProxyDetail,
  PROXY_DETAILS,
  RECORDING_DETAILS,
} from "../../backend/refusals.ts";
import { isRecord, messageOf } from "../dom.ts";
import {
  type Caller,
  type CallerLink,
  createEmitter,
  createSignal,
  explainCallFailure,
  type ProxiesFeed,
  type ProxyView,
} from "./state.ts";

const isProxyView = (value: unknown): value is ProxyView =>
  isRecord(value) && value.kind === "proxy" && typeof value.id === "string";

const linksKey = (proxy: ProxyView) =>
  proxy.links.map((link) => `${link.kind}:${link.id}`).join(",");

/** Live proxies in id order, then deleted ones, newest deletion first. */
const ordered = (proxies: Iterable<ProxyView>) =>
  [...proxies].sort((a, b) =>
    a.deletedAt === null && b.deletedAt === null
      ? Number(a.id) - Number(b.id)
      : a.deletedAt === null
        ? -1
        : b.deletedAt === null
          ? 1
          : b.deletedAt - a.deletedAt,
  );

/**
 * Holds every proxy from the `proxies` topic plus the caller facts only `list_proxies` knows
 * (subscriptions carry no caller context). The selection follows the chat's default proxy
 * until the user picks one, and starts following again when the chat changes.
 */
export const createProxiesFeed = (client: T3PluginClient) => {
  const proxies = new Map<string, ProxyView>();
  let callerLinks = new Map<string, CallerLink | null>();
  let caller: Caller | null = null;
  let defaultProxyId: string | null = null;
  let storageBlocked = false;
  let snapshotSeen = false;
  let listed = false;
  let followsDefault = true;
  let listGeneration = 0;
  let listTimer: ReturnType<typeof setTimeout> | undefined;
  const selected = createSignal<string | null>(null);
  const changed = createEmitter<void>();

  const withCallerLink = (proxy: ProxyView): ProxyView => {
    const link = callerLinks.get(proxy.id) ?? null;
    return link === proxy.callerLink ? proxy : { ...proxy, callerLink: link };
  };

  const ready = () => snapshotSeen && listed;

  const applyDefault = () => {
    if (!ready()) return;
    const current = selected.get();
    const currentProxy = current === null ? undefined : proxies.get(current);
    if (!followsDefault && (current === null || currentProxy !== undefined)) return;
    followsDefault = true;
    const live = ordered(proxies.values()).filter((proxy) => proxy.deletedAt === null);
    const inChat = caller !== null && (caller.threadId !== null || caller.projectId !== null);
    // Beside a chat the bar only offers its connected proxies, so it never falls back to others.
    const keep =
      currentProxy !== undefined &&
      currentProxy.deletedAt === null &&
      (!inChat || (callerLinks.get(currentProxy.id) ?? null) !== null)
        ? current
        : null;
    selected.set(
      defaultProxyId !== null && proxies.has(defaultProxyId)
        ? defaultProxyId
        : (keep ?? (inChat ? null : (live[0]?.id ?? null))),
    );
  };

  const readList = async () => {
    listGeneration += 1;
    const generation = listGeneration;
    try {
      const result = await client.call("list_proxies", {});
      if (generation !== listGeneration || !isRecord(result)) return;
      const next = new Map<string, CallerLink | null>();
      if (Array.isArray(result.proxies)) {
        for (const proxy of result.proxies)
          if (isProxyView(proxy)) next.set(proxy.id, proxy.callerLink);
      }
      callerLinks = next;
      caller = isRecord(result.caller) ? (result.caller as unknown as Caller) : null;
      defaultProxyId = typeof result.defaultProxyId === "string" ? result.defaultProxyId : null;
    } catch {
      // Without the caller facts the strip still lists every proxy; it just shows no links.
      if (generation !== listGeneration) return;
    }
    listed = true;
    applyDefault();
    changed.emit();
  };

  const refresh = () => {
    clearTimeout(listTimer);
    listTimer = setTimeout(() => void readList(), 120);
  };

  const handleEvent = (event: PluginSubscriptionEvent) => {
    if (event.type !== "snapshot" && event.type !== "batch") return;
    let structural = event.type === "snapshot";
    if (event.type === "snapshot") proxies.clear();
    for (const item of event.items) {
      if (isProxyView(item)) {
        const previous = proxies.get(item.id);
        if (
          previous === undefined ||
          previous.deletedAt !== item.deletedAt ||
          linksKey(previous) !== linksKey(item)
        ) {
          structural = true;
        }
        proxies.set(item.id, item);
      } else if (isRecord(item) && item.kind === "status") {
        storageBlocked = item.storageBlocked === true;
      }
    }
    if (event.type === "snapshot") snapshotSeen = true;
    if (structural && snapshotSeen) refresh();
    applyDefault();
    changed.emit();
  };

  const feed: ProxiesFeed = {
    ready,
    list: () => ordered(proxies.values()).map(withCallerLink),
    get: (id) => {
      const proxy = proxies.get(id);
      return proxy === undefined ? undefined : withCallerLink(proxy);
    },
    storageBlocked: () => storageBlocked,
    caller: () => caller,
    defaultProxyId: () => defaultProxyId,
    selected,
    select: (id) => {
      followsDefault = false;
      selected.set(id);
    },
    followDefault: () => {
      followsDefault = true;
      refresh();
    },
    refresh,
    on: changed.on,
  };

  return {
    feed,
    handleEvent,
    /** The chat changed, so its default proxy may differ: follow it again. */
    contextChanged: () => {
      followsDefault = true;
      refresh();
    },
    start: () => void readList(),
    dispose: () => clearTimeout(listTimer),
  };
};

/** Refusals written for agents name their tools; the panel says what to click instead. */
export const proxyFailureText = (error: unknown) => {
  const detail = messageOf(error);
  switch (detail) {
    case PROXY_DETAILS.running:
      return "Stop this proxy before deleting it.";
    case PROXY_DETAILS.notRunning:
      return "Start the proxy before you start recording.";
    case PROXY_DETAILS.limit:
      return "8 proxies are already running. Stop one first.";
    case PROXY_DETAILS.tooMany:
      return "32 proxies exist. Delete one before creating another.";
    case PROXY_DETAILS.recordingOpen:
    case RECORDING_DETAILS.open:
      return "Stop the recording before deleting it.";
    case PROXY_DETAILS.noCallerThread:
      return "This panel is not open beside a chat, so there is no chat to link.";
    case PROXY_DETAILS.noCallerProject:
      return "This panel is not open beside a project, so there is no project to link.";
    default:
      return isNoDefaultProxyDetail(detail) ? "Pick a proxy first." : explainCallFailure(error);
  }
};

/** The address a client on the environment machine dials for a proxy listening on `host`. */
const dialHost = (host: string) => {
  if (host === "" || host === "0.0.0.0") return "127.0.0.1";
  if (host === "::" || host === "[::]") return "[::1]";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
};

export const proxyUrlOf = (proxy: ProxyView) =>
  proxy.listen === null
    ? null
    : `${proxy.mode.kind === "socks5" ? "socks5" : "http"}://${dialHost(proxy.listen.host)}:${proxy.listen.port}`;

export const proxyEnvText = (url: string) =>
  ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"].map((name) => `export ${name}=${url}`).join("\n");

export const CALLER_LINK_LABELS: Record<CallerLink, string> = {
  thread: "this chat",
  project: "this project",
  parentThread: "parent chat",
  rootThread: "root chat",
};

/** Where the plugin's backend runs: certificate and NSS actions happen on that machine. */
export const destinationLabel = (client: T3PluginClient) =>
  client.context.destination.kind === "environment"
    ? client.context.destination.label
    : "this machine";
