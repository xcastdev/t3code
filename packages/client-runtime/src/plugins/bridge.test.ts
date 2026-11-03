import {
  PLUGIN_LIMITS,
  PluginManifest,
  PluginRequestError,
  type PluginSubscriptionEvent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  makePluginBridge,
  type PluginAttachRequest,
  type PluginBridgeOptions,
  type PluginHostContext,
} from "./bridge.ts";

const baseManifest = {
  manifestVersion: 1,
  id: "echo",
  name: "Echo",
  version: "1.0.0",
  hostApi: "1.0",
  author: "T3",
  ui: {
    panels: [{ id: "main", title: "Echo", entry: "ui/main.html" }],
    commands: [{ id: "open", title: "Open Echo", opens: { panel: "main" } }],
  },
  backend: {
    entry: "backend/index.cjs",
    operations: [
      {
        name: "ping",
        title: "Ping",
        description: "Answers pong.",
        inputSchema: { type: "object" },
        mutates: false,
        agent: true,
      },
    ],
    topics: [{ name: "ticks" }],
    resources: [],
    prerequisites: [],
  },
  capabilities: ["chat.attach"],
};

const decodeManifest = Schema.decodeUnknownSync(PluginManifest);

const context = (theme: "light" | "dark" = "dark"): PluginHostContext => ({
  apiVersion: "1.0",
  theme,
  styles: { variables: { "--background": theme === "dark" ? "#000" : "#fff" } },
  containerDimensions: { width: 400, height: 600 },
  platform: "web",
  destination: { kind: "environment", environmentId: "env-1", label: "Laptop" },
  chatTarget: { key: "thread-1", title: "Thread one" },
});

interface FakeSubscription {
  readonly topic: string;
  readonly params: unknown;
  readonly onEvent: (event: PluginSubscriptionEvent) => void;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
}

function setup(
  options: {
    readonly manifest?: Record<string, unknown>;
    readonly overrides?: Partial<PluginBridgeOptions>;
  } = {},
) {
  const sent: Array<Record<string, unknown>> = [];
  const waiters = new Map<string, (message: Record<string, unknown>) => void>();
  let theme: "light" | "dark" = "dark";
  let stored: { readonly value: unknown; readonly version: string } | null = null;
  const subscriptions: Array<FakeSubscription> = [];
  const attach = vi.fn(
    async (_request: PluginAttachRequest, _activated: boolean) => "inserted" as const,
  );

  const bridge = makePluginBridge({
    manifest: decodeManifest(options.manifest ?? baseManifest),
    panelId: "main",
    pluginVersion: "1.0.0",
    post: (message) => {
      const record = message as Record<string, unknown>;
      sent.push(record);
      const waiter = waiters.get(String(record.id));
      if (waiter !== undefined) {
        waiters.delete(String(record.id));
        waiter(record);
      }
    },
    hostContext: () => context(theme),
    state: {
      get: async () => stored,
      set: async (value) => {
        stored = { value, version: "1.0.0" };
      },
    },
    backend: {
      call: async (operation, input) => ({ operation, input }),
      subscribe: (topic, params, onEvent) => {
        const unsubscribe = vi.fn();
        subscriptions.push({ topic, params, onEvent, unsubscribe });
        return unsubscribe;
      },
    },
    openSurface: async () => undefined,
    attach,
    ...options.overrides,
  });

  let nextId = 0;
  const request = (method: string, params?: unknown, activated = false) => {
    const id = `r${nextId++}`;
    const response = new Promise<Record<string, unknown>>((resolve) => {
      const existing = sent.find((message) => message.id === id);
      if (existing === undefined) waiters.set(id, resolve);
      else resolve(existing);
    });
    bridge.receive({ jsonrpc: "2.0", id, method, params }, activated);
    return response;
  };
  const initialize = () => request("t3/initialize", { apiVersion: "1.0" });
  const notifications = (method: string) =>
    sent.filter((message) => message.method === method && message.id === undefined);

  return {
    bridge,
    sent,
    attach,
    subscriptions,
    request,
    initialize,
    notifications,
    setTheme: (next: "light" | "dark") => {
      theme = next;
    },
    setStored: (next: typeof stored) => {
      stored = next;
    },
  };
}

const errorOf = (response: Record<string, unknown>) =>
  response.error as { code: number; message: string; data?: { reason?: string } };

describe("makePluginBridge", () => {
  it("refuses requests before t3/initialize", async () => {
    const { request } = setup();
    const response = await request("t3/state.get");
    expect(errorOf(response).code).toBe(-32002);
  });

  it("initialize negotiates apiVersion 1.0 and returns host context", async () => {
    const { request, bridge, notifications, setTheme } = setup();
    const refused = await request("t3/initialize", { apiVersion: "2.0" });
    expect(errorOf(refused).data?.reason).toBe("incompatible-host-api");

    const response = await request("t3/initialize", { apiVersion: "1.0" });
    expect(response.result).toEqual({
      apiVersion: "1.0",
      pluginId: "echo",
      panelId: "main",
      pluginVersion: "1.0.0",
      hostContext: context("dark"),
    });

    bridge.updateHostContext();
    expect(notifications("t3/hostContext.changed")).toHaveLength(0);
    setTheme("light");
    bridge.updateHostContext();
    expect(notifications("t3/hostContext.changed").map((message) => message.params)).toEqual([
      { hostContext: context("light") },
    ]);
  });

  it("rejects app messages over maxMessageBytes and a 17th pending request", async () => {
    const calls: Array<(value: unknown) => void> = [];
    const { request, initialize } = setup({
      overrides: {
        backend: {
          call: () => new Promise((resolve) => calls.push(resolve)),
          subscribe: () => () => undefined,
        },
      },
    });
    await initialize();

    const huge = await request("t3/backend.call", {
      operation: "ping",
      input: { text: "x".repeat(PLUGIN_LIMITS.maxMessageBytes) },
    });
    expect(errorOf(huge).code).toBe(-32600);
    expect(calls).toHaveLength(0);

    const pending = Array.from({ length: PLUGIN_LIMITS.maxPendingRequests }, () =>
      request("t3/backend.call", { operation: "ping", input: {} }),
    );
    const overflow = await request("t3/backend.call", { operation: "ping", input: {} });
    expect(errorOf(overflow).message).toBe("Too many requests in flight.");
    expect(calls).toHaveLength(PLUGIN_LIMITS.maxPendingRequests);

    for (const resolve of calls) resolve("pong");
    expect((await Promise.all(pending)).map((response) => response.result)).toEqual(
      Array.from({ length: PLUGIN_LIMITS.maxPendingRequests }, () => "pong"),
    );
  });

  it("a backend.call result whose response would exceed maxMessageBytes is replaced by a too-large error", async () => {
    const { request, initialize } = setup({
      overrides: {
        backend: {
          call: async () => ({ text: "x".repeat(PLUGIN_LIMITS.maxMessageBytes) }),
          subscribe: () => () => undefined,
        },
      },
    });
    await initialize();
    const response = await request("t3/backend.call", { operation: "ping", input: {} });
    expect(response.result).toBeUndefined();
    expect(errorOf(response).data?.reason).toBe("too-large");
  });

  it("backend.call is refused when the manifest has no backend", async () => {
    const { backend: _backend, ...clientOnly } = baseManifest;
    const { request, initialize } = setup({ manifest: clientOnly });
    await initialize();
    const response = await request("t3/backend.call", { operation: "ping", input: {} });
    expect(errorOf(response).data?.reason).toBe("unknown-operation");
  });

  it("refuses an operation not declared in the manifest, and passes plugin errors through", async () => {
    const { request, initialize } = setup({
      overrides: {
        backend: {
          call: async () => Promise.reject(new PluginRequestError({ reason: "version-changed" })),
          subscribe: () => () => undefined,
        },
      },
    });
    await initialize();
    const undeclared = await request("t3/backend.call", { operation: "pong", input: {} });
    expect(errorOf(undeclared).data?.reason).toBe("unknown-operation");

    const failed = await request("t3/backend.call", { operation: "ping", input: {} });
    expect(errorOf(failed)).toEqual({
      code: -32000,
      message: "This plugin was updated. Reload the panel.",
      data: { reason: "version-changed" },
    });
  });

  it("state.set rejects values whose JSON exceeds maxPayloadBytes", async () => {
    const { request, initialize } = setup();
    await initialize();
    const response = await request("t3/state.set", {
      value: "x".repeat(PLUGIN_LIMITS.maxPayloadBytes),
    });
    expect(errorOf(response).data?.reason).toBe("too-large");

    for (const value of [new ArrayBuffer(20 * 1024 * 1024), new Map([["a", 1]]), new Set([1])]) {
      const cloned = await request("t3/state.set", { value });
      expect(errorOf(cloned).code).toBe(-32600);
    }
    expect((await request("t3/state.get")).result).toBeNull();
  });

  it("a host callback that throws synchronously answers with an error and frees its slot", async () => {
    const { request, initialize, notifications, bridge } = setup({
      overrides: {
        backend: {
          call: () => {
            throw new Error("adapter exploded");
          },
          subscribe: () => {
            throw new Error("adapter exploded");
          },
        },
      },
    });
    await initialize();
    for (let call = 0; call <= PLUGIN_LIMITS.maxPendingRequests; call += 1) {
      const response = await request("t3/backend.call", { operation: "ping", input: {} });
      expect(errorOf(response).message).toBe("adapter exploded");
    }

    const subscribed = await request("t3/backend.subscribe", { topic: "ticks", params: {} });
    expect(errorOf(subscribed).message).toBe("adapter exploded");
    bridge.hostReconnected();
    expect(notifications("t3/backend.event")).toHaveLength(0);
  });

  it("state.get returns the stored value with the version that wrote it", async () => {
    const { request, initialize, setStored } = setup();
    await initialize();
    setStored({ value: { tab: "requests" }, version: "0.9.0" });
    expect((await request("t3/state.get")).result).toEqual({
      value: { tab: "requests" },
      version: "0.9.0",
    });

    expect((await request("t3/state.set", { value: { tab: "replay" } })).result).toEqual({});
    expect((await request("t3/state.get")).result).toEqual({
      value: { tab: "replay" },
      version: "1.0.0",
    });
  });

  it("backend.event forwards snapshot revision and cursor unchanged", async () => {
    const { request, initialize, subscriptions, notifications } = setup();
    await initialize();
    const undeclared = await request("t3/backend.subscribe", { topic: "other", params: {} });
    expect(errorOf(undeclared).data?.reason).toBe("unknown-operation");

    const response = await request("t3/backend.subscribe", {
      topic: "ticks",
      params: { every: 1 },
    });
    const { subscriptionId } = response.result as { subscriptionId: string };
    expect(subscriptions.map(({ topic, params }) => ({ topic, params }))).toEqual([
      { topic: "ticks", params: { every: 1 } },
    ]);

    const snapshot: PluginSubscriptionEvent = {
      type: "snapshot",
      items: [{ n: 1 }],
      revision: "r-7",
      cursor: "c-3",
    };
    subscriptions[0]!.onEvent(snapshot);
    expect(notifications("t3/backend.event").map((message) => message.params)).toEqual([
      { subscriptionId, event: snapshot },
    ]);

    await request("t3/backend.unsubscribe", { subscriptionId });
    expect(subscriptions[0]!.unsubscribe).toHaveBeenCalledOnce();
    subscriptions[0]!.onEvent({ type: "batch", items: [], revision: "r-8" });
    expect(notifications("t3/backend.event")).toHaveLength(1);
  });

  it("chat.attach without user activation is refused", async () => {
    const { request, initialize, attach } = setup();
    await initialize();
    const attachment = { kind: "text", text: "hello", expectedChatTargetKey: "thread-1" };

    const refused = await request("t3/chat.attach", attachment, false);
    expect(errorOf(refused).code).toBe(-32000);
    expect(attach).not.toHaveBeenCalled();

    const accepted = await request("t3/chat.attach", attachment, true);
    expect(accepted.result).toEqual({ outcome: "inserted" });
    expect(attach).toHaveBeenCalledWith(attachment, true);
  });

  it("chat.attach reference is refused unless the manifest declares chat.reference", async () => {
    const reference = {
      kind: "reference",
      label: "GET /api",
      locator: { requestId: "42" },
      snapshot: "GET /api 200",
      expectedChatTargetKey: null,
    };
    const withoutReference = setup();
    await withoutReference.initialize();
    const refused = await withoutReference.request("t3/chat.attach", reference, true);
    expect(errorOf(refused).data?.reason).toBe("capability-denied");
    expect(withoutReference.attach).not.toHaveBeenCalled();

    const withReference = setup({
      manifest: { ...baseManifest, capabilities: ["chat.attach", "chat.reference"] },
    });
    await withReference.initialize();
    const accepted = await withReference.request("t3/chat.attach", reference, true);
    expect(accepted.result).toEqual({ outcome: "inserted" });

    for (const invalid of [
      { ...reference, label: "x".repeat(201) },
      { ...reference, locator: { " ": "42" } },
    ]) {
      const response = await withReference.request("t3/chat.attach", invalid, true);
      expect(errorOf(response).code).toBe(-32602);
    }
    expect(withReference.attach).toHaveBeenCalledOnce();
  });

  it("a closed event and dispose each cancel the host subscription once", async () => {
    const { request, initialize, subscriptions, bridge, sent, notifications } = setup();
    await initialize();
    await request("t3/backend.subscribe", { topic: "ticks", params: {} });
    await request("t3/backend.subscribe", { topic: "ticks", params: { fast: true } });

    subscriptions[0]!.onEvent({ type: "closed", reason: "worker-failed" });
    expect(subscriptions[0]!.unsubscribe).toHaveBeenCalledOnce();
    expect(notifications("t3/backend.event")).toHaveLength(1);

    bridge.dispose();
    expect(subscriptions.map((subscription) => subscription.unsubscribe.mock.calls.length)).toEqual(
      [1, 1],
    );
    const before = sent.length;
    subscriptions[0]!.onEvent({ type: "resync" });
    expect(sent).toHaveLength(before);
  });

  it("hostReconnected re-subscribes live subscriptions and forwards a resync event first", async () => {
    const { request, initialize, subscriptions, bridge, notifications } = setup();
    await initialize();
    const response = await request("t3/backend.subscribe", { topic: "ticks", params: { a: 1 } });
    const { subscriptionId } = response.result as { subscriptionId: string };

    bridge.hostReconnected();
    expect(notifications("t3/backend.event").map((message) => message.params)).toEqual([
      { subscriptionId, event: { type: "resync" } },
    ]);
    expect(subscriptions[0]!.unsubscribe).toHaveBeenCalledOnce();
    expect(subscriptions.map(({ topic, params }) => ({ topic, params }))).toEqual([
      { topic: "ticks", params: { a: 1 } },
      { topic: "ticks", params: { a: 1 } },
    ]);

    subscriptions[0]!.onEvent({ type: "batch", items: [1], revision: "stale" });
    const fresh: PluginSubscriptionEvent = {
      type: "snapshot",
      items: [],
      revision: "r-1",
      cursor: null,
    };
    subscriptions[1]!.onEvent(fresh);
    expect(notifications("t3/backend.event").map((message) => message.params)).toEqual([
      { subscriptionId, event: { type: "resync" } },
      { subscriptionId, event: fresh },
    ]);
  });
});
