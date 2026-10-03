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
import type { PiWorkerFrame } from "./PiWorkerProtocol.ts";

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
  const launcherExited = Promise.withResolvers<number>();
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
  return { options, events, terminals, settlements, controls, launcherExited };
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
  effectIt.effect("rejects a present non-function worker observer before launch", () =>
    Effect.gen(function* () {
      const f = portable();
      const options = { ...f.options };
      Object.defineProperty(options, "onWorkerFrame", { value: true });
      const error = yield* makePiSessionRuntime(options).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "CALLBACK_CONFIGURATION" });
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
      exitingCode?: number,
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
            let fixturePath = NodeURL.fileURLToPath(
              new URL("./fixtures/p7-session-runtime-child.mjs", import.meta.url),
            );
            if (exitingCode !== undefined) {
              const source = yield* Effect.promise(() => NodeFSP.readFile(fixturePath, "utf8"));
              const closing = source.replace(
                'send({ type: "initialized", native: native(null, true) });',
                `send({ type: "initialized", native: native(null, true) });
                 process.stdout.write("", () => process.exit(${exitingCode}));`,
              );
              fixturePath = NodePath.join(scratch, "exiting-child.mjs");
              yield* Effect.promise(() => NodeFSP.writeFile(fixturePath, closing));
            }
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
            const f = fixture(launch, allocation, mode);
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
                Effect.map((handle) =>
                  command._tag !== "StandardCommand" || command.command !== "/usr/bin/systemd-run"
                    ? handle
                    : ChildProcessSpawner.makeHandle({
                        ...handle,
                        exitCode: handle.exitCode.pipe(
                          Effect.tap((code) =>
                            Effect.sync(() => f.launcherExited.resolve(Number(code))),
                          ),
                        ),
                      }),
                ),
              ),
            );
            yield* body(f, scratch).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed),
            );
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    for (const condition of ["success", "nonzero", "native-failed", "canceled"] as const)
      check(
        `EOF repair verifies actual exiting initialized child ${condition}`,
        (f) =>
          Effect.gen(function* () {
            const release = Promise.withResolvers<void>();
            const runtime = yield* makePiSessionRuntime({
              ...f.options,
              onWorkerFrame: async (frame, signal) => {
                if (frame.message.type === "initialized")
                  await waitForSignal(release.promise, signal);
              },
              persistNative: async (frame, signal) => {
                if (condition === "native-failed") throw Error("native callback rejected");
                await f.options.persistNative(frame, signal);
              },
            });
            const running = yield* Effect.forkChild(runtime.run().pipe(Effect.exit));
            expect(yield* Effect.promise(() => f.launcherExited.promise)).toBe(0);
            if (condition === "canceled") {
              yield* Fiber.interrupt(running);
              const interrupted = yield* Fiber.await(running);
              expect(interrupted._tag === "Failure" || interrupted.value._tag === "Failure").toBe(
                true,
              );
            } else {
              release.resolve();
              const result = yield* Fiber.join(running);
              expect(result._tag).toBe(condition === "success" ? "Success" : "Failure");
            }
            expect(f.terminals).toHaveLength(1);
            expect(f.terminals[0]?.drain).toMatchObject({
              childExitCode: condition === "nonzero" ? 7 : 0,
              kernel: "removed",
            });
            if (condition === "success") {
              expect(f.terminals[0]?.outcome).toBe("success");
              expect(f.terminals[0]?.native?.persisted).toBe(true);
            } else {
              expect(f.terminals[0]?.outcome).not.toBe("success");
              if (condition === "native-failed" || condition === "canceled")
                expect(f.terminals[0]?.native).toBeNull();
            }
          }),
        "initialize",
        condition === "nonzero" ? 7 : 0,
      );

    for (const mode of ["prompt", "initialize", "tool", "local-tool"] as const)
      check(
        `observes ordered full ${mode} worker stream from sequence zero`,
        (f) =>
          Effect.gen(function* () {
            const observed: PiWorkerFrame[] = [];
            const transportEntered = yield* Deferred.make<void>();
            const releaseTransport = Promise.withResolvers<void>();
            const runtime = yield* makePiSessionRuntime({
              ...f.options,
              onWorkerFrame: async (frame: PiWorkerFrame) => {
                observed.push(frame);
                f.events.push(`observed:${frame.sequence}`);
              },
              persistNative: async (frame, signal) => {
                expect(observed.at(-1)).toBe(frame);
                await f.options.persistNative(frame, signal);
              },
              onSdkEvent: async (frame, signal) => {
                expect(observed.at(-1)).toBe(frame);
                await f.options.onSdkEvent(frame, signal);
              },
              persistControl: async (receipt, signal) => {
                expect(observed.at(-1)?.message).toMatchObject({
                  type: "control-receipt",
                  controlId: receipt.controlId,
                });
                await f.options.persistControl(receipt, signal);
              },
              broker: {
                ...f.options.broker,
                transport: async (endpoint, init) => {
                  expect(observed.at(-1)?.message.type).toBe("request");
                  if (mode === "prompt") {
                    Deferred.doneUnsafe(transportEntered, Effect.void);
                    await waitForSignal(releaseTransport.promise, init.signal);
                  }
                  return f.options.broker.transport(endpoint, init);
                },
              },
            });
            const run = yield* runtime.run().pipe(Effect.forkChild);
            if (mode === "prompt") {
              yield* Deferred.await(transportEntered);
              yield* runtime.control({
                type: "control",
                controlId: 55,
                kind: "steer",
                text: "observed",
              });
              releaseTransport.resolve();
            }
            const terminal = yield* Fiber.join(run);
            const types = observed.map((frame) =>
              frame.message.type === "sdk-event"
                ? `sdk-event:${frame.message.event.type}`
                : frame.message.type,
            );
            const tail = [
              "request",
              ...(mode === "prompt" ? ["control-receipt"] : []),
              ...Array.from({ length: 7 }, () => "ack"),
              "sdk-event:assistant_result",
              "agent_end",
              "agent_settled",
              "native",
              "operation_settled",
              "done",
            ];
            const prefix =
              mode === "tool" || mode === "local-tool"
                ? [
                    "ready",
                    "agent_start",
                    "tool-call",
                    "transfer-chunk",
                    "transfer-end",
                    "sdk-event:tool_start",
                    ...(mode === "local-tool"
                      ? ["tool-result", "transfer-chunk", "transfer-end"]
                      : []),
                    "sdk-event:tool_end",
                  ]
                : ["ready", "agent_start"];
            expect(types).toEqual(
              mode === "initialize" ? ["ready", "initialized"] : [...prefix, ...tail],
            );
            expect(observed.map((frame) => frame.sequence)).toEqual(
              observed.map((_, index) => index),
            );
            for (const frame of observed) {
              expect(frame).toMatchObject({ ...f.options.identity, ...f.options.operation });
              expect(Object.isFrozen(frame)).toBe(true);
              expect(Object.isFrozen(frame.message)).toBe(true);
            }
            expect(terminal.outcome).toBe("success");
            expect(terminal.drain?.kernel).toBe("removed");
          }),
        mode,
      );
    for (const mode of [
      "forged-generation",
      "forged-operation",
      "forged-sequence",
      "forged-native",
    ] as const)
      check(
        `worker observer excludes invalid ${mode} frame`,
        (f) =>
          Effect.gen(function* () {
            const observed: PiWorkerFrame[] = [];
            const runtime = yield* makePiSessionRuntime({
              ...f.options,
              onWorkerFrame: async (frame) => {
                observed.push(frame);
              },
            });
            const result = yield* runtime.run().pipe(Effect.exit);
            expect(result._tag).toBe("Failure");
            expect(f.terminals[0]?.outcome).not.toBe("success");
            expect(f.terminals[0]?.drain?.kernel).toBe("removed");
            expect(observed.map((frame) => frame.sequence)).toEqual(
              observed.map((_, index) => index),
            );
            for (const frame of observed)
              expect(frame).toMatchObject({ ...f.options.identity, ...f.options.operation });
            expect(observed.at(-1)?.message.type).toBe(
              mode === "forged-operation"
                ? "native"
                : mode === "forged-sequence"
                  ? "operation_settled"
                  : "agent_settled",
            );
            expect(observed.some((frame) => frame.message.type === "done")).toBe(false);
          }),
        mode,
      );
    for (const target of ["request", "ack"] as const)
      for (const mode of ["honored", "ignored", "released"] as const)
        check(
          `held ${target} worker observer ${mode} signal gates dispatch and joins cleanup`,
          (f) =>
            Effect.gen(function* () {
              const entered = yield* Deferred.make<void>();
              const finished = yield* Deferred.make<void>();
              const release = Promise.withResolvers<void>();
              let observerPending = false;
              let pendingAtTerminal = false;
              const runtime = yield* makePiSessionRuntime({
                ...f.options,
                cleanupDeadlineMs: 100,
                onWorkerFrame: async (frame, signal) => {
                  if (frame.message.type !== target) return;
                  observerPending = true;
                  Deferred.doneUnsafe(entered, Effect.void);
                  try {
                    if (mode === "ignored") await release.promise;
                    else await waitForSignal(release.promise, signal);
                  } finally {
                    observerPending = false;
                    Deferred.doneUnsafe(finished, Effect.void);
                  }
                },
                persistTerminal: async (terminal, signal) => {
                  pendingAtTerminal = observerPending;
                  await f.options.persistTerminal(terminal, signal);
                },
              });
              const run = yield* runtime.run().pipe(Effect.forkChild);
              yield* Deferred.await(entered);
              expect(f.events.filter((event) => event === "transport")).toHaveLength(
                target === "request" ? 0 : 1,
              );
              if (mode === "released") release.resolve();
              else yield* Fiber.interrupt(run);
              const result = yield* Fiber.await(run);
              release.resolve();
              yield* Deferred.await(finished);
              expect(result._tag).toBe(mode === "released" ? "Success" : "Failure");
              expect(f.terminals[0]?.outcome).toBe(
                mode === "released" ? "success" : mode === "ignored" ? "quarantine" : "canceled",
              );
              expect(pendingAtTerminal).toBe(mode === "ignored");
              expect(f.events.filter((event) => event === "transport")).toHaveLength(
                mode === "released" || target === "ack" ? 1 : 0,
              );
              if (target === "ack" && mode !== "released")
                expect(f.settlements.at(-1)?.outcome).toBe("failed");
              expect(f.terminals[0]?.drain?.kernel).toBe("removed");
              if (mode !== "released") expect(f.terminals[0]?.native).toBeNull();
            }),
        );
    for (const target of ["ready", "request", "ack", "native", "done"] as const)
      check(`worker observer rejection at ${target} prevents its dispatch`, (f) =>
        Effect.gen(function* () {
          const observed: PiWorkerFrame[] = [];
          const runtime = yield* makePiSessionRuntime({
            ...f.options,
            onWorkerFrame: async (frame) => {
              observed.push(frame);
              if (frame.message.type === target) throw new Error("observer write rejected");
            },
          });
          const result = yield* runtime.run().pipe(Effect.exit);
          expect(result._tag).toBe("Failure");
          expect(observed.at(-1)?.message.type).toBe(target);
          expect(f.terminals[0]?.outcome).toBe("failed");
          if (target === "done") expect(f.terminals[0]?.native?.persisted).toBe(true);
          else {
            expect(f.terminals[0]?.native).toBeNull();
            expect(f.events).not.toContain("native");
          }
          expect(f.terminals[0]?.drain?.kernel).toBe("removed");
          expect(f.events.filter((event) => event === "transport")).toHaveLength(
            target === "native" || target === "ack" || target === "done" ? 1 : 0,
          );
        }),
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
    for (const denied of ["beforeToolInvoke", "beforeToolReturn"] as const)
      check(
        `local current denial at ${denied} prevents acceptance and further model work`,
        (f, scratch) =>
          Effect.gen(function* () {
            const runtime = yield* makePiSessionRuntime({
              ...f.options,
              authorizeCurrent: async (request) => {
                f.events.push(request.phase);
                if (request.phase === denied) throw new Error("stale local approval");
              },
            });
            const result = yield* runtime.run().pipe(Effect.exit);
            expect(result._tag).toBe("Failure");
            expect(f.terminals[0]?.outcome).toBe("failed");
            expect(f.terminals[0]?.drain?.kernel).toBe("removed");
            expect(f.events).not.toContain("transport");
            expect(f.events).not.toContain("tool_end");
            const path = NodePath.join(scratch, "workspace", "local-tool");
            if (denied === "beforeToolInvoke")
              yield* Effect.promise(() =>
                expect(NodeFSP.stat(path)).rejects.toMatchObject({ code: "ENOENT" }),
              );
            else
              expect(yield* Effect.promise(() => NodeFSP.readFile(path, "utf8"))).toBe("executed");
          }),
        "local-tool",
      );
    check(
      "local authorization phases precede invocation and result observation",
      (f) =>
        Effect.gen(function* () {
          const runtime = yield* makePiSessionRuntime(f.options);
          const result = yield* runtime.run();
          expect(result.outcome).toBe("success");
          expect(f.events.indexOf("beforeToolInvoke")).toBeGreaterThan(
            f.events.indexOf("beforeTool"),
          );
          expect(f.events.indexOf("beforeToolInvoke")).toBeLessThan(f.events.indexOf("tool_start"));
          expect(f.events.indexOf("beforeToolReturn")).toBeGreaterThan(
            f.events.indexOf("tool_start"),
          );
          expect(f.events.indexOf("beforeToolReturn")).toBeLessThan(f.events.indexOf("tool_end"));
          expect(f.events.indexOf("beforeToolReturn")).toBeLessThan(f.events.indexOf("transport"));
        }),
      "local-tool",
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
    for (const mode of ["ignored", "honored", "resolved"] as const)
      check(
        mode === "honored"
          ? "unresolved concurrent control honoring cancellation prevents success"
          : mode === "ignored"
            ? "unresolved concurrent control must join or quarantine before terminal"
            : "resolved concurrent control callback joins before success",
        (f) =>
          Effect.gen(function* () {
            const held = mode !== "resolved";
            const transportEntered = yield* Deferred.make<void>();
            const transportRelease = Promise.withResolvers<void>();
            const authorizeEntered = yield* Deferred.make<void>();
            const authorizeRelease = Promise.withResolvers<void>();
            const unresolvedEntered = yield* Deferred.make<void>();
            const unresolvedPersisted = yield* Deferred.make<void>();
            const unresolvedRelease = Promise.withResolvers<void>();
            let unresolvedPending = false;
            let pendingAtTerminal = false;
            const runtime = yield* makePiSessionRuntime({
              ...f.options,
              cleanupDeadlineMs: 100,
              broker: {
                ...f.options.broker,
                transport: async (endpoint, init) => {
                  Deferred.doneUnsafe(transportEntered, Effect.void);
                  await waitForSignal(transportRelease.promise, init.signal);
                  return f.options.broker.transport(endpoint, init);
                },
              },
              authorizeCurrent: async (request, signal) => {
                if (request.phase === "beforeControl") {
                  Deferred.doneUnsafe(authorizeEntered, Effect.void);
                  await waitForSignal(authorizeRelease.promise, signal);
                }
              },
              persistControl: async (receipt, signal) => {
                if (receipt.status === "unresolved") {
                  unresolvedPending = true;
                  Deferred.doneUnsafe(unresolvedEntered, Effect.void);
                  try {
                    if (mode === "honored") await waitForSignal(unresolvedRelease.promise, signal);
                    else await unresolvedRelease.promise;
                  } finally {
                    unresolvedPending = false;
                    if (mode === "honored") Deferred.doneUnsafe(unresolvedPersisted, Effect.void);
                  }
                }
                await f.options.persistControl(receipt, AbortSignal.timeout(1000));
                if (receipt.status === "unresolved")
                  Deferred.doneUnsafe(unresolvedPersisted, Effect.void);
              },
              persistTerminal: async (terminal, signal) => {
                pendingAtTerminal = unresolvedPending;
                await f.options.persistTerminal(terminal, signal);
              },
            });
            const run = yield* runtime.run().pipe(Effect.forkChild);
            yield* Deferred.await(transportEntered);
            const first = yield* runtime
              .control({ type: "control", controlId: 1, kind: "steer", text: "first" })
              .pipe(Effect.forkChild);
            yield* Deferred.await(authorizeEntered);
            const second = yield* runtime
              .control({ type: "control", controlId: 2, kind: "steer", text: "second" })
              .pipe(Effect.forkChild);
            yield* Deferred.await(unresolvedEntered);
            if (!held) {
              unresolvedRelease.resolve();
              yield* Fiber.await(second);
            }
            authorizeRelease.resolve();
            yield* Fiber.join(first);
            transportRelease.resolve();
            const result = yield* Fiber.await(run);
            const observed = {
              runExit: result._tag,
              terminal: f.terminals[0],
              pendingAtTerminal,
              controls: f.controls,
            };
            const evidencePath = process.env.PI_SESSION_RUNTIME_EVIDENCE_DIR;
            if (evidencePath)
              yield* Effect.promise(() =>
                NodeFSP.writeFile(
                  NodePath.join(
                    evidencePath,
                    mode === "ignored"
                      ? "concurrent-control-observation.json"
                      : mode === "honored"
                        ? "concurrent-control-honored-observation.json"
                        : "concurrent-control-resolved-observation.json",
                  ),
                  json(observed),
                ),
              );
            unresolvedRelease.resolve();
            yield* Fiber.await(second);
            yield* Deferred.await(unresolvedPersisted);
            expect(pendingAtTerminal).toBe(mode === "ignored");
            expect(result._tag).toBe(held ? "Failure" : "Success");
            expect(f.terminals[0]?.outcome).toBe(held ? "quarantine" : "success");
            expect(f.terminals[0]?.drain?.kernel).toBe("removed");
            expect([...f.controls].sort((a, b) => a.controlId - b.controlId)).toMatchObject(
              mode === "honored"
                ? [{ controlId: 1, status: "received" }]
                : [
                    { controlId: 1, status: "received" },
                    { controlId: 2, status: "unresolved" },
                  ],
            );
          }),
      );
    check("control during terminal persistence waits for the run to close", (f) =>
      Effect.gen(function* () {
        const terminalEntered = yield* Deferred.make<void>();
        const controlStarted = yield* Deferred.make<void>();
        const releaseTerminal = Promise.withResolvers<void>();
        let controlCallbackBegun = false;
        const runtime = yield* makePiSessionRuntime({
          ...f.options,
          persistControl: async (receipt, signal) => {
            controlCallbackBegun = true;
            await f.options.persistControl(receipt, signal);
          },
          persistTerminal: async (terminal, signal) => {
            Deferred.doneUnsafe(terminalEntered, Effect.void);
            await waitForSignal(releaseTerminal.promise, signal);
            await f.options.persistTerminal(terminal, signal);
          },
        });
        const run = yield* runtime.run().pipe(Effect.forkChild);
        yield* Deferred.await(terminalEntered);
        const late = yield* Effect.gen(function* () {
          yield* Deferred.succeed(controlStarted, undefined);
          yield* runtime.control({
            type: "control",
            controlId: 41,
            kind: "steer",
            text: "late terminal",
          });
        }).pipe(Effect.forkChild);
        yield* Deferred.await(controlStarted);
        expect(controlCallbackBegun).toBe(false);
        releaseTerminal.resolve();
        yield* Fiber.join(run);
        yield* Fiber.await(late);
        expect(f.controls).toMatchObject([{ controlId: 41, status: "unresolved" }]);
        expect(f.terminals[0]?.outcome).toBe("success");
        expect(f.events.filter((event) => event === "transport")).toHaveLength(1);
      }),
    );
    check("pre-run control retains its original unresolved ID before one run", (f) =>
      Effect.gen(function* () {
        const runtime = yield* makePiSessionRuntime(f.options);
        yield* runtime
          .control({ type: "control", controlId: 42, kind: "follow-up", text: "before run" })
          .pipe(Effect.exit);
        expect(f.controls).toMatchObject([{ controlId: 42, status: "unresolved" }]);
        yield* runtime.run();
        expect(f.terminals[0]?.outcome).toBe("success");
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
