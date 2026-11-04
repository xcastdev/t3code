import {
  PLUGIN_HOST_API,
  PLUGIN_LIMITS,
  PluginManifest,
  ProjectId,
  ThreadId,
  PluginRequestError,
  type PluginSubscriptionEvent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  makePluginBridge,
  selectPluginChatTargets,
  type PluginAttachRequest,
  type PluginBridgeOptions,
  type PluginHostContext,
  type PluginSaveFile,
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
  apiVersion: `${PLUGIN_HOST_API.major}.${PLUGIN_HOST_API.minor}`,
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
  const saveFile = vi.fn(async (_file: PluginSaveFile) => "saved" as const);
  const writeClipboard = vi.fn(async (_text: string) => undefined);

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
    hostContext: () => {
      const { apiVersion: _apiVersion, ...rest } = context(theme);
      return rest;
    },
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
    saveFile,
    writeClipboard,
    chatTargets: () => ({ threads: [], projects: [] }),
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
    saveFile,
    writeClipboard,
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

  it("initialize accepts a 1.0 panel and reports the host's apiVersion and context", async () => {
    const { request, bridge, notifications, setTheme } = setup();
    const refused = await request("t3/initialize", { apiVersion: "2.0" });
    expect(errorOf(refused).data?.reason).toBe("incompatible-host-api");

    const response = await request("t3/initialize", { apiVersion: "1.0" });
    expect(response.result).toEqual({
      apiVersion: `${PLUGIN_HOST_API.major}.${PLUGIN_HOST_API.minor}`,
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

  it.each([
    {
      name: "file.save.begin without the capability",
      capabilities: ["chat.attach"],
      method: "t3/file.save.begin",
      params: { name: "a.har", mimeType: "application/json", size: 2 },
      activated: true,
      reason: "capability-denied",
    },
    {
      name: "file.save.begin without activation",
      capabilities: ["file.save"],
      method: "t3/file.save.begin",
      params: { name: "a.har", mimeType: "application/json", size: 2 },
      activated: false,
      message: "Saving a file must follow a click or key press in the panel.",
    },
    {
      name: "file.save.begin over maxSaveBytes",
      capabilities: ["file.save"],
      method: "t3/file.save.begin",
      params: { name: "a.har", mimeType: "application/json", size: PLUGIN_LIMITS.maxSaveBytes + 1 },
      activated: true,
      reason: "too-large",
    },
    {
      name: "clipboard.write without the capability",
      capabilities: ["file.save"],
      method: "t3/clipboard.write",
      params: { text: "hi" },
      activated: true,
      reason: "capability-denied",
    },
    {
      name: "clipboard.write without activation",
      capabilities: ["clipboard.write"],
      method: "t3/clipboard.write",
      params: { text: "hi" },
      activated: false,
      message: "Copying must follow a click or key press in the panel.",
    },
    {
      name: "clipboard.write over maxPayloadBytes",
      capabilities: ["clipboard.write"],
      method: "t3/clipboard.write",
      params: { text: "é".repeat(PLUGIN_LIMITS.maxPayloadBytes / 2 + 1) },
      activated: true,
      reason: "too-large",
    },
  ])("refuses $name", async ({ capabilities, method, params, activated, reason, message }) => {
    const { request, initialize, saveFile, writeClipboard } = setup({
      manifest: { ...baseManifest, capabilities },
    });
    await initialize();
    const error = errorOf(await request(method, params, activated));
    if (reason !== undefined) expect(error.data?.reason).toBe(reason);
    if (message !== undefined) expect(error.message).toBe(message);
    expect(saveFile).not.toHaveBeenCalled();
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it("file.save joins appended chunks, refuses overruns and short commits, and frees on abort", async () => {
    const { request, initialize, saveFile } = setup({
      manifest: { ...baseManifest, capabilities: ["file.save"] },
    });
    await initialize();
    const begin = async (size: number | undefined, name = "../exports/a.har") => {
      const response = await request(
        "t3/file.save.begin",
        { name, mimeType: "application/json", ...(size === undefined ? {} : { size }) },
        true,
      );
      return (response.result as { saveId: string }).saveId;
    };
    const append = (saveId: string, text: string) =>
      request("t3/file.save.append", { saveId, base64: btoa(text) });

    const overrun = await begin(3);
    expect(
      errorOf(await request("t3/file.save.begin", { name: "b", mimeType: "", size: 1 }, true))
        .message,
    ).toBe("Another save is still in progress.");
    expect((await append(overrun, "ab")).result).toEqual({});
    expect(errorOf(await append(overrun, "cd")).code).toBe(-32602);
    expect(errorOf(await request("t3/file.save.commit", { saveId: overrun })).code).toBe(-32602);

    const short = await begin(3);
    await append(short, "ab");
    expect(errorOf(await request("t3/file.save.commit", { saveId: short })).message).toBe(
      "The file is 2 bytes, not 3.",
    );

    const aborted = await begin(3);
    await append(aborted, "ab");
    expect((await request("t3/file.save.abort", { saveId: aborted })).result).toEqual({});
    expect(errorOf(await append(aborted, "c")).code).toBe(-32602);
    expect(saveFile).not.toHaveBeenCalled();

    const saved = await begin(5);
    await append(saved, "he");
    await append(saved, "llo");
    expect((await request("t3/file.save.commit", { saveId: saved })).result).toEqual({
      outcome: "saved",
    });
    expect(saveFile).toHaveBeenCalledOnce();
    const file = saveFile.mock.calls[0]![0];
    expect({ name: file.name, mimeType: file.mimeType }).toEqual({
      name: "a.har",
      mimeType: "application/json",
    });
    expect(new TextDecoder().decode(new Uint8Array(file.parts.flatMap((part) => [...part])))).toBe(
      "hello",
    );

    const unsized = await begin(undefined);
    await append(unsized, "hi");
    expect((await request("t3/file.save.commit", { saveId: unsized })).result).toEqual({
      outcome: "saved",
    });

    const tooLarge = await begin(undefined);
    const fullChunk = btoa("x".repeat(PLUGIN_LIMITS.maxBodyChunkBytes));
    const chunks = PLUGIN_LIMITS.maxSaveBytes / PLUGIN_LIMITS.maxBodyChunkBytes;
    for (let index = 0; index < chunks; index += 1) {
      await request("t3/file.save.append", { saveId: tooLarge, base64: fullChunk });
    }
    expect(errorOf(await append(tooLarge, "x")).data?.reason).toBe("too-large");
    expect(errorOf(await request("t3/file.save.commit", { saveId: tooLarge })).code).toBe(-32602);
    expect(saveFile).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["../exports/a.har", "a.har"],
    ["C:\\Users\\me\\a.har", "a.har"],
    ["..", "download"],
    ["a\u0000b.txt", "a_b.txt"],
    ["invoice\u202Erah.exe", "invoice_rah.exe"],
    ["a\u2066b\u2069\u200e\u200f.txt", "a_b___.txt"],
    [`${"a".repeat(250)}.har`, `${"a".repeat(196)}.har`],
    [`${"é".repeat(120)}.har`, `${"é".repeat(98)}.har`],
    ["a".repeat(250), "a".repeat(200)],
  ])("file.save names %j as %j", async (name, expected) => {
    const { request, initialize, saveFile } = setup({
      manifest: { ...baseManifest, capabilities: ["file.save"] },
    });
    await initialize();
    const begun = await request("t3/file.save.begin", { name, mimeType: "" }, true);
    const saveId = (begun.result as { saveId: string }).saveId;
    await request("t3/file.save.commit", { saveId });
    expect(saveFile.mock.calls[0]![0].name).toBe(expected);
  });

  it("clipboard.write passes the text to the host", async () => {
    const { request, initialize, writeClipboard } = setup({
      manifest: { ...baseManifest, capabilities: ["clipboard.write"] },
    });
    await initialize();
    expect((await request("t3/clipboard.write", { text: "Cookie: a=1" }, true)).result).toEqual({});
    expect(writeClipboard).toHaveBeenCalledWith("Cookie: a=1");
  });

  it("chat.targets.list passes the query and caps each list at maxChatTargets", async () => {
    const queries: Array<string> = [];
    const many = PLUGIN_LIMITS.maxChatTargets + 10;
    const { request, initialize } = setup({
      overrides: {
        chatTargets: async (query) => {
          queries.push(query);
          return {
            threads: Array.from({ length: many }, (_, index) => ({
              threadId: ThreadId.make(`t${index}`),
              title: `Thread ${index}`,
              projectId: ProjectId.make("p"),
              projectName: "Project",
            })),
            projects: Array.from({ length: many }, (_, index) => ({
              projectId: ProjectId.make(`p${index}`),
              name: `Project ${index}`,
            })),
          };
        },
      },
    });
    await initialize();
    const listed = (await request("t3/chat.targets.list", { query: "api" })).result as {
      threads: ReadonlyArray<unknown>;
      projects: ReadonlyArray<unknown>;
    };
    expect([listed.threads.length, listed.projects.length]).toEqual([
      PLUGIN_LIMITS.maxChatTargets,
      PLUGIN_LIMITS.maxChatTargets,
    ]);
    await request("t3/chat.targets.list");
    expect(queries).toEqual(["api", ""]);
    const tooLong = await request("t3/chat.targets.list", { query: "x".repeat(257) });
    expect(errorOf(tooLong).code).toBe(-32602);
  });
});

describe("selectPluginChatTargets", () => {
  it("keeps one environment's live threads and unarchived projects, newest first, matching the query", () => {
    const thread = (id: string, title: string, updatedAt: string, extra: object = {}) => ({
      environmentId: "env-1",
      id: ThreadId.make(id),
      projectId: ProjectId.make("p1"),
      title,
      updatedAt,
      deletedAt: null,
      ...extra,
    });
    const project = (id: string, title: string, updatedAt: string, extra: object = {}) => ({
      environmentId: "env-1",
      id: ProjectId.make(id),
      title,
      updatedAt,
      ...extra,
    });
    const source = {
      threads: [
        thread("t1", "Fix login", "2026-01-01"),
        thread("t2", "Proxy setup", "2026-01-03"),
        thread("t3", "Deleted", "2026-01-04", { deletedAt: "2026-01-05" }),
        thread("t4", "Other env", "2026-01-04", { environmentId: "env-2" }),
      ],
      projects: [
        project("p1", "Web App", "2026-01-01"),
        project("p2", "Archived", "2026-01-02", { archivedAt: "2026-01-03" }),
        project("p3", "Api", "2026-01-04"),
      ],
    };
    expect(selectPluginChatTargets(source, "env-1", "")).toEqual({
      threads: [
        { threadId: "t2", title: "Proxy setup", projectId: "p1", projectName: "Web App" },
        { threadId: "t1", title: "Fix login", projectId: "p1", projectName: "Web App" },
      ],
      projects: [
        { projectId: "p3", name: "Api" },
        { projectId: "p1", name: "Web App" },
      ],
    });
    expect(selectPluginChatTargets(source, "env-1", " LOGIN ")).toEqual({
      threads: [{ threadId: "t1", title: "Fix login", projectId: "p1", projectName: "Web App" }],
      projects: [],
    });
  });
});
