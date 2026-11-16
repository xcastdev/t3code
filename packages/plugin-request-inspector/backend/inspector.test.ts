// @effect-diagnostics nodeBuiltinImport:off - Drives the builtin-only inspector backend through the SDK worker protocol.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { PLUGIN_LIMITS } from "@t3tools/contracts";

import { describe, expect, it } from "vite-plus/test";

import {
  type CallContext,
  flowRecord,
  type InspectorHarness,
  listenPortOf,
  makeFakeMitmdump,
  startInspector,
  threadContext,
} from "./inspector.testkit.ts";
import { exportBodyInput } from "./inspector.ts";
import { CONTROL_ENV } from "./mitm.ts";
import {
  EXPORT_DETAILS,
  IMPORT_DETAILS,
  MISSING_DETAILS,
  noDefaultProxyDetail,
  PROXY_DETAILS,
} from "./refusals.ts";

interface Endpoint {
  readonly proxyId: string;
  readonly listenPort: number;
  readonly proxyUrl: string;
}

interface ProxyView {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly recording: { readonly id: string } | null;
  readonly restartRequired: boolean;
}

const detailOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: { readonly detail?: string }) => error.detail,
  );

const setup = async (options: Parameters<typeof startInspector>[0] = {}) => {
  const fake = makeFakeMitmdump();
  const harness = await startInspector({
    ...options,
    deps: { spawner: fake.spawner, ...options.deps },
  });
  return { harness, fake };
};

const createProxy = (harness: InspectorHarness, input: unknown, context?: CallContext) =>
  harness.call(
    "create_proxy",
    input,
    context === undefined ? {} : { context },
  ) as Promise<ProxyView>;

/** Sends one flow from `spawn` and resolves once the requests topic shows it. */
const recordFlow = async (
  harness: InspectorHarness,
  fake: ReturnType<typeof makeFakeMitmdump>,
  spawnIndex: number,
  path: string,
) => {
  const stored = harness.nextBatch("requests", {}, (items) =>
    items.some((item) => (item as { readonly path?: string }).path === path),
  );
  (await fake.nextSpawn(spawnIndex)).send(flowRecord({ path }));
  const { items, stop } = await stored;
  await stop();
  return items.find((item) => (item as { readonly path?: string }).path === path) as {
    readonly id: string;
    readonly recordingId: string;
    readonly proxyId: string;
  };
};

describe("inspector proxies", () => {
  it("an auto port skips a busy port and the ports of other running proxies, and two proxies run at once", async () => {
    const { harness, fake } = await setup({ busyPorts: [8080] });
    await using _harness = harness;
    const first = (await harness.call("start_proxy", { proxyId: "1" })) as Endpoint;
    const second = await createProxy(harness, { link: "none" });
    const secondEndpoint = (await harness.call("start_proxy", { proxyId: second.id })) as Endpoint;

    expect(first).toMatchObject({
      proxyId: "1",
      listenPort: 8081,
      proxyUrl: "http://127.0.0.1:8081",
    });
    expect(secondEndpoint.listenPort).toBe(8082);
    expect(fake.spawns.map(listenPortOf)).toEqual([8081, 8082]);
    expect(await harness.call("start_proxy", { proxyId: "1" })).toEqual(first);
    expect(fake.spawns).toHaveLength(2);

    const explicitBusy = await createProxy(harness, {
      link: "none",
      options: { listenPort: 8080 },
    });
    expect(await detailOf(harness.call("start_proxy", { proxyId: explicitBusy.id }))).toBe(
      "Port 8080 is already in use.",
    );
  });

  it("start_recording needs a running proxy, stop_proxy closes the recording, and delete_proxy is refused while it runs", async () => {
    const { harness, fake } = await setup();
    await using _harness = harness;
    expect(await detailOf(harness.call("start_recording", { proxyId: "1" }))).toBe(
      PROXY_DETAILS.notRunning,
    );

    await harness.call("start_proxy", { proxyId: "1" });
    expect(fake.spawns[0]?.env[CONTROL_ENV.record]).toBe("0");
    const { recordingId } = (await harness.call("start_recording", { proxyId: "1" })) as {
      readonly recordingId: string;
    };
    expect(fake.spawns[0]?.controls).toEqual([{ type: "record", enabled: true, id: 1 }]);
    expect(await detailOf(harness.call("start_recording", { proxyId: "1" }))).toBe(
      PROXY_DETAILS.alreadyRecording,
    );
    const flow = await recordFlow(harness, fake, 0, "/recorded");
    expect(flow).toMatchObject({ recordingId, proxyId: "1" });
    expect(await detailOf(harness.call("delete_proxy", { proxyId: "1" }))).toBe(
      PROXY_DETAILS.running,
    );

    expect(await harness.call("stop_proxy", { proxyId: "1" })).toEqual({
      proxyId: "1",
      wasRunning: true,
      recordingId,
    });
    const recordings = (await harness.call("list_recordings", { proxyId: "1" })) as {
      readonly items: ReadonlyArray<{ readonly id: string; readonly stoppedAt?: number }>;
    };
    expect(recordings.items).toEqual([
      expect.objectContaining({ id: recordingId, stoppedAt: expect.any(Number) }),
    ]);
    expect(await harness.call("delete_proxy", { proxyId: "1" })).toMatchObject({ proxyId: "1" });
  });

  it("update_proxy applies host lists live, and restart: true keeps the open recording across the new process", async () => {
    const { harness, fake } = await setup();
    await using _harness = harness;
    await harness.call("start_proxy", { proxyId: "1" });
    const { recordingId } = (await harness.call("start_recording", { proxyId: "1" })) as {
      readonly recordingId: string;
    };

    const live = (await harness.call("update_proxy", {
      proxyId: "1",
      options: { passthroughHosts: ["*.apple.com"] },
    })) as { readonly restartRequired: boolean };
    expect(live.restartRequired).toBe(false);
    expect(fake.spawns[0]?.controls.at(-1)).toMatchObject({
      type: "hosts",
      passthrough: [expect.stringContaining("apple")],
      ignored: [],
    });
    expect(
      await detailOf(
        harness.call("update_proxy", { proxyId: "1", options: { ignoredHosts: ["a b"] } }),
      ),
    ).toMatch(/^Invalid host pattern "a b": /);

    const spawn = fake.spawns[0]!;
    const ignore = () =>
      harness.call("update_proxy", { proxyId: "1", options: { ignoredHosts: ["noise.test"] } });
    spawn.refuseNextControl("busy");
    expect(await detailOf(ignore())).toBeDefined();
    const unchanged = (await harness.call("list_proxies")) as {
      readonly proxies: ReadonlyArray<{ readonly ignoredHosts: ReadonlyArray<string> }>;
    };
    expect(unchanged.proxies[0]?.ignoredHosts).toEqual([]);
    await ignore();
    expect(spawn.controls.at(-1)).toMatchObject({
      type: "hosts",
      ignored: [expect.stringContaining("noise")],
    });

    const pending = (await harness.call("update_proxy", {
      proxyId: "1",
      options: { listenPort: 9090 },
    })) as { readonly restartRequired: boolean };
    expect(pending.restartRequired).toBe(true);
    expect(fake.spawns).toHaveLength(1);

    const restarted = (await harness.call("update_proxy", {
      proxyId: "1",
      options: {},
      restart: true,
    })) as { readonly proxy: ProxyView; readonly restartRequired: boolean };
    expect(restarted).toMatchObject({
      restartRequired: false,
      proxy: { state: "running", recording: { id: recordingId } },
    });
    const second = await fake.nextSpawn(1);
    expect(listenPortOf(second)).toBe(9090);
    expect(second.env[CONTROL_ENV.record]).toBe("1");
    expect(await recordFlow(harness, fake, 1, "/after-restart")).toMatchObject({ recordingId });
  });

  it("an agent can only listen on loopback or the listen host the user set", async () => {
    const { harness } = await setup({ config: { listenHost: "192.168.1.5" } });
    await using _harness = harness;
    const asAgent = { caller: "agent" as const };
    const create = (listenHost: string) =>
      harness.call("create_proxy", { link: "none", options: { listenHost } }, asAgent);

    expect(await detailOf(create("0.0.0.0"))).toBe(PROXY_DETAILS.agentListenHost);
    expect(
      await detailOf(
        harness.call("update_proxy", { proxyId: "1", options: { listenHost: "::" } }, asAgent),
      ),
    ).toBe(PROXY_DETAILS.agentListenHost);
    for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "::1", "[::1]", "192.168.1.5"]) {
      expect(await detailOf(create(host))).toBeUndefined();
    }
    const panel = await createProxy(harness, { link: "none", options: { listenHost: "0.0.0.0" } });
    expect(
      await detailOf(
        harness.call(
          "update_proxy",
          { proxyId: panel.id, options: { listenHost: "0.0.0.0", passthroughHosts: ["a.test"] } },
          asAgent,
        ),
      ),
    ).toBeUndefined();
  });

  it("update_proxy keeps upstream credentials for the same upstream url and clears them when the url changes without auth", async () => {
    const { harness } = await setup();
    await using _harness = harness;
    const auth = { username: "user", password: "s3cret" };
    const created = await createProxy(harness, {
      link: "none",
      options: { mode: { kind: "upstream", url: "http://127.0.0.1:3128", auth } },
    });
    const hasAuth = async (mode: unknown) => {
      const updated = (await harness.call("update_proxy", {
        proxyId: created.id,
        options: { mode },
      })) as { readonly proxy: { readonly mode: { readonly hasAuth?: boolean } } };
      return updated.proxy.mode.hasAuth;
    };
    expect(await hasAuth({ kind: "upstream", url: "http://127.0.0.1:3128" })).toBe(true);
    expect(await hasAuth({ kind: "upstream", url: "http://127.0.0.1:3129" })).toBe(false);
    expect(await hasAuth({ kind: "upstream", url: "http://127.0.0.1:3130", auth })).toBe(true);
    expect(await hasAuth({ kind: "upstream", url: "http://127.0.0.1:3130", auth: null })).toBe(
      false,
    );
  });

  it("a call without proxyId resolves through the caller thread's link; a subagent without one is told its parent's proxy first", async () => {
    const parent = threadContext("thread-parent", "project-1");
    const child = threadContext("thread-child", "project-1", "thread-parent");
    const { harness } = await setup();
    await using _harness = harness;
    const linked = await createProxy(harness, { name: "Parent" }, parent);

    expect(await harness.call("start_proxy", {}, { context: parent })).toMatchObject({
      proxyId: linked.id,
    });
    const listed = (await harness.call("list_proxies", {}, { context: child })) as {
      readonly defaultProxyId: string | null;
      readonly proxies: ReadonlyArray<{ readonly id: string; readonly callerLink: string | null }>;
    };
    expect(listed.defaultProxyId).toBeNull();
    expect(listed.proxies.find((proxy) => proxy.id === linked.id)?.callerLink).toBe("parentThread");
    expect(await detailOf(harness.call("start_recording", {}, { context: child }))).toBe(
      noDefaultProxyDetail([
        { proxyId: linked.id, name: "Parent", link: "parentThread" },
        { proxyId: "1", name: "Default", link: null },
      ]),
    );
    expect(
      await harness.call("start_recording", { proxyId: linked.id }, { context: child }),
    ).toMatchObject({ proxyId: linked.id });
  });

  it("link_proxy validates an explicit thread through the host and adds to the target's links; the newest is the default and unlink_proxy can remove one", async () => {
    const known = threadContext("thread-known", "project-1");
    const { harness } = await setup({
      resolveContext: (ref) =>
        "threadId" in ref && ref.threadId === "thread-known" ? known : null,
    });
    await using _harness = harness;
    const other = await createProxy(harness, { link: "none" });
    const target = { threadId: "thread-known" };
    const listed = async () => {
      const result = (await harness.call("list_proxies", {}, { context: known })) as {
        readonly defaultProxyId: string | null;
        readonly proxies: ReadonlyArray<{
          readonly id: string;
          readonly callerLink: string | null;
        }>;
      };
      return {
        defaultProxyId: result.defaultProxyId,
        linked: result.proxies.filter((proxy) => proxy.callerLink === "thread").map((p) => p.id),
      };
    };

    expect(
      await detailOf(
        harness.call("link_proxy", { proxyId: "1", target: { threadId: "thread-missing" } }),
      ),
    ).toBe(MISSING_DETAILS.target);
    expect(await harness.call("link_proxy", { proxyId: "1", target })).toEqual({
      target: { kind: "thread", id: "thread-known" },
    });
    await harness.call("link_proxy", { proxyId: other.id, target });
    expect(await listed()).toEqual({ defaultProxyId: other.id, linked: ["1", other.id] });
    expect(await harness.call("start_proxy", {}, { context: known })).toMatchObject({
      proxyId: other.id,
    });

    await harness.call("link_proxy", { proxyId: "1", target });
    expect((await listed()).defaultProxyId).toBe("1");

    expect(await harness.call("unlink_proxy", { proxyId: "1", target })).toEqual({
      proxyIds: ["1"],
      target: { kind: "thread", id: "thread-known" },
    });
    expect(await listed()).toEqual({ defaultProxyId: other.id, linked: [other.id] });
    await harness.call("link_proxy", { proxyId: "1", target });
    const third = await createProxy(harness, {}, known);
    expect(await listed()).toEqual({ defaultProxyId: third.id, linked: ["1", other.id, third.id] });
    expect(await harness.call("unlink_proxy", { target })).toEqual({
      proxyIds: ["1", other.id, third.id],
      target: { kind: "thread", id: "thread-known" },
    });
    expect(await listed()).toEqual({ defaultProxyId: null, linked: [] });
  });
});

describe("inspector imports", () => {
  interface ImportView {
    readonly recordingId: string;
    readonly name: string;
    readonly state: string;
    readonly imported: number;
    readonly skipped: number;
    readonly detail?: string;
  }

  it("an upload imports through a listen-less mitmdump into a named recording, and is deleted once the import ends", async () => {
    const { harness, fake } = await setup();
    await using _harness = harness;
    const bytes = Buffer.from("not really a dump, the fake mitmdump never reads it");
    const firstChunk = { offset: 0, base64: bytes.subarray(0, 10).toString("base64") };
    expect(await detailOf(harness.call("import_upload_write", firstChunk))).toBe(
      IMPORT_DETAILS.uploadSize,
    );
    // Half the default 512 MiB budget is the most an upload may declare.
    expect(
      await detailOf(
        harness.call("import_upload_write", { ...firstChunk, size: 256 * 1024 * 1024 + 1 }),
      ),
    ).toBe(IMPORT_DETAILS.uploadTooLarge);
    const first = (await harness.call("import_upload_write", {
      ...firstChunk,
      size: bytes.byteLength,
    })) as { readonly uploadId: string };
    await harness.call("import_upload_write", {
      uploadId: first.uploadId,
      offset: 10,
      base64: bytes.subarray(10).toString("base64"),
    });

    const started = (await harness.call("import_flows", {
      uploadId: first.uploadId,
      name: "checkout.mitm",
      proxyId: "1",
    })) as ImportView;
    expect(started).toMatchObject({ name: "checkout.mitm", state: "running" });
    const spawn = await fake.nextSpawn(0);
    expect(spawn.args.slice(0, 2)).toEqual(["--set", "server=false"]);
    const file = spawn.env[CONTROL_ENV.importPath] as string;
    expect(NodeFS.readFileSync(file).equals(bytes)).toBe(true);

    spawn.send({ ...flowRecord({ path: "/cart" }), startedAt: 1_600_000_000_000 });
    spawn.send({ type: "importDone", skipped: 2, error: null });
    const done = (await harness.call("get_import", {
      recordingId: started.recordingId,
      waitMs: 20_000,
    })) as ImportView;
    expect(done).toMatchObject({ state: "completed", imported: 1, skipped: 2 });
    expect(spawn.signals).toContain("SIGTERM");
    expect(NodeFS.existsSync(file)).toBe(false);
    const recordings = (await harness.call("list_recordings", { proxyId: "1" })) as {
      readonly items: ReadonlyArray<{ readonly name?: string; readonly startedAt: number }>;
    };
    expect(recordings.items).toMatchObject([
      { name: "checkout.mitm", startedAt: 1_600_000_000_000 },
    ]);
    expect(
      await detailOf(harness.call("import_flows", { uploadId: first.uploadId, proxyId: "1" })),
    ).toBe(IMPORT_DETAILS.uploadMissing);
  });

  it.each([
    // An import never prunes its own requests to make room for later ones.
    { limit: "the storage budget", config: { maxDiskBytes: 14 * 1024 * 1024 } },
    { limit: "maxRequestsPerRecording", config: { maxRequestsPerRecording: 1 } },
  ])("flows past $limit are dropped and counted on the recording", async ({ config }) => {
    const MiB = 1024 * 1024;
    const { harness, fake } = await setup({
      deps: { configOverrides: { maxBodyBytes: 16 * MiB, ...config } },
    });
    await using _harness = harness;
    const dump = NodePath.join(NodePath.dirname(harness.dataDir), "big.mitm");
    NodeFS.writeFileSync(dump, "flows");
    const started = (await harness.call("import_flows", {
      path: dump,
      proxyId: "1",
    })) as ImportView;
    const spawn = await fake.nextSpawn(0);
    const body = { data: Buffer.alloc(10 * MiB, 97).toString("base64"), truncated: false };
    for (const path of ["/a", "/b", "/c"]) spawn.send({ ...flowRecord({ path }), body });
    spawn.send({ type: "importDone", skipped: 0, error: null });

    const done = (await harness.call("get_import", {
      recordingId: started.recordingId,
      waitMs: 20_000,
    })) as ImportView & { readonly dropped: number };
    expect(done).toMatchObject({ state: "completed", imported: 1, dropped: 2 });
    const recordings = (await harness.call("list_recordings", { proxyId: "1" })) as {
      readonly items: ReadonlyArray<{
        readonly requestCount: number;
        readonly droppedFlows: number;
      }>;
    };
    expect(recordings.items).toMatchObject([{ requestCount: 1, droppedFlows: 2 }]);
  });

  it("only two imports run at once, even when they start together", async () => {
    const { harness, fake } = await setup();
    await using _harness = harness;
    const dump = NodePath.join(NodePath.dirname(harness.dataDir), "same.mitm");
    NodeFS.writeFileSync(dump, "flows");
    const results = await Promise.allSettled(
      [1, 2, 3].map(() => harness.call("import_flows", { path: dump, proxyId: "1" })),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(fake.spawns).toHaveLength(2);
    for (const spawn of fake.spawns) spawn.send({ type: "importDone", skipped: 0, error: null });
  });

  it("deleting the recording stops a running import, and its proxy cannot be deleted meanwhile", async () => {
    const { harness, fake } = await setup();
    await using _harness = harness;
    const dump = NodePath.join(NodePath.dirname(harness.dataDir), "long.mitm");
    NodeFS.writeFileSync(dump, "flows");
    const started = (await harness.call("import_flows", {
      path: dump,
      proxyId: "1",
    })) as ImportView;
    const spawn = await fake.nextSpawn(0);
    expect(spawn.env[CONTROL_ENV.importPath]).toBe(dump);
    const stored = harness.nextBatch("requests", {}, (items) => items.length > 0);
    spawn.send(flowRecord({ path: "/one" }));
    await (await stored).stop();

    expect(await detailOf(harness.call("delete_proxy", { proxyId: "1" }))).toBe(
      IMPORT_DETAILS.proxyBusy,
    );
    await harness.call("delete_recording", { recordingId: started.recordingId });
    const done = (await harness.call("get_import", {
      recordingId: started.recordingId,
      waitMs: 20_000,
    })) as ImportView;
    expect(done).toMatchObject({ state: "failed", detail: IMPORT_DETAILS.deleted });
    expect(spawn.signals).toContain("SIGTERM");
  });
});

describe("inspector exports and replay carriers", () => {
  it("export_requests inlines a small export and writes a file under dataDir/exports that read_export streams back", async () => {
    const { harness, fake } = await setup();
    await using _harness = harness;
    await harness.call("start_proxy", { proxyId: "1" });
    await harness.call("start_recording", { proxyId: "1" });
    const flow = await recordFlow(harness, fake, 0, "/login");

    const inline = (await harness.call("export_requests", {
      requestIds: [flow.id],
      format: "curl",
    })) as { readonly inline?: string; readonly count: number };
    expect(inline.count).toBe(1);
    expect(inline.inline).toContain("curl");
    expect(inline.inline).toContain("http://upstream.test/login");

    const written = (await harness.call("export_requests", {
      filter: { proxyId: "1" },
      format: "har",
      output: "file",
    })) as {
      readonly file: { readonly exportId: string; readonly path: string; readonly bytes: number };
    };
    expect(NodePath.dirname(written.file.path)).toBe(NodePath.join(harness.dataDir, "exports"));
    const onDisk = NodeFS.readFileSync(written.file.path);
    expect(onDisk.byteLength).toBe(written.file.bytes);
    expect(JSON.parse(onDisk.toString("utf8")).log.entries).toHaveLength(1);

    const chunk = (await harness.call("read_export", {
      exportId: written.file.exportId,
      offset: 0,
      length: 131072,
    })) as { readonly base64: string; readonly eof: boolean };
    expect(chunk.eof).toBe(true);
    expect(Buffer.from(chunk.base64, "base64").equals(onDisk)).toBe(true);
  });

  it("export_requests with a filter past the request cap says it was truncated and how many matched", async () => {
    const { harness, fake } = await setup({ deps: { maxExportRequests: 1 } });
    await using _harness = harness;
    await harness.call("start_proxy", { proxyId: "1" });
    await harness.call("start_recording", { proxyId: "1" });
    await recordFlow(harness, fake, 0, "/old");
    await recordFlow(harness, fake, 0, "/new");

    const capped = (await harness.call("export_requests", {
      filter: { proxyId: "1" },
      format: "json",
    })) as { readonly count: number; readonly truncated?: boolean; readonly matched?: number };
    expect(capped).toMatchObject({ count: 1, truncated: true, matched: 2 });

    const narrow = (await harness.call("export_requests", {
      filter: { proxyId: "1", query: "/new" },
      format: "json",
    })) as { readonly count: number; readonly truncated?: boolean };
    expect(narrow.count).toBe(1);
    expect(narrow.truncated).toBeUndefined();
  });

  it("an export or header list whose JSON escaping would overflow one payload goes to a file or is cut, never inline", async () => {
    const { harness, fake } = await setup();
    await using _harness = harness;
    await harness.call("start_proxy", { proxyId: "1" });
    await harness.call("start_recording", { proxyId: "1" });
    // 40 KiB of control bytes is under the 64 KiB inline cap, and six times that once escaped.
    const control = "\u0001".repeat(40 * 1024);
    const spawn = await fake.nextSpawn(0);
    const stored = async (path: string, flow: Record<string, unknown>) => {
      const batch = harness.nextBatch("requests", {}, (items) =>
        items.some((item) => (item as { readonly path?: string }).path === path),
      );
      spawn.send(flow);
      const { items, stop } = await batch;
      await stop();
      return (
        items.find((item) => (item as { readonly path?: string }).path === path) as {
          readonly id: string;
        }
      ).id;
    };
    const requestId = await stored(
      "/escaped-body",
      flowRecord({ path: "/escaped-body", body: control }),
    );
    const headerRequestId = await stored(
      "/escaped-headers",
      flowRecord({
        path: "/escaped-headers",
        headers: Array.from({ length: 30 }, (_, index) => [`x-${index}`, control.slice(0, 8192)]),
      }),
    );

    const auto = (await harness.call("export_requests", {
      requestIds: [requestId],
      format: "raw",
    })) as { readonly inline?: string; readonly file?: { readonly bytes: number } };
    expect(auto.inline).toBeUndefined();
    expect(auto.file?.bytes).toBeLessThan(64 * 1024);
    expect(
      await detailOf(
        harness.call("export_requests", {
          requestIds: [requestId],
          format: "raw",
          output: "inline",
        }),
      ),
    ).toBe(EXPORT_DETAILS.inlineTooLarge);

    const headers = (await harness.call("format_headers", {
      requestId: headerRequestId,
      side: "request",
      format: "raw",
    })) as { readonly text: string; readonly truncated?: boolean };
    expect(headers.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(headers))).toBeLessThanOrEqual(
      PLUGIN_LIMITS.maxPayloadBytes,
    );
  });

  it("decode_value reads a recorded header, credentials included", async () => {
    const { harness, fake } = await setup();
    await using _harness = harness;
    await harness.call("start_proxy", { proxyId: "1" });
    await harness.call("start_recording", { proxyId: "1" });
    const stored = harness.nextBatch("requests", {}, (items) => items.length > 0);
    (await fake.nextSpawn(0)).send(
      flowRecord({
        headers: [
          ["Authorization", "Bearer s3cret"],
          ["X-Trace", "abc"],
        ],
      }),
    );
    const { items, stop } = await stored;
    await stop();
    const requestId = (items[0] as { readonly id: string }).id;
    const decode = (source: Record<string, unknown>) =>
      harness.call("decode_value", {
        source: { requestId, side: "request", ...source },
        steps: [{ op: "base64", direction: "encode" }],
      });

    expect(await decode({ header: "authorization" })).toMatchObject({
      steps: [{ text: Buffer.from("Bearer s3cret").toString("base64") }],
    });
    expect(await decode({ header: "x-trace" })).toMatchObject({
      steps: [{ text: Buffer.from("abc").toString("base64") }],
    });
  });

  it("agent calls and references hide credential headers unless includeSensitiveHeaders; the panel sees them", async () => {
    const { harness, fake } = await setup();
    await using _harness = harness;
    await harness.call("start_proxy", { proxyId: "1" });
    const { recordingId } = (await harness.call("start_recording", { proxyId: "1" })) as {
      readonly recordingId: string;
    };
    const stored = harness.nextBatch("requests", {}, (items) => items.length > 0);
    (await fake.nextSpawn(0)).send(
      flowRecord({
        headers: [
          ["Authorization", "Bearer s3cret"],
          ["Cookie", "sid=c00kie"],
          ["Proxy-Authorization", "Basic pr0xy"],
          ["X-Api-Key", "k3yval"],
          ["X-Trace", "abc"],
        ],
        responseHeaders: [["Set-Cookie", "sid=n3w; Path=/"]],
      }),
    );
    const { items, stop } = await stored;
    await stop();
    const requestId = (items[0] as { readonly id: string }).id;
    const secrets = /s3cret|c00kie|pr0xy|k3yval|n3w/;
    const agent = (operation: string, input: Record<string, unknown>) =>
      harness.call(operation, input, { caller: "agent" }).then((result) => JSON.stringify(result));

    const hidden = await agent("get_request", { requestId });
    expect(hidden).not.toMatch(secrets);
    expect(hidden).toContain('["X-Trace","abc"]');
    expect(hidden).toContain('["Authorization","[redacted]"]');
    expect(hidden).toContain('["Cookie","sid=[redacted]"]');
    expect(await agent("format_headers", { requestId, side: "response", format: "raw" })).toBe(
      JSON.stringify({ text: "Set-Cookie: sid=[redacted]; Path=/" }),
    );
    expect(await agent("export_requests", { requestIds: [requestId], format: "curl" })).not.toMatch(
      secrets,
    );
    const decodeAuth = (extra: Record<string, unknown>) =>
      harness.call(
        "decode_value",
        {
          source: { requestId, side: "request", header: "authorization" },
          steps: [{ op: "url", direction: "decode" }],
          ...extra,
        },
        { caller: "agent" },
      );
    expect(await detailOf(decodeAuth({}))).toMatch(/includeSensitiveHeaders/);
    expect(JSON.stringify(await decodeAuth({ includeSensitiveHeaders: true }))).toMatch(/s3cret/);
    const reference = await harness.client.resolveReference({ requestId, recordingId });
    expect(reference.detail).not.toMatch(secrets);
    expect(reference.detail).toContain("X-Trace: abc");

    expect(await agent("get_request", { requestId, includeSensitiveHeaders: true })).toMatch(
      /s3cret.*c00kie.*pr0xy.*n3w/,
    );
    expect(
      await agent("export_requests", {
        requestIds: [requestId],
        format: "raw",
        includeSensitiveHeaders: true,
      }),
    ).toMatch(/s3cret/);
    expect(JSON.stringify(await harness.call("get_request", { requestId }))).toMatch(secrets);

    const elsewhere = { requestId, edits: { url: "https://elsewhere.example/" } };
    const withheld = (input: Record<string, unknown>, caller?: "agent") =>
      harness
        .call("preview_replay", input, caller === undefined ? {} : { caller })
        .then((preview) => (preview as { readonly withheldHeaders?: unknown }).withheldHeaders);
    expect(await withheld(elsewhere, "agent")).toEqual([
      "Authorization",
      "Cookie",
      "Proxy-Authorization",
      "X-Api-Key",
    ]);
    expect(
      await withheld({ ...elsewhere, includeSensitiveHeaders: true }, "agent"),
    ).toBeUndefined();
    expect(await withheld(elsewhere)).toBeUndefined();
  });

  it("an export charges decoded bodies to its budget and decodes only the bodies its format shows decoded", () => {
    const raw = NodeZlib.gzipSync(Buffer.alloc(64 * 1024));
    const meta = { capturedBytes: raw.byteLength, truncated: false, contentEncoding: "gzip" };
    const budget = { left: 1024 * 1024 };
    expect(exportBodyInput(raw, meta, false, budget).decoded).toBeUndefined();
    expect(budget.left).toBe(1024 * 1024 - raw.byteLength);
    expect(exportBodyInput(raw, meta, true, budget).decoded?.byteLength).toBe(64 * 1024);
    expect(budget.left).toBe(1024 * 1024 - 2 * raw.byteLength - 64 * 1024);
    expect(() => exportBodyInput(raw, meta, true, { left: 32 * 1024 })).toThrow(
      EXPORT_DETAILS.tooLarge,
    );
  });

  it("a replay whose source proxy is stopped goes through a replay-only mitmdump with that proxy's upstream, its auth only in env", async () => {
    const { harness, fake } = await setup();
    await using _harness = harness;
    const upstream = await createProxy(harness, {
      link: "none",
      options: {
        mode: {
          kind: "upstream",
          url: "http://127.0.0.1:3128",
          auth: { username: "user", password: "s3cret" },
        },
      },
    });
    await harness.call("start_proxy", { proxyId: upstream.id });
    await harness.call("start_recording", { proxyId: upstream.id });
    const flow = await recordFlow(harness, fake, 0, "/source");
    await harness.call("stop_proxy", { proxyId: upstream.id });

    const { idempotencyKey } = (await harness.call("preview_replay", {
      requestId: flow.id,
    })) as { readonly idempotencyKey: string };
    const accepted = (await harness.call("replay_request", {
      requestId: flow.id,
      idempotencyKey,
    })) as { readonly replayId: string };
    const transient = await fake.nextSpawn(1);
    expect(transient.args).toEqual(
      expect.arrayContaining(["--mode", "upstream:http://127.0.0.1:3128"]),
    );
    expect(transient.args.join(" ")).not.toContain("s3cret");
    expect(transient.env[CONTROL_ENV.upstreamAuth]).toBe("user:s3cret");
    expect(
      await harness.call("get_replay", { replayId: accepted.replayId, waitMs: 20_000 }),
    ).toMatchObject({ state: "completed" });
  });
});
