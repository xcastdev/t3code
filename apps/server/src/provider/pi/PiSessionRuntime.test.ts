// @effect-diagnostics nodeBuiltinImport:off - Disposable Linux fixtures verify real process ownership and byte IPC.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import {
  preallocatePiManagedProcess,
  PiManagedProcessError,
  type PiManagedLaunch,
} from "./PiManagedProcess.ts";
import {
  makePiSessionRuntime,
  PiSessionRuntimeError,
  type PiSessionRuntimeOptions,
  type PiSessionTerminal,
} from "./PiSessionRuntime.ts";
import type { PiModelRequestSettlement } from "./PiModelBroker.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const model = "inclusionai/ling-3.1-flash:free";
const parameters = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};
const tool = {
  type: "function" as const,
  function: { name: "echo_assignment", description: "Echo assignment", parameters },
};
const nativeStream = () =>
  [
    {
      model: "inclusionai/ling-3.1-flash",
      choices: [{ index: 0, delta: { content: "result" }, finish_reason: null }],
    },
    { model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  ]
    .map((entry) => `data: ${json(entry)}\n\n`)
    .join("") + "data: [DONE]\n\n";
function waitForSignal(promise: Promise<void>, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(new Error("fixture request canceled"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

function fixture(
  launch: PiManagedLaunch,
  allocation?: PiSessionRuntimeOptions["persistence"]["allocation"],
  mode = "prompt",
) {
  const events: string[] = [];
  const terminals: PiSessionTerminal[] = [];
  const settlements: PiModelRequestSettlement[] = [];
  const controls: Array<{ controlId: number; status: string }> = [];
  const schema = json(parameters);
  const withTool = mode === "tool" || mode === "local-tool";
  const options: PiSessionRuntimeOptions = {
    identity: { workerId: "worker", generation: 7 },
    operation: {
      operationId: "operation",
      operationKind: mode === "initialize" ? "initialize" : "prompt",
    },
    bootstrap: {
      type: "bootstrap",
      executionMode: "managed",
      expectedCwd: "/workspace",
      native: null,
      context: { transferId: "context", totalBytes: 7 },
      prompt: mode === "initialize" ? null : { transferId: "prompt", totalBytes: 10 },
      model: {
        provider: "command-code",
        modelId: model,
        api: "openai-completions",
        contextWindow: 20_000,
        maxTokens: 512,
        reasoning: false,
      },
      allowedTools: withTool
        ? [
            {
              name: tool.function.name,
              description: tool.function.description,
              execution: mode === "local-tool" ? "local" : "bridge",
              inputSchema: { transferId: "schema", totalBytes: Buffer.byteLength(schema) },
            },
          ]
        : [],
    },
    transferTexts: [
      { transferId: "context", text: "context" },
      ...(mode === "initialize" ? [] : [{ transferId: "prompt", text: "assignment" }]),
      ...(withTool ? [{ transferId: "schema", text: schema }] : []),
    ],
    launch,
    persistence: {
      get allocation() {
        if (!allocation)
          throw new Error("Unexpected allocation access before configuration rejection");
        return allocation;
      },
      claimActivation: () =>
        Effect.sync(() => {
          events.push("activation");
        }),
      beforeStart: (owner) =>
        Effect.promise(async () => {
          events.push("owner");
          const path = process.env.PI_SESSION_RUNTIME_EVIDENCE_DIR;
          if (path) {
            await NodeFSP.mkdir(path, { recursive: true });
            await NodeFSP.writeFile(NodePath.join(path, owner.unit + ".owner.json"), json(owner));
          }
        }),
    },
    broker: {
      workerId: "worker",
      generation: 7,
      operationId: "operation",
      routeId: "ling-free",
      provider: "command-code",
      model,
      endpoint: "https://api.commandcode.ai/provider/v1/chat/completions",
      acceptedReportedModels: [model, "inclusionai/ling-3.1-flash"],
      tools: withTool ? [tool] : [],
      maxInputTokens: 20_000,
      maxOutputTokens: 512,
      deadlineMs: 5000,
      authorizeCurrent: async (phase) => {
        events.push(phase);
      },
      getCredential: async () => "synthetic-parent-secret",
      reserveRequest: async (r) => {
        events.push("reservation");
        return { reservationId: `reserved_${r.requestId}` };
      },
      settleRequest: async (s) => {
        settlements.push(s);
        events.push("accounted");
        return { accountingReceiptId: `accounted_${s.requestId}` };
      },
      transport: async () => {
        events.push("transport");
        return new Response(nativeStream(), { headers: { "content-type": "text/event-stream" } });
      },
    },
    toolCapabilities: withTool
      ? [
          {
            name: tool.function.name,
            execution: mode === "local-tool" ? "local" : "bridge",
            capability: "projectWork.read",
          },
        ]
      : [],
    deadlineMs: 5000,
    cleanupDeadlineMs: 3000,
    authorizeCurrent: async (request) => {
      events.push(request.phase);
    },
    executeBridgeTool: async (_call, value) => {
      events.push("bridge");
      expect(value.arguments.text).toBe("assignment");
      return { kind: "text", text: "bridge result" };
    },
    persistNative: async () => {
      events.push("native");
    },
    onSdkEvent: async (frame) => {
      events.push(
        frame.message.type === "sdk-event" ? frame.message.event.type : frame.message.type,
      );
    },
    persistControl: async (receipt) => {
      controls.push(receipt);
    },
    persistTerminal: async (terminal) => {
      terminals.push(terminal);
      events.push("terminal");
      const path = process.env.PI_SESSION_RUNTIME_EVIDENCE_DIR;
      if (path && terminal.drain)
        await NodeFSP.writeFile(
          NodePath.join(path, terminal.drain.unit + ".drain.json"),
          json({ ...terminal, events }),
        );
    },
  };
  return { options, events, terminals, settlements, controls };
}

// Portable checks validate configuration without launching a systemd service.
describe("private session configuration", () => {
  const portable = () =>
    fixture({
      workspaceRoot: "/unused",
      protectedRoots: ["/protected"],
      runtimeFiles: [],
      argv: [],
      memoryBytes: 536870912,
      runtimeSeconds: 30,
    });
  effectIt.effect("requires exact transferred byte lengths before process effects", () =>
    Effect.gen(function* () {
      const f = portable();
      const error = yield* makePiSessionRuntime({
        ...f.options,
        transferTexts: [
          { transferId: "context", text: "é" },
          { transferId: "prompt", text: "assignment" },
        ],
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "TRANSFER_CONFIGURATION" });
      expect(f.events).toEqual([]);
    }),
  );
  for (const field of ["workerId", "generation", "operationId", "model"] as const)
    effectIt.effect(`rejects incongruent broker ${field} before launch`, () =>
      Effect.gen(function* () {
        const f = portable();
        const broker = { ...f.options.broker, [field]: field === "generation" ? 8 : "other" };
        const error = yield* makePiSessionRuntime({ ...f.options, broker }).pipe(Effect.flip);
        expect(error).toMatchObject({ code: "BROKER_CONFIGURATION" });
        expect(f.events).toEqual([]);
      }),
    );
});

describe.runIf(process.env.PI_SESSION_RUNTIME_LINUX_GATE === "1")(
  "actual Linux private session",
  () => {
    const check = (
      name: string,
      body: (
        f: ReturnType<typeof fixture>,
        scratch: string,
      ) => Effect.Effect<
        void,
        PiSessionRuntimeError | PiManagedProcessError,
        NodeServices.NodeServices | Scope.Scope
      >,
      mode = "prompt",
    ) =>
      effectIt.live(name, () =>
        Effect.scoped(
          Effect.gen(function* () {
            const scratch = yield* Effect.promise(() =>
              NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-session-runtime-")),
            );
            yield* Effect.addFinalizer(() =>
              Effect.promise(() => NodeFSP.rm(scratch, { recursive: true, force: true })),
            );
            yield* Effect.promise(() =>
              Promise.all(
                ["workspace", "protected"].map((entry) =>
                  NodeFSP.mkdir(NodePath.join(scratch, entry)),
                ),
              ),
            );
            const fixturePath = NodeURL.fileURLToPath(
              new URL("./fixtures/p7-session-runtime-child.mjs", import.meta.url),
            );
            const sourceNode = yield* Effect.promise(() =>
              NodeFSP.realpath(
                process.env.PI_SESSION_RUNTIME_NODE ??
                  (() => {
                    throw new Error("Explicit Linux fixture Node binary required");
                  })(),
              ),
            );
            const launch: PiManagedLaunch = {
              workspaceRoot: NodePath.join(scratch, "workspace"),
              workspaceAccess: "readwrite",
              protectedRoots: [NodePath.join(scratch, "protected")],
              runtimeFiles: [
                { source: sourceNode, target: "/runtime/node" },
                { source: fixturePath, target: "/runtime/child.mjs" },
                ...[
                  "/lib64/ld-linux-x86-64.so.2",
                  "/usr/lib/libgcc_s.so.1",
                  "/usr/lib/libstdc++.so.6",
                  "/usr/lib/librt.so.1",
                  "/usr/lib/libpthread.so.0",
                  "/usr/lib/libm.so.6",
                  "/usr/lib/libdl.so.2",
                  "/usr/lib/libc.so.6",
                ].map((source) => ({ source, target: source })),
              ],
              argv: ["/runtime/node", "/runtime/child.mjs", mode],
              memoryBytes: 536870912,
              runtimeSeconds: 30,
            };
            const allocation = yield* preallocatePiManagedProcess(launch);
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const observed = ChildProcessSpawner.make((command) =>
              spawner.spawn(command).pipe(
                Effect.tap((handle) =>
                  Effect.promise(async () => {
                    const directory = process.env.PI_SESSION_RUNTIME_EVIDENCE_DIR;
                    if (
                      !directory ||
                      command._tag !== "StandardCommand" ||
                      command.command !== "/usr/bin/systemd-run"
                    )
                      return;
                    const unit = command.args.find((arg) => arg.startsWith("--unit="))!.slice(7);
                    await NodeFSP.mkdir(directory, { recursive: true });
                    await NodeFSP.writeFile(
                      NodePath.join(directory, unit + ".launch.json"),
                      json({ unit, launcherPid: Number(handle.pid) }),
                    );
                  }),
                ),
              ),
            );
            yield* body(fixture(launch, allocation, mode), scratch).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed),
            );
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    for (const mode of ["prompt", "initialize", "tool", "local-tool", "descendant"])
      check(
        `joins actual ${mode} bytes, accounting, native persistence and process drains`,
        (f) =>
          Effect.gen(function* () {
            const runtime = yield* makePiSessionRuntime(f.options);
            const result = yield* runtime.run();
            expect(result.outcome).toBe("success");
            expect(result.native?.persisted).toBe(true);
            expect(result.drain?.kernel).toBe("removed");
            expect(f.events.indexOf("owner")).toBeLessThan(f.events.indexOf("beforeStart"));
            if (mode !== "initialize") {
              expect(result.accountingReceipts).toHaveLength(1);
              expect(f.events.indexOf("accounted")).toBeLessThan(f.events.indexOf("native"));
            }
            if (mode === "tool")
              expect(f.events.indexOf("beforeToolInvoke")).toBeLessThan(f.events.indexOf("bridge"));
            const duplicate = yield* runtime.run().pipe(Effect.exit);
            expect(duplicate._tag).toBe("Failure");
            if (duplicate._tag === "Failure")
              expect(Cause.squash(duplicate.cause)).toMatchObject({
                code: "RUN_ALREADY_ATTEMPTED",
              });
            expect(f.events.filter((event) => event === "activation")).toHaveLength(1);
          }),
        mode,
      );
    for (const mode of [
      "malformed",
      "early-exit",
      "forged-generation",
      "forged-operation",
      "forged-sequence",
      "forged-native",
    ])
      check(
        `fails closed on actual ${mode}`,
        (f) =>
          Effect.gen(function* () {
            const runtime = yield* makePiSessionRuntime(f.options);
            yield* runtime.run().pipe(Effect.exit);
            expect(f.terminals).toHaveLength(1);
            expect(f.terminals[0]?.outcome).not.toBe("success");
            expect(f.terminals[0]?.drain?.kernel).toBe("removed");
          }),
        mode,
      );
    for (const denied of [
      "beforeAcquire",
      "beforeStart",
      "beforeTool",
      "beforeToolInvoke",
      "beforeToolReturn",
    ] as const)
      check(
        `current denial at ${denied} prevents its protected side effect`,
        (f, scratch) =>
          Effect.gen(function* () {
            const runtime = yield* makePiSessionRuntime({
              ...f.options,
              authorizeCurrent: async (request) => {
                f.events.push(request.phase);
                if (request.phase === denied) throw new Error("stale approval");
              },
            });
            yield* runtime.run().pipe(Effect.exit);
            expect(f.terminals[0]?.outcome).not.toBe("success");
            if (denied === "beforeAcquire") expect(f.events).not.toContain("activation");
            if (denied === "beforeStart") expect(f.events).not.toContain("transport");
            if (denied === "beforeTool" || denied === "beforeToolInvoke")
              expect(f.events).not.toContain("bridge");
            yield* Effect.promise(() =>
              expect(
                NodeFSP.stat(NodePath.join(scratch, "workspace", "local-tool")),
              ).rejects.toMatchObject({ code: "ENOENT" }),
            );
          }),
        "tool",
      );
    check("owner persistence failure never starts the worker", (f) =>
      Effect.gen(function* () {
        const runtime = yield* makePiSessionRuntime({
          ...f.options,
          persistence: {
            ...f.options.persistence,
            beforeStart: (owner) =>
              f.options.persistence
                .beforeStart(owner)
                .pipe(
                  Effect.andThen(
                    Effect.fail(
                      new PiManagedProcessError({ phase: "startup", message: "SQL commit failed" }),
                    ),
                  ),
                ),
          },
        });
        yield* runtime.run().pipe(Effect.exit);
        expect(f.events).not.toContain("beforeStart");
        expect(f.events).not.toContain("transport");
        expect(f.terminals[0]?.outcome).toBe("quarantine");
      }),
    );
    check(
      "blocked ACK cancellation joins the actual reader and owned process",
      (f) =>
        Effect.gen(function* () {
          const forwarding = yield* Deferred.make<void>();
          const runtime = yield* makePiSessionRuntime({
            ...f.options,
            broker: {
              ...f.options.broker,
              authorizeCurrent: async (phase) => {
                if (phase === "beforeForward") Deferred.doneUnsafe(forwarding, Effect.void);
              },
            },
          });
          const fiber = yield* runtime.run().pipe(Effect.forkChild);
          yield* Deferred.await(forwarding);
          yield* Fiber.interrupt(fiber);
          expect(f.terminals[0]?.outcome).toBe("canceled");
          expect(f.terminals[0]?.drain?.kernel).toBe("removed");
          expect(f.settlements.at(-1)?.outcome).toBe("failed");
        }),
      "blocked-ack",
    );
    for (const kind of ["steer", "follow-up"] as const)
      check(`concurrent reader persists exact ${kind} receipt while transport awaits`, (f) =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = Promise.withResolvers<void>();
          const runtime = yield* makePiSessionRuntime({
            ...f.options,
            broker: {
              ...f.options.broker,
              transport: async (endpoint, init) => {
                Deferred.doneUnsafe(entered, Effect.void);
                await waitForSignal(release.promise, init.signal);
                return f.options.broker.transport(endpoint, init);
              },
            },
          });
          const fiber = yield* runtime.run().pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* runtime.control({ type: "control", controlId: 3, kind, text: "bounded steering" });
          expect(f.controls).toMatchObject([{ controlId: 3, status: "received" }]);
          expect(f.terminals).toEqual([]);
          release.resolve();
          yield* Fiber.join(fiber);
          expect(f.events.filter((event) => event === "transport")).toHaveLength(1);
        }),
      );
    check("interrupt waits its exact receipt, cancels HTTP and prevents success", (f) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const hold = Promise.withResolvers<void>();
        const runtime = yield* makePiSessionRuntime({
          ...f.options,
          broker: {
            ...f.options.broker,
            transport: async (_endpoint, init) => {
              Deferred.doneUnsafe(entered, Effect.void);
              await waitForSignal(hold.promise, init.signal);
              return new Response(nativeStream());
            },
          },
        });
        const fiber = yield* runtime.run().pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* runtime.interrupt(7);
        yield* Fiber.await(fiber);
        expect(f.controls).toMatchObject([{ controlId: 7, status: "received" }]);
        expect(f.terminals[0]?.outcome).toBe("canceled");
        expect(f.terminals[0]?.drain?.kernel).toBe("removed");
      }),
    );
    check(
      "INVALID_INPUT retains unresolved original control identity",
      (f) =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const hold = Promise.withResolvers<void>();
          const runtime = yield* makePiSessionRuntime({
            ...f.options,
            broker: {
              ...f.options.broker,
              transport: async (_endpoint, init) => {
                Deferred.doneUnsafe(entered, Effect.void);
                await waitForSignal(hold.promise, init.signal);
                return new Response(nativeStream());
              },
            },
          });
          const fiber = yield* runtime.run().pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* runtime
            .control({ type: "control", controlId: 17, kind: "follow-up", text: "original" })
            .pipe(Effect.exit);
          yield* Fiber.await(fiber);
          expect(f.controls).toMatchObject([{ controlId: 17, status: "unresolved" }]);
          expect(f.terminals[0]?.outcome).toBe("failed");
        }),
      "unresolved-control",
    );
    check("a late control keeps its original ID unresolved", (f) =>
      Effect.gen(function* () {
        const runtime = yield* makePiSessionRuntime(f.options);
        yield* runtime.run();
        yield* runtime
          .control({ type: "control", controlId: 23, kind: "steer", text: "late" })
          .pipe(Effect.exit);
        expect(f.controls).toMatchObject([{ controlId: 23, status: "unresolved" }]);
        expect(f.events.filter((event) => event === "transport")).toHaveLength(1);
      }),
    );
    for (const phase of [
      "beforeReserve",
      "beforeTransport",
      "beforeForward",
      "beforeReturn",
    ] as const)
      check(`broker current denial at ${phase} prevents successful terminal`, (f) =>
        Effect.gen(function* () {
          const runtime = yield* makePiSessionRuntime({
            ...f.options,
            broker: {
              ...f.options.broker,
              authorizeCurrent: async (current) => {
                if (phase === current) throw new Error("stale authority");
              },
            },
          });
          yield* runtime.run().pipe(Effect.exit);
          expect(f.terminals[0]?.outcome).toBe("failed");
          expect(f.terminals[0]?.drain?.kernel).toBe("removed");
          if (phase === "beforeReserve" || phase === "beforeTransport")
            expect(f.events).not.toContain("transport");
          if (phase === "beforeReturn")
            expect(f.settlements.map((item) => item.outcome)).toEqual(["reported", "failed"]);
        }),
      );
    check("missing accounting receipt cannot emit parent end or persist native success", (f) =>
      Effect.gen(function* () {
        const runtime = yield* makePiSessionRuntime({
          ...f.options,
          broker: {
            ...f.options.broker,
            settleRequest: async () => {
              throw new Error("SQL accounting failed");
            },
          },
        });
        yield* runtime.run().pipe(Effect.exit);
        expect(f.events).not.toContain("native");
        expect(f.terminals[0]?.outcome).toBe("failed");
      }),
    );
    check("failed native persistence cannot complete an accepted native frame", (f) =>
      Effect.gen(function* () {
        const runtime = yield* makePiSessionRuntime({
          ...f.options,
          persistNative: async () => {
            throw new Error("SQL native commit failed");
          },
        });
        yield* runtime.run().pipe(Effect.exit);
        expect(f.terminals[0]?.outcome).toBe("failed");
        expect(f.terminals[0]?.native).toBeNull();
      }),
    );
    check("callback ignoring cancellation quarantines despite confirmed process drain", (f) =>
      Effect.gen(function* () {
        const held = Promise.withResolvers<void>();
        const runtime = yield* makePiSessionRuntime({
          ...f.options,
          deadlineMs: 1000,
          cleanupDeadlineMs: 100,
          persistNative: () => held.promise,
        });
        yield* runtime.run().pipe(Effect.exit);
        expect(f.terminals[0]?.outcome).toBe("quarantine");
        expect(f.terminals[0]?.drain?.kernel).toBe("removed");
        held.resolve();
        yield* Effect.promise(() => held.promise);
      }),
    );

    check(
      "actual loopback HTTP stream drains before native success and terminal persistence",
      (f) =>
        Effect.gen(function* () {
          let requests = 0;
          const server = NodeHttp.createServer((request, response) => {
            requests++;
            request.resume();
            response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
            response.end(nativeStream());
          });
          yield* Effect.promise(
            () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
          );
          yield* Effect.addFinalizer(() =>
            Effect.promise(
              () =>
                new Promise<void>((resolve, reject) =>
                  server.close((error) => (error ? reject(error) : resolve())),
                ),
            ),
          );
          const address = server.address();
          if (!address || typeof address === "string")
            throw new Error("loopback fixture address required");
          const runtime = yield* makePiSessionRuntime({
            ...f.options,
            broker: {
              ...f.options.broker,
              transport: (_endpoint, init) =>
                new Promise<Response>((resolve, reject) => {
                  const request = NodeHttp.request(
                    {
                      hostname: "127.0.0.1",
                      port: address.port,
                      path: "/synthetic",
                      method: "POST",
                      agent: false,
                      signal: init.signal,
                      headers: init.headers,
                    },
                    (incoming) => {
                      const stream = new ReadableStream<Uint8Array>({
                        start(controller) {
                          incoming.on("data", (chunk: Buffer) => controller.enqueue(chunk));
                          incoming.on("end", () => controller.close());
                          incoming.on("error", (error: Error) => controller.error(error));
                        },
                        cancel() {
                          incoming.destroy();
                        },
                      });
                      resolve(
                        new Response(stream, {
                          status: incoming.statusCode ?? 500,
                          headers: { "content-type": "text/event-stream" },
                        }),
                      );
                    },
                  );
                  request.on("error", reject);
                  request.end(init.body);
                }),
            },
          });
          const result = yield* runtime.run();
          expect(result.outcome).toBe("success");
          expect(requests).toBe(1);
          const connections = yield* Effect.promise(
            () =>
              new Promise<number>((resolve, reject) =>
                server.getConnections((error, count) => (error ? reject(error) : resolve(count))),
              ),
          );
          expect(connections).toBe(0);
        }),
    );
  },
);
