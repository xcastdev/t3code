// @effect-diagnostics nodeBuiltinImport:off - Drives the builtin-only backend runtime over Node streams.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { PLUGIN_LIMITS, type PluginSubscriptionEvent } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "vite-plus/test";

import {
  definePluginBackend,
  materializeAsset,
  PLUGIN_WORKER_LIMITS,
  reportStatus,
  type PluginBackendDefinition,
  type TopicEmitter,
} from "./backend.ts";
import { makeWorkerClient, WorkerRequestError, type FakeContextResolver } from "./testing.ts";

const subagentContext = {
  projectId: "project-1",
  thread: {
    id: "thread-child",
    parentThreadId: "thread-parent",
    rootThreadId: "thread-parent",
    relationshipToParent: "subagent",
  },
} as const;

const startBackend = async (
  definition: PluginBackendDefinition,
  resolveContext?: FakeContextResolver,
) => {
  const toWorker = new NodeStream.PassThrough();
  const fromWorker = new NodeStream.PassThrough();
  const exited = Promise.withResolvers<number>();
  const exits: Array<number> = [];
  definePluginBackend(definition, {
    input: toWorker,
    output: fromWorker,
    exit: (code) => {
      exits.push(code);
      exited.resolve(code);
    },
  });
  const dataDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "plugin-sdk-backend-"));
  const client = makeWorkerClient({
    input: fromWorker,
    output: toWorker,
    initialize: { pluginId: "echo", version: "0.1.0", dataDir, config: {}, secrets: {} },
    ...(resolveContext === undefined ? {} : { resolveContext }),
  });
  await client.initialize();
  return { client, dataDir, fromWorker, exits, exited: exited.promise };
};

const collectEvents = () => {
  const events: Array<PluginSubscriptionEvent> = [];
  let waiter: { count: number; resolve: () => void } | undefined;
  return {
    events,
    onEvent: (event: PluginSubscriptionEvent) => {
      events.push(event);
      if (waiter !== undefined && events.length >= waiter.count) waiter.resolve();
    },
    waitFor: (count: number) =>
      events.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiter = { count, resolve };
          }),
  };
};

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe("definePluginBackend", () => {
  it("keeps its limits equal to the contracts' PLUGIN_LIMITS", () => {
    expect(PLUGIN_WORKER_LIMITS).toEqual({
      maxPayloadBytes: PLUGIN_LIMITS.maxPayloadBytes,
      maxMessageBytes: PLUGIN_LIMITS.maxMessageBytes,
      maxBatchBytes: PLUGIN_LIMITS.maxBatchBytes,
    });
  });

  it("answers invoke with the handler result and reports unknown-operation", async () => {
    const { client } = await startBackend({
      operations: { ping: async (input, ctx) => ({ input, caller: ctx.caller }) },
    });
    await expect(client.invoke("ping", { message: "hi" }, "agent").result).resolves.toEqual({
      input: { message: "hi" },
      caller: "agent",
    });
    const missing = await client.invoke("nope", {}).result.catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(WorkerRequestError);
    expect(missing).toMatchObject({ reason: "unknown-operation" });
  });

  it("forwards the invoke context to ctx.context and rejects a malformed one", async () => {
    const { client } = await startBackend({
      operations: { where: async (_input, ctx) => ctx.context },
    });
    await expect(client.invoke("where", {}, "agent", subagentContext).result).resolves.toEqual(
      subagentContext,
    );
    const malformed = { projectId: null, thread: { id: "t" } } as never;
    await expect(client.invoke("where", {}, "ui", malformed).result).rejects.toMatchObject({
      code: -32602,
    });
  });

  it("gives an empty ctx.context when the host sends none", async () => {
    const { client } = await startBackend({
      operations: { where: async (_input, ctx) => ctx.context },
    });
    await expect(client.invoke("where", {}).result).resolves.toEqual({
      projectId: null,
      thread: null,
    });
  });

  it("ctx.host.resolveContext asks the host and returns its answer", async () => {
    const asked: Array<unknown> = [];
    const { client } = await startBackend(
      {
        operations: {
          resolve: async (input, ctx) =>
            ctx.host.resolveContext(input as { readonly threadId: string }),
        },
      },
      (ref) => {
        asked.push(ref);
        return "threadId" in ref && ref.threadId === "thread-child" ? subagentContext : null;
      },
    );
    await expect(client.invoke("resolve", { threadId: "thread-child" }).result).resolves.toEqual(
      subagentContext,
    );
    await expect(client.invoke("resolve", { threadId: "gone" }).result).resolves.toBeNull();
    await expect(
      client.invoke("resolve", { threadId: "a", projectId: "b" }).result,
    ).rejects.toMatchObject({ reason: "operation-failed" });
    expect(asked).toEqual([{ threadId: "thread-child" }, { threadId: "gone" }]);
  });

  it("reports a thrown handler error as operation-failed, an oversized result as too-large, and status changes", async () => {
    const { client } = await startBackend({
      operations: {
        fail: async () => {
          throw new Error("incomplete body");
        },
        big: async () => "x".repeat(PLUGIN_LIMITS.maxPayloadBytes),
        after: async () => {
          reportStatus("failed", "lost upstream");
          return "still serving";
        },
      },
    });
    await expect(client.invoke("fail", {}).result).rejects.toMatchObject({
      reason: "operation-failed",
      detail: "incomplete body",
    });
    await expect(client.invoke("big", {}).result).rejects.toMatchObject({ reason: "too-large" });
    await expect(client.invoke("after", {}).result).resolves.toBe("still serving");
    expect(client.statuses).toEqual([{ state: "failed", detail: "lost upstream" }]);
  });

  it("cancel aborts the operation's signal", async () => {
    const { client } = await startBackend({
      operations: {
        wait: (_input, ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener("abort", () => resolve("aborted"));
          }),
      },
    });
    const call = client.invoke("wait", {});
    client.cancel(call.id);
    await expect(call.result).resolves.toBe("aborted");
  });

  it("emits a snapshot with revision and cursor, then batches, and stops on unsubscribe", async () => {
    let emitter: TopicEmitter | undefined;
    let disposed = 0;
    const { client } = await startBackend({
      operations: {
        push: async (input) => {
          emitter?.batch([input], "r2");
          return null;
        },
      },
      topics: {
        ticks: (params, emit) => {
          emitter = emit;
          emit.snapshot({ items: [params], revision: "r1", cursor: "older" });
          return () => {
            disposed += 1;
          };
        },
      },
    });
    const collected = collectEvents();
    const unsubscribe = await client.subscribe("ticks", { n: 0 }, collected.onEvent);
    await client.invoke("push", { n: 1 }).result;
    await collected.waitFor(2);
    expect(collected.events).toEqual([
      { type: "snapshot", items: [{ n: 0 }], revision: "r1", cursor: "older" },
      { type: "batch", items: [{ n: 1 }], revision: "r2" },
    ]);

    await unsubscribe();
    expect(disposed).toBe(1);
    emitter?.batch([{ n: 2 }], "r3");
    await client.invoke("push", { n: 3 }).result;
    expect(collected.events).toHaveLength(2);
  });

  it("batch before snapshot throws", async () => {
    let thrown: unknown;
    const { client } = await startBackend({
      operations: {},
      topics: {
        ticks: (_params, emit) => {
          try {
            emit.batch([1], "r0");
          } catch (error) {
            thrown = error;
          }
          emit.snapshot({ items: [], revision: "r1", cursor: null });
          return () => {};
        },
      },
    });
    const collected = collectEvents();
    await client.subscribe("ticks", {}, collected.onEvent);
    await collected.waitFor(1);
    expect(thrown).toBeInstanceOf(Error);
    expect(collected.events).toEqual([
      { type: "snapshot", items: [], revision: "r1", cursor: null },
    ]);
  });

  it("an oversized batch is split in order under one revision, and an oversized item throws", async () => {
    let emitter: TopicEmitter | undefined;
    const { client } = await startBackend({
      operations: {},
      topics: {
        ticks: (_params, emit) => {
          emitter = emit;
          emit.snapshot({ items: [], revision: "r1", cursor: null });
          return () => {};
        },
      },
    });
    const collected = collectEvents();
    await client.subscribe("ticks", {}, collected.onEvent);
    const items = Array.from({ length: 10 }, (_, index) => ({
      index,
      text: "y".repeat(20 * 1024),
    }));
    emitter?.batch(items, "r2");
    await collected.waitFor(4);
    const batches = collected.events.slice(1);
    expect(batches.length).toBeGreaterThan(1);
    for (const event of batches) {
      expect(event).toMatchObject({ type: "batch", revision: "r2" });
      expect(jsonBytes(event)).toBeLessThanOrEqual(PLUGIN_LIMITS.maxBatchBytes);
    }
    expect(batches.flatMap((event) => (event.type === "batch" ? event.items : []))).toEqual(items);

    expect(() => emitter?.batch([{ text: "z".repeat(PLUGIN_LIMITS.maxBatchBytes) }], "r3")).toThrow(
      Error,
    );
    expect(() =>
      emitter?.snapshot({
        items: ["z".repeat(PLUGIN_LIMITS.maxPayloadBytes)],
        revision: "r4",
        cursor: null,
      }),
    ).toThrow(Error);
  });

  it("materializeAsset writes once per content hash under dataDir/runtime", async () => {
    const { dataDir } = await startBackend({ operations: {} });
    const first = await materializeAsset("hello.txt", "hello");
    const firstStat = await NodeFSP.stat(first);
    const second = await materializeAsset("hello.txt", "hello");
    const other = await materializeAsset("hello.txt", "goodbye");

    expect(NodePath.dirname(first)).toBe(NodePath.join(dataDir, "runtime"));
    expect(NodePath.basename(first)).toMatch(/^[0-9a-f]{16}-hello\.txt$/);
    expect(second).toBe(first);
    expect((await NodeFSP.stat(second)).ino).toBe(firstStat.ino);
    expect(other).not.toBe(first);
    expect(await NodeFSP.readFile(first, "utf8")).toBe("hello");
    expect(await NodeFSP.readFile(other, "utf8")).toBe("goodbye");
    if (HostProcess.Platform.defaultValue() !== "win32") expect(firstStat.mode & 0o777).toBe(0o600);
    await expect(materializeAsset("../escape.txt", "x")).rejects.toThrow(Error);
  });

  it("exits on stdin EOF after running onStop", async () => {
    const order: Array<string> = [];
    const { client, exited } = await startBackend({
      operations: {},
      onStop: async () => {
        order.push("stop");
      },
    });
    await client.close();
    expect(await exited).toBe(0);
    expect(order).toEqual(["stop"]);
  });

  it("finishes onStop and exits once when the host's pipe breaks with a call pending", async () => {
    const order: Array<string> = [];
    const started = Promise.withResolvers<void>();
    const { client, fromWorker, exits, exited } = await startBackend({
      operations: {
        wait: (_input, ctx) =>
          new Promise((_resolve, reject) => {
            started.resolve();
            ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      },
      onStop: async () => {
        await Promise.resolve();
        order.push("stop");
      },
    });
    void client.invoke("wait", {}).result.catch(() => undefined);
    await started.promise;
    fromWorker.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(await exited).toBe(0);
    expect(order).toEqual(["stop"]);
    await client.close();
    expect(exits).toEqual([0]);
  });
});
