import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
// @effect-diagnostics nodeBuiltinImport:off - Tests probe worker pids and read /proc directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EMPTY_PLUGIN_CALL_CONTEXT,
  PLUGIN_LIMITS,
  type PluginCallContext,
  type PluginId,
  type PluginSubscriptionEvent,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { packPlugin } from "@t3tools/plugin-sdk/pack";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { attachmentFileExtension, createPendingAttachmentId } from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as PluginPackageStore from "./PluginPackageStore.ts";
import * as PluginWorkerSupervisor from "./PluginWorkerSupervisor.ts";

const ECHO_DIR = NodeURL.fileURLToPath(
  new URL("../../../../packages/plugin-sdk/src/testFixtures/echo", import.meta.url),
);
const BIN_PATH = NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url));
const ECHO = "echo" as PluginId;

const encoder = new TextEncoder();

const KNOWN_PROJECT = ProjectId.make("project-known");
const CALL_CONTEXT: PluginCallContext = {
  projectId: KNOWN_PROJECT,
  thread: {
    id: ThreadId.make("thread-child"),
    parentThreadId: ThreadId.make("thread-parent"),
    rootThreadId: ThreadId.make("thread-parent"),
    relationshipToParent: "subagent",
  },
};
const resolveContext: PluginWorkerSupervisor.PluginContextResolver = (params) =>
  Effect.succeed(
    params.projectId === KNOWN_PROJECT ? { projectId: KNOWN_PROJECT, thread: null } : null,
  );
const call = (operation: string, input: unknown = {}, caller: "ui" | "agent" = "ui") => ({
  operation,
  input,
  caller,
  context: EMPTY_PLUGIN_CALL_CONTEXT,
});

/** A pid is gone once signalling it fails, or (Linux) once only its zombie remains. */
const isGone = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    return /^\d+ \(.*\) Z/.test(NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
};

const selfInvocationLayer = Layer.mergeAll(
  Layer.succeed(HostProcess.ExecutablePath, process.execPath),
  Layer.succeed(HostProcess.Arguments, [process.execPath, BIN_PATH]),
  Layer.succeed(HostProcess.IsExecutable, false),
);

interface InstalledEcho {
  readonly entryPath: string;
  readonly dataDir: string;
  readonly start: PluginWorkerSupervisor.PluginWorkerStartInput;
}

/**
 * Packs the echo fixture into a fresh OS temp directory and installs it into a state dir
 * beside it, so the worker runs with no `node_modules` ancestor.
 */
const installEcho = Effect.fn("test.installEcho")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({
      directory: NodeOS.tmpdir(),
      prefix: "t3-plugin-worker-",
    }),
  );
  const archive = path.join(root, "echo.t3plugin");
  yield* Effect.promise(() => packPlugin(ECHO_DIR, archive));
  return yield* Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const store = yield* PluginPackageStore.PluginPackageStore;
    const extension = attachmentFileExtension("echo.t3plugin");
    const attachmentId = createPendingAttachmentId(extension);
    yield* fileSystem.copyFile(
      archive,
      path.join(config.attachmentsDir, `${attachmentId}${extension}`),
    );
    const { record } = yield* store.installFromAttachment({
      attachmentId,
      trustBackendAuthor: true,
    });
    const paths = store.paths(record.pluginId, record.version);
    const entryPath = path.join(paths.packageDir, record.manifest.backend!.entry);
    return {
      entryPath,
      dataDir: paths.dataDir,
      start: {
        pluginId: record.pluginId,
        version: record.version,
        entryPath,
        dataDir: paths.dataDir,
        config: {},
        secrets: {},
        prerequisites: [],
        resolveContext,
      },
    } satisfies InstalledEcho;
  }).pipe(
    Effect.provide(
      PluginPackageStore.layer.pipe(
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provideMerge(ServerConfig.layerTest(root, path.join(root, "state"))),
      ),
    ),
  );
});

const withSupervisor = <A, E, R>(
  body: (
    supervisor: PluginWorkerSupervisor.PluginWorkerSupervisor["Service"],
    echo: InstalledEcho,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const echo = yield* installEcho();
    const supervisor = yield* PluginWorkerSupervisor.PluginWorkerSupervisor;
    return yield* body(supervisor, echo);
  }).pipe(
    Effect.provide(
      PluginWorkerSupervisor.layer.pipe(
        Layer.provideMerge(selfInvocationLayer),
        Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
    Effect.scoped,
  );

// A protocol worker without the SDK, for host behaviour the echo fixture cannot provoke.
const RAW_WORKER = `
const NodeChildProcess = require("node:child_process");
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
let buffer = "";
let resolving;
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let index = buffer.indexOf("\\n"); index >= 0; index = buffer.indexOf("\\n")) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    const params = message.params ?? {};
    if (typeof message.id === "string") {
      reply(resolving, "result" in message ? message.result : message.error);
    } else if (message.method === "initialize") {
      if (!params.config.hang) reply(message.id, null);
      else process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "status", params: { state: "running", detail: String(process.pid) } }) + "\\n");
    } else if (message.method === "shutdown") {
      reply(message.id, null);
      process.exit(0);
    } else if (params.operation === "grandchild") {
      const child = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
        detached: true,
        stdio: ["ignore", "ignore", "inherit"],
      });
      child.unref();
      reply(message.id, { pid: child.pid });
    } else if (params.operation === "crash") {
      process.exit(3);
    } else if (params.operation === "context") {
      reply(message.id, params.context);
    } else if (params.operation === "resolve") {
      resolving = message.id;
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "w1", method: params.input.method, params: params.input.params }) + "\\n");
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

const rawWorkerStart = Effect.fn("test.rawWorkerStart")(function* (config: {
  readonly hang?: boolean;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dataDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-plugin-raw-" });
  const entryPath = path.join(dataDir, "raw.cjs");
  yield* fileSystem.writeFileString(entryPath, RAW_WORKER);
  return {
    pluginId: ECHO,
    version: "1.0.0",
    entryPath,
    dataDir,
    config,
    secrets: {},
    prerequisites: [],
    resolveContext,
  } satisfies PluginWorkerSupervisor.PluginWorkerStartInput;
});

const reasonOf = <A>(effect: Effect.Effect<A, { readonly reason: string }>) =>
  Effect.match(effect, { onFailure: (error) => error.reason, onSuccess: () => "succeeded" });

const awaitStatus = (
  supervisor: PluginWorkerSupervisor.PluginWorkerSupervisor["Service"],
  status: string,
) =>
  supervisor.statusChanges.pipe(
    Stream.filter((change) => change.pluginId === ECHO && change.status === status),
    Stream.runHead,
  );

describe("PluginWorkerSupervisor with the packed echo backend", () => {
  it.live("packed backend runs from a state dir outside the repository", () =>
    withSupervisor((supervisor, echo) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        for (let dir = path.dirname(echo.entryPath); ; dir = path.dirname(dir)) {
          expect(yield* fileSystem.exists(path.join(dir, "node_modules"))).toBe(false);
          if (path.dirname(dir) === dir) break;
        }
        yield* supervisor.start(echo.start);
        expect(yield* supervisor.invoke(ECHO, call("ping"))).toEqual({
          message: "ping",
          caller: "ui",
        });
      }),
    ),
  );

  it.live("start reports running and invoke round-trips", () =>
    withSupervisor((supervisor, echo) =>
      Effect.gen(function* () {
        expect(yield* supervisor.status(ECHO)).toEqual({ status: "stopped" });
        yield* supervisor.start(echo.start);
        expect(yield* supervisor.status(ECHO)).toEqual({ status: "running" });
        expect(
          yield* supervisor.invoke(ECHO, {
            operation: "ping",
            input: { message: "hi" },
            caller: "agent",
            context: EMPTY_PLUGIN_CALL_CONTEXT,
          }),
        ).toEqual({ message: "hi", caller: "agent" });
        expect(yield* reasonOf(supervisor.invoke(ECHO, call("missing")))).toBe("unknown-operation");

        const events = yield* supervisor.subscribe(ECHO, "ticks", {}).pipe(
          Stream.tap((event) =>
            event.type === "snapshot" ? supervisor.invoke(ECHO, call("pong")) : Effect.void,
          ),
          Stream.take(2),
          Stream.runCollect,
        );
        expect(events).toEqual([
          { type: "snapshot", items: [{ pongs: 0 }], revision: "0", cursor: "start" },
          { type: "batch", items: [{ pongs: 1 }], revision: "1" },
        ]);

        yield* supervisor.stop(ECHO, "plugin-disabled");
        expect(yield* supervisor.status(ECHO)).toEqual({ status: "stopped" });
        expect(yield* reasonOf(supervisor.invoke(ECHO, call("ping")))).toBe("not-running");
      }),
    ),
  );

  it.live("missing prerequisite yields missing-prerequisite without spawning", () =>
    withSupervisor((supervisor, echo) =>
      Effect.gen(function* () {
        yield* supervisor.start({
          ...echo.start,
          prerequisites: [{ executable: "t3-missing-prerequisite-xyz", hint: "Install it." }],
        });
        const status = yield* supervisor.status(ECHO);
        expect(status.status).toBe("missing-prerequisite");
        expect(status.detail).toContain("t3-missing-prerequisite-xyz");
        expect(status.detail).toContain("Install it.");
        expect(yield* supervisor.logs(ECHO, 10)).toEqual([]);
        expect(yield* reasonOf(supervisor.invoke(ECHO, call("ping")))).toBe("not-running");
      }),
    ),
  );

  it.live("crash moves status to failed and keeps the last 1000 log lines", () =>
    withSupervisor((supervisor, echo) =>
      Effect.gen(function* () {
        yield* supervisor.start(echo.start);
        yield* supervisor.invoke(ECHO, call("log", { lines: 1200 }));
        expect(yield* reasonOf(supervisor.invoke(ECHO, call("crash")))).toBe("worker-failed");
        const failed = yield* awaitStatus(supervisor, "failed");
        expect(Option.getOrThrow(failed).detail).toBe("The plugin worker exited with code 3.");

        const lines = (yield* supervisor.logs(ECHO, 500)).map((entry) => entry.line);
        expect(lines).toHaveLength(500);
        expect(lines.at(-1)).toBe("The plugin worker exited with code 3.");
        expect(lines.at(-2)).toBe("line 1199");
        expect(lines[0]).toBe("line 701");
        expect((yield* supervisor.logs(ECHO, 2)).map((entry) => entry.line)).toEqual([
          "line 1199",
          "The plugin worker exited with code 3.",
        ]);
      }),
    ),
  );

  it.live("stop terminates the captured process group", () =>
    withSupervisor((supervisor, echo) =>
      Effect.gen(function* () {
        yield* supervisor.start(echo.start);
        const { pid } = (yield* supervisor.invoke(ECHO, {
          operation: "spawn_child",
          input: { untracked: true },
          caller: "ui",
          context: EMPTY_PLUGIN_CALL_CONTEXT,
        })) as { pid: number };
        expect(isGone(pid)).toBe(false);
        yield* supervisor.stop(ECHO, "plugin-disabled");
        expect(isGone(pid)).toBe(true);
      }),
    ),
  );

  it.live(
    "worker results over maxPayloadBytes fail with too-large and the worker keeps serving",
    () =>
      withSupervisor((supervisor, echo) =>
        Effect.gen(function* () {
          yield* supervisor.start(echo.start);
          expect(
            yield* reasonOf(
              supervisor.invoke(ECHO, {
                operation: "big",
                input: { bytes: PLUGIN_LIMITS.maxPayloadBytes + 1 },
                caller: "ui",
                context: EMPTY_PLUGIN_CALL_CONTEXT,
              }),
            ),
          ).toBe("too-large");
          expect(
            yield* reasonOf(
              supervisor.invoke(ECHO, {
                operation: "ping",
                input: { message: "x".repeat(PLUGIN_LIMITS.maxPayloadBytes + 1) },
                caller: "ui",
                context: EMPTY_PLUGIN_CALL_CONTEXT,
              }),
            ),
          ).toBe("too-large");
          expect(yield* supervisor.invoke(ECHO, call("ping"))).toEqual({
            message: "ping",
            caller: "ui",
          });
        }),
      ),
  );

  it.live("packed backend materializes its embedded asset under dataDir/runtime", () =>
    withSupervisor((supervisor, echo) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* supervisor.start(echo.start);
        const asset = (yield* supervisor.invoke(ECHO, {
          operation: "asset",
          input: {},
          caller: "ui",
          context: EMPTY_PLUGIN_CALL_CONTEXT,
        })) as { path: string; text: string };
        expect(path.dirname(asset.path)).toBe(path.join(echo.dataDir, "runtime"));
        expect(asset.text).toBe("Hello from the echo plugin.\n");
        expect(yield* fileSystem.readFileString(asset.path)).toBe(asset.text);
      }),
    ),
  );

  it.live("a worker still in initialize refuses calls, and interrupting its start stops it", () =>
    withSupervisor((supervisor) =>
      Effect.gen(function* () {
        const starting = yield* supervisor
          .start(yield* rawWorkerStart({ hang: true }))
          .pipe(Effect.forkChild);
        const reported = Option.getOrThrow(yield* awaitStatus(supervisor, "running"));
        const pid = Number(reported.detail);
        expect(yield* reasonOf(supervisor.invoke(ECHO, call("ping")))).toBe("not-running");
        yield* Fiber.interrupt(starting);
        expect(yield* supervisor.status(ECHO)).toEqual({ status: "stopped" });
        expect(isGone(pid)).toBe(true);
      }),
    ),
  );

  it.live("interrupting start while the worker is spawning stops it", () =>
    withSupervisor((supervisor) =>
      Effect.gen(function* () {
        const starting = yield* supervisor
          .start(yield* rawWorkerStart({ hang: true }))
          .pipe(Effect.forkChild);
        yield* awaitStatus(supervisor, "starting");
        yield* Fiber.interrupt(starting);
        expect(yield* supervisor.status(ECHO)).toEqual({ status: "stopped" });
        expect(yield* reasonOf(supervisor.invoke(ECHO, call("ping")))).toBe("not-running");
      }),
    ),
  );

  it.live("a crash is reported even when an escaped grandchild holds stderr open", () =>
    withSupervisor((supervisor) =>
      Effect.gen(function* () {
        yield* supervisor.start(yield* rawWorkerStart({}));
        const { pid } = (yield* supervisor.invoke(ECHO, {
          operation: "grandchild",
          input: {},
          caller: "ui",
          context: EMPTY_PLUGIN_CALL_CONTEXT,
        })) as { pid: number };
        yield* Effect.addFinalizer(() => Effect.sync(() => process.kill(pid, "SIGKILL")));
        expect(yield* reasonOf(supervisor.invoke(ECHO, call("crash")))).toBe("worker-failed");
        const failed = yield* awaitStatus(supervisor, "failed");
        expect(Option.getOrThrow(failed).detail).toBe("The plugin worker exited with code 3.");
        expect(isGone(pid)).toBe(false);
      }),
    ),
  );

  it.live("invoke sends the caller context and the host answers t3/context.resolve", () =>
    withSupervisor((supervisor) =>
      Effect.gen(function* () {
        yield* supervisor.start(yield* rawWorkerStart({}));
        expect(
          yield* supervisor.invoke(ECHO, { ...call("context"), context: CALL_CONTEXT }),
        ).toEqual(CALL_CONTEXT);
        const resolve = (method: string, params: unknown) =>
          supervisor.invoke(ECHO, call("resolve", { method, params }));
        expect(yield* resolve("t3/context.resolve", { projectId: KNOWN_PROJECT })).toEqual({
          projectId: KNOWN_PROJECT,
          thread: null,
        });
        expect(yield* resolve("t3/context.resolve", { threadId: "thread-unknown" })).toBeNull();
        expect(
          yield* resolve("t3/context.resolve", { threadId: "t", projectId: KNOWN_PROJECT }),
        ).toMatchObject({ code: -32602 });
        expect(yield* resolve("t3/unknown", {})).toMatchObject({ code: -32601 });
      }),
    ),
  );

  it.live("worker exits and stops its children when the host pipe closes", () =>
    Effect.gen(function* () {
      const echo = yield* installEcho();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const stdin = yield* Queue.unbounded<string, Cause.Done>();
      const handle = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [BIN_PATH, "plugin-worker", echo.entryPath], {
          cwd: echo.dataDir,
          // Without a process group the host cannot reach the child; only the worker can stop it.
          detached: false,
          stdin: { stream: Stream.encodeText(Stream.fromQueue(stdin)) },
          stdout: "pipe",
          stderr: "ignore",
        }),
      );
      const connectionScope = yield* Scope.make();
      const connection = yield* PluginWorkerSupervisor.makeWorkerConnection(
        handle.stdout,
        stdin,
      ).pipe(Scope.provide(connectionScope));
      yield* connection.request("initialize", {
        apiVersion: 1,
        pluginId: ECHO,
        version: echo.start.version,
        dataDir: echo.dataDir,
        config: {},
        secrets: {},
      });
      const { pid } = (yield* connection.request("invoke", {
        operation: "spawn_child",
        input: {},
        caller: "ui",
      })) as { pid: number };
      expect(isGone(pid)).toBe(false);

      // The worker answers into a pipe whose reader is gone, so its writes fail with EPIPE.
      yield* Queue.offer(
        stdin,
        `${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "invoke", params: { operation: "big", input: { bytes: 200_000 }, caller: "ui" } })}\n`,
      );
      yield* Scope.close(connectionScope, Exit.void);
      yield* Queue.end(stdin);
      expect(yield* handle.exitCode).toBe(0);
      expect(isGone(pid)).toBe(true);
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );
});

const memoryConnectionWith = Effect.fn("test.memoryConnection")(function* (
  handlers: PluginWorkerSupervisor.WorkerConnectionHandlers = {},
) {
  const input = yield* Queue.unbounded<Uint8Array>();
  const output = yield* Queue.unbounded<string>();
  const connection = yield* PluginWorkerSupervisor.makeWorkerConnection(
    Stream.fromQueue(input),
    output,
    handlers,
  );
  const feedText = (text: string) => Queue.offer(input, encoder.encode(`${text}\n`));
  return {
    connection,
    feed: (message: unknown) => feedText(JSON.stringify(message)),
    feedText,
    sent: Effect.map(Queue.take(output), (line) => JSON.parse(line) as Record<string, any>),
  };
});
const memoryConnection = memoryConnectionWith();

describe("makeWorkerConnection", () => {
  it.effect(
    "invoke times out with timed-out after 30 s, sends cancel, and drops the late response",
    () =>
      Effect.gen(function* () {
        const { connection, feed, sent } = yield* memoryConnection;
        const slow = yield* connection
          .request("invoke", { operation: "slow", input: null, caller: "ui" })
          .pipe(reasonOf, Effect.forkChild);
        const request = yield* sent;
        expect(request).toMatchObject({ method: "invoke", params: { operation: "slow" } });

        yield* TestClock.adjust("30 seconds");
        expect(yield* Fiber.join(slow)).toBe("timed-out");
        expect(yield* sent).toEqual({
          jsonrpc: "2.0",
          method: "cancel",
          params: { id: request.id },
        });

        yield* feed({ jsonrpc: "2.0", id: request.id, result: "late" });
        const next = yield* connection
          .request("invoke", { operation: "ping", input: null, caller: "ui" })
          .pipe(Effect.forkChild);
        const nextRequest = yield* sent;
        expect(nextRequest.id).not.toBe(request.id);
        yield* feed({ jsonrpc: "2.0", id: nextRequest.id, result: "fresh" });
        expect(yield* Fiber.join(next)).toBe("fresh");
      }).pipe(Effect.scoped),
  );

  it.effect("refuses worker requests past maxPendingRequests until one is answered", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const { feed, sent } = yield* memoryConnectionWith({
        resolveContext: () => Deferred.await(release).pipe(Effect.as(null)),
      });
      const resolveRequest = (id: string) =>
        feed({ jsonrpc: "2.0", id, method: "t3/context.resolve", params: { projectId: "p" } });
      for (let index = 0; index <= PLUGIN_LIMITS.maxPendingRequests; index += 1) {
        yield* resolveRequest(`w${index}`);
      }
      expect(yield* sent).toEqual({
        jsonrpc: "2.0",
        id: `w${PLUGIN_LIMITS.maxPendingRequests}`,
        error: { code: -32000, message: "Too many requests in flight." },
      });
      yield* Deferred.succeed(release, undefined);
      for (let index = 0; index < PLUGIN_LIMITS.maxPendingRequests; index += 1) {
        expect(yield* sent).toMatchObject({ result: null });
      }
      yield* resolveRequest("w-next");
      expect(yield* sent).toEqual({ jsonrpc: "2.0", id: "w-next", result: null });
    }).pipe(Effect.scoped),
  );

  it.effect("interrupting invoke sends cancel for that request id", () =>
    Effect.gen(function* () {
      const { connection, sent } = yield* memoryConnection;
      const call = yield* connection
        .request("invoke", { operation: "slow", input: null, caller: "agent" })
        .pipe(Effect.forkChild);
      const request = yield* sent;
      yield* Fiber.interrupt(call);
      expect(yield* sent).toEqual({ jsonrpc: "2.0", method: "cancel", params: { id: request.id } });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "worker lines over maxMessageBytes fail with too-large and the worker keeps serving",
    () =>
      Effect.gen(function* () {
        const { connection, feed, feedText, sent } = yield* memoryConnection;
        const big = yield* connection
          .request("invoke", { operation: "big", input: null, caller: "ui" })
          .pipe(reasonOf, Effect.forkChild);
        const request = yield* sent;
        yield* feedText(
          `{"jsonrpc":"2.0","id":${request.id},"result":"${"x".repeat(PLUGIN_LIMITS.maxMessageBytes)}"}`,
        );
        expect(yield* Fiber.join(big)).toBe("too-large");

        const pendingCall = yield* connection
          .request("invoke", { operation: "slow", input: null, caller: "ui" })
          .pipe(Effect.forkChild);
        const pendingRequest = yield* sent;
        yield* feedText(
          `{"jsonrpc":"2.0","method":"event","params":{"subscriptionId":"other","event":{"id":${pendingRequest.id},"blob":"${"x".repeat(PLUGIN_LIMITS.maxMessageBytes)}"}}}`,
        );
        yield* feed({ jsonrpc: "2.0", id: pendingRequest.id, result: "kept" });
        expect(yield* Fiber.join(pendingCall)).toBe("kept");

        const next = yield* connection
          .request("invoke", { operation: "ping", input: null, caller: "ui" })
          .pipe(Effect.forkChild);
        const nextRequest = yield* sent;
        yield* feed({ jsonrpc: "2.0", id: nextRequest.id, result: { ok: true } });
        expect(yield* Fiber.join(next)).toEqual({ ok: true });
      }).pipe(Effect.scoped),
  );

  it.effect("a batch before the first snapshot closes the subscription with protocol-error", () =>
    Effect.gen(function* () {
      const { connection, feed, sent } = yield* memoryConnection;
      const events = yield* connection
        .subscribe("ticks", {})
        .pipe(Stream.runCollect, Effect.forkChild);
      const subscribe = yield* sent;
      expect(subscribe).toMatchObject({ method: "subscribe", params: { topic: "ticks" } });
      const { subscriptionId } = subscribe.params;
      yield* feed({ jsonrpc: "2.0", id: subscribe.id, result: null });
      yield* feed({
        jsonrpc: "2.0",
        method: "event",
        params: { subscriptionId, event: { type: "batch", items: [1], revision: "1" } },
      });
      expect(yield* Fiber.join(events)).toEqual([
        { type: "closed", reason: "protocol-error" },
      ] satisfies Array<PluginSubscriptionEvent>);
      expect(yield* sent).toMatchObject({ method: "unsubscribe", params: { subscriptionId } });
    }).pipe(Effect.scoped),
  );

  it.effect("a burst of small batches in one read does not resync a keeping-up consumer", () =>
    Effect.gen(function* () {
      const { connection, feed, feedText, sent } = yield* memoryConnection;
      const events = yield* connection
        .subscribe("ticks", {})
        .pipe(Stream.runCollect, Effect.forkChild);
      const subscribe = yield* sent;
      const { subscriptionId } = subscribe.params;
      yield* feed({ jsonrpc: "2.0", id: subscribe.id, result: null });
      const event = (value: PluginSubscriptionEvent) =>
        JSON.stringify({
          jsonrpc: "2.0",
          method: "event",
          params: { subscriptionId, event: value },
        });
      const batches = Array.from({ length: 100 }, (_, index) => ({
        type: "batch" as const,
        items: [{ id: `${index}`, path: "/a/b/c?x=1", status: 200 }],
        revision: `${index}`,
      }));
      yield* feedText(
        [
          event({ type: "snapshot", items: [], revision: "s", cursor: null }),
          ...batches.map(event),
          event({ type: "closed", reason: "worker-failed" }),
        ].join("\n"),
      );
      expect(yield* Fiber.join(events)).toEqual([
        { type: "snapshot", items: [], revision: "s", cursor: null },
        ...batches,
        { type: "closed", reason: "worker-failed" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("a subscription that falls behind resyncs on a fresh worker subscription", () =>
    Effect.gen(function* () {
      const { connection, feed, sent } = yield* memoryConnection;
      const snapshot = (revision: string) => ({
        type: "snapshot",
        items: [],
        revision,
        cursor: null,
      });
      const pull = yield* connection.subscribe("ticks", {}).pipe(Stream.toPull);
      const takeEvent = Effect.map(pull, (chunk) => chunk[0]);
      const first = yield* takeEvent.pipe(Effect.forkChild);
      const subscribe = yield* sent;
      const oldId = subscribe.params.subscriptionId;
      yield* feed({ jsonrpc: "2.0", id: subscribe.id, result: null });
      yield* feed({
        jsonrpc: "2.0",
        method: "event",
        params: { subscriptionId: oldId, event: snapshot("0") },
      });
      expect(yield* Fiber.join(first)).toEqual(snapshot("0"));

      const padding = "x".repeat(16 * 1024);
      const batchAt = (index: number) => ({
        type: "batch",
        items: [index, padding],
        revision: `${index}`,
      });
      for (let index = 0; index < 400; index += 1) {
        yield* feed({
          jsonrpc: "2.0",
          method: "event",
          params: { subscriptionId: oldId, event: batchAt(index) },
        });
      }
      expect(yield* sent).toMatchObject({
        method: "unsubscribe",
        params: { subscriptionId: oldId },
      });
      const delivered: Array<PluginSubscriptionEvent> = [];
      while (delivered.at(-1)?.type !== "resync") delivered.push(...(yield* pull));
      expect(delivered.slice(0, -1)).toEqual(
        delivered.slice(0, -1).map((_, index) => batchAt(index)),
      );
      const resubscribe = yield* sent;
      expect(resubscribe).toMatchObject({ method: "subscribe", params: { topic: "ticks" } });
      expect(resubscribe.params.subscriptionId).not.toBe(oldId);
    }).pipe(Effect.scoped),
  );
});
