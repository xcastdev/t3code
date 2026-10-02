import * as NodeServices from "@effect/platform-node/NodeServices";
import { VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Fiber from "effect/Fiber";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { preallocatePiManagedProcess, type PiManagedProcessOwner } from "./PiManagedProcess.ts";
import {
  makePiSessionRuntime,
  type PiSessionRuntimeOptions,
  type PiSessionTerminal,
} from "./PiSessionRuntime.ts";
import { makePiWorkerSettings } from "./PiWorker.ts";
import {
  makePiWorkerLineFramer,
  decodePiWorkerFrame,
  type PiNativeReference,
  type PiWorkerFrame,
} from "./PiWorkerProtocol.ts";
import type { PiModelRequestSettlement } from "./PiModelBroker.ts";

const Closure = Schema.Struct({
  sdkVersion: Schema.Literal("0.99.1"),
  files: Schema.Array(
    Schema.Struct({
      source: Schema.String,
      target: Schema.String,
      bytes: Schema.Int,
      sha256: Schema.String,
    }),
  ),
});
const OwnerOutput = Schema.Struct({
  type: Schema.Literals(["stdout", "stderr"]),
  data: Schema.String,
});
const isOutput = Schema.is(OwnerOutput);
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Json));
const decodeObject = Schema.decodeUnknownSync(Schema.JsonObject);
const decodeClosure = Schema.decodeSync(Schema.fromJsonString(Closure), {
  onExcessProperty: "error",
});
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const evidenceJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
class RequiredLinuxProofError extends Data.TaggedError("RequiredLinuxProofError")<{
  readonly reason: string;
}> {}
const model = "inclusionai/ling-3.1-flash:free";
const context =
  "\uFEFFRequired approved scope stays parent-owned. Pending question Beta remains unresolved. " +
  "Older fact Alpha. ".repeat(192);
const prompt = "Echo the bounded assignment.";
const parameters = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};
const modelTool = {
  type: "function" as const,
  function: { name: "echo_assignment", description: "Echo assignment", parameters },
};
const schemaText = json(parameters);

const workspaceFixture = Effect.fn("PiSdkSessionRuntime.workspaceFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const manifest = process.env.PI_SDK_SESSION_RUNTIME_CLOSURE;
  if (!manifest)
    return yield* Effect.fail(
      new RequiredLinuxProofError({
        reason: "Actual SDK closure manifest required; missing Linux proof cannot skip",
      }),
    );
  const closure = decodeClosure(yield* fs.readFileString(manifest));
  for (const file of closure.files) {
    const bytes = yield* fs.readFile(file.source);
    expect(bytes.byteLength).toBe(file.bytes);
    expect(Buffer.from(yield* crypto.digest("SHA-256", bytes)).toString("hex")).toBe(file.sha256);
  }
  expect(closure.files.length).toBeLessThanOrEqual(128);
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "pi-sdk-parent-" });
  const workspace = path.join(scratch, "workspace");
  const state = path.join(scratch, "state");
  const protectedRoot = path.join(scratch, "protected");
  yield* fs.makeDirectory(workspace);
  yield* fs.makeDirectory(path.join(state, "sessions"), { recursive: true });
  yield* fs.makeDirectory(protectedRoot);
  yield* fs.writeFileString(path.join(protectedRoot, "credentials"), "protected-parent-secret");
  yield* fs.makeDirectory(path.join(workspace, ".pi/extensions"), { recursive: true });
  yield* fs.writeFileString(
    path.join(workspace, ".pi/extensions/ambient.mjs"),
    'throw Error("AMBIENT_EXTENSION_LOADED")',
  );
  yield* fs.writeFileString(path.join(workspace, "AGENTS.md"), "AMBIENT_CONTEXT_SENTINEL");
  const hostNetworkNamespace = yield* fs.readLink("/proc/self/ns/net");
  const fixtureId = yield* crypto.randomUUIDv4;
  let operationCount = 0;
  const operation = Effect.fn("PiSdkSessionRuntime.operation")(function* (
    operationKind: "initialize" | "prompt" | "compact",
    native: PiNativeReference | null = null,
    mode = "plain",
    overrides: Partial<PiSessionRuntimeOptions> = {},
    observeExit = false,
  ) {
    const identity = { workerId: "sdk-parent", generation: 1 };
    const op = { operationId: `${operationKind}-${fixtureId}-${++operationCount}`, operationKind };
    const withTools =
      mode === "two-tools" || mode === "bridge" || mode === "descendant" || mode === "restore";
    const launch = {
      workspaceRoot: workspace,
      nativeStateRoot: state,
      protectedRoots: [protectedRoot],
      runtimeFiles: closure.files.map(({ source, target }) => ({ source, target })),
      argv: [
        "/runtime/node",
        "--max-old-space-size=512",
        "/runtime/dist/worker.mjs",
        identity.workerId,
        String(identity.generation),
        op.operationId,
        op.operationKind,
        mode,
      ],
      memoryBytes: 536870912,
      runtimeSeconds: 30,
    };
    const allocation = yield* preallocatePiManagedProcess(launch);
    const owners: PiManagedProcessOwner[] = [];
    const terminals: PiSessionTerminal[] = [];
    const natives: PiNativeReference[] = [];
    const frames: PiWorkerFrame[] = [];
    const requests: Schema.JsonObject[] = [];
    const settlements: PiModelRequestSettlement[] = [];
    const controls: Parameters<PiSessionRuntimeOptions["persistControl"]>[0][] = [];
    const tools: Array<{ callId: number; nativeCallId: string; text: Schema.Json }> = [];
    const events: string[] = [];
    const bridgeEntered = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    const idle = Promise.withResolvers<void>();
    const ackHeld = Promise.withResolvers<void>();
    const failed = Promise.withResolvers<void>();
    const launcherExited = Promise.withResolvers<number>();
    let pulls = 0;
    const runtime = yield* makePiSessionRuntime({
      identity,
      operation: op,
      bootstrap: {
        type: "bootstrap",
        executionMode: "managed",
        expectedCwd: "/workspace",
        native,
        context: { transferId: "context", totalBytes: Buffer.byteLength(context) },
        prompt:
          operationKind === "prompt"
            ? { transferId: "prompt", totalBytes: Buffer.byteLength(prompt) }
            : null,
        model: {
          provider: "command-code",
          modelId: model,
          api: "openai-completions",
          contextWindow: 32768,
          maxTokens: 512,
          reasoning: false,
        },
        allowedTools: withTools
          ? [
              {
                name: modelTool.function.name,
                description: modelTool.function.description,
                execution: "bridge",
                inputSchema: { transferId: "schema", totalBytes: Buffer.byteLength(schemaText) },
              },
            ]
          : [],
      },
      transferTexts: [
        { transferId: "context", text: context },
        ...(operationKind === "prompt" ? [{ transferId: "prompt", text: prompt }] : []),
        ...(withTools ? [{ transferId: "schema", text: schemaText }] : []),
      ],
      launch,
      persistence: {
        allocation,
        claimActivation: () =>
          Effect.sync(() => {
            events.push("activation");
          }),
        beforeStart: (owner) =>
          Effect.sync(() => {
            owners.push(owner);
            events.push("owner");
          }),
      },
      broker: {
        ...identity,
        operationId: op.operationId,
        routeId: "synthetic",
        provider: "command-code",
        model,
        endpoint: "https://api.commandcode.ai/provider/v1/chat/completions",
        acceptedReportedModels: [model],
        tools: withTools ? [modelTool] : [],
        maxInputTokens: 32768,
        maxOutputTokens: 512,
        deadlineMs: 10000,
        authorizeCurrent: async (phase) => {
          events.push(phase);
        },
        getCredential: async () => "synthetic-parent-secret",
        reserveRequest: async (r) => ({ reservationId: `reservation-${r.requestId}` }),
        settleRequest: async (r) => {
          settlements.push(r);
          events.push("accounting-enter");
          settled.resolve();
          if (["accounting-held", "late-control", "accounting-failed"].includes(mode))
            await released.promise;
          if (mode === "accounting-failed") throw Error("synthetic accounting failure");
          events.push("accounting-committed");
          return { accountingReceiptId: `accounting-${r.requestId}` };
        },
        transport: async (endpoint, init) => {
          expect(endpoint).toBe("https://api.commandcode.ai/provider/v1/chat/completions");
          expect(init.headers.Authorization).toBe("Bearer synthetic-parent-secret");
          const request = decodeObject(decodeJson(init.body));
          expect(request.model).toBe(model);
          expect(init.body).not.toContain("AMBIENT_CONTEXT_SENTINEL");
          expect(init.body).not.toContain("protected-parent-secret");
          requests.push(request);
          events.push("transport");
          entered.resolve();
          if (mode === "active-control" && requests.length === 1) await released.promise;
          const chunk = (delta: Schema.JsonObject, finish_reason: string | null = null) => ({
            id: "sdk-parent-fixture",
            object: "chat.completion.chunk",
            created: 1,
            model,
            choices: [{ index: 0, delta, finish_reason }],
          });
          const calls = mode === "two-tools" ? 2 : 1;
          const content =
            withTools && mode !== "restore" && requests.length === 1
              ? [
                  chunk({
                    role: "assistant",
                    tool_calls: Array.from({ length: calls }, (_, i) => ({
                      index: i,
                      id: `sdk_call_${i + 1}`,
                      type: "function",
                      function: {
                        name: "echo_assignment",
                        arguments: json({ text: `bounded ${i + 1}` }),
                      },
                    })),
                  }),
                  chunk({}, "tool_calls"),
                ]
              : [
                  chunk({
                    role: "assistant",
                    content:
                      operationKind === "compact"
                        ? "Native summary keeps Alpha and pending Beta."
                        : "Assignment complete.",
                  }),
                  chunk({}, "stop"),
                ];
          const usage = {
            id: "sdk-parent-fixture",
            object: "chat.completion.chunk",
            created: 1,
            model,
            choices: [],
            usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
          };
          const bytes = Buffer.from(
            [...content, usage].map((value) => `data: ${json(value)}\n\n`).join("") +
              "data: [DONE]\n\n",
          );
          let offset = 0;
          return new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  pulls++;
                  if (offset === bytes.length) {
                    controller.close();
                    return;
                  }
                  const end = Math.min(offset + 37, bytes.length);
                  controller.enqueue(bytes.subarray(offset, end));
                  offset = end;
                },
              },
              { highWaterMark: 0 },
            ),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      },
      toolCapabilities: withTools
        ? [{ name: "echo_assignment", execution: "bridge", capability: "project-work.report" }]
        : [],
      deadlineMs: 20000,
      cleanupDeadlineMs: 5000,
      authorizeCurrent: async (request) => {
        events.push(request.phase);
        if (request.tool) expect(request.tool.capability).toBe("project-work.report");
      },
      executeBridgeTool: async (call, input, signal) => {
        tools.push({
          callId: call.callId,
          nativeCallId: call.nativeCallId,
          text: input.arguments.text!,
        });
        events.push("bridge");
        bridgeEntered.resolve();
        if (mode === "descendant") {
          entered.resolve();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
            if (signal.aborted) resolve();
          });
        }
        return { kind: "text", text: `reported ${input.arguments.text}` };
      },
      persistNative: async (frame) => {
        if (mode === "native-denied") throw Error("synthetic native persistence denial");
        if (
          frame.message.type === "initialized" ||
          frame.message.type === "native" ||
          frame.message.type === "compacted"
        )
          natives.push(frame.message.native);
        events.push("native-persisted");
      },
      onSdkEvent: async () => {},
      persistControl: async (receipt) => {
        controls.push(receipt);
      },
      persistTerminal: async (terminal) => {
        terminals.push(terminal);
        events.push("terminal");
      },
      ...overrides,
    });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const trace: string[] = [];
    const launcherPids: number[] = [];
    let traceBytes = 0;
    const workerFramer = makePiWorkerLineFramer((raw) => {
      const frame = decodePiWorkerFrame(raw);
      frames.push(frame);
      if (frame.message.type === "agent_settled") idle.resolve();
      if (frame.message.type === "worker-failure") failed.resolve();
    });
    const ownerFramer = makePiWorkerLineFramer((raw) => {
      const value = decodeJson(raw);
      if (isOutput(value)) {
        const bytes = Buffer.from(value.data, "base64");
        if (value.type === "stdout") workerFramer.push(bytes);
        else if (bytes.toString("utf8").includes("P7_SDK_ACK_HELD")) ackHeld.resolve();
      }
    });
    const observed = ChildProcessSpawner.make((command) =>
      spawner.spawn(command).pipe(
        Effect.map((handle) => {
          if (command._tag !== "StandardCommand" || command.command !== "/usr/bin/systemd-run")
            return handle;
          launcherPids.push(Number(handle.pid));
          return ChildProcessSpawner.makeHandle({
            ...handle,
            exitCode: observeExit
              ? handle.exitCode.pipe(
                  Effect.tap((code) =>
                    Effect.sync(() => {
                      events.push("launcher-exited");
                      launcherExited.resolve(Number(code));
                    }),
                  ),
                )
              : handle.exitCode,
            stdout: handle.stdout.pipe(
              Stream.tap((chunk) =>
                Effect.sync(() => {
                  traceBytes += chunk.byteLength;
                  if (traceBytes > 2 * 1024 * 1024) throw Error("Fixture trace limit");
                  trace.push(Buffer.from(chunk).toString("utf8"));
                  ownerFramer.push(chunk);
                }),
              ),
            ),
          });
        }),
      ),
    );
    const run = runtime.run().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed),
      Effect.exit,
      Effect.tap((result) =>
        Effect.gen(function* () {
          const evidence = process.env.PI_SDK_SESSION_RUNTIME_EVIDENCE_DIR;
          if (evidence) {
            yield* fs.makeDirectory(evidence, { recursive: true });
            yield* fs.writeFileString(
              path.join(evidence, op.operationId + ".json"),
              evidenceJson({
                owners,
                terminals,
                natives,
                frames,
                requests,
                settlements,
                controls,
                tools,
                events,
                trace,
                launcherPids,
                pulls,
                result: result._tag,
              }),
            );
          }
          expect(owners).toHaveLength(1);
          expect(terminals).toHaveLength(1);
          expect(terminals[0]?.drain).toMatchObject({
            kernel: "removed",
            swapBytes: 0,
            memoryBytes: 536870912,
          });
        }),
      ),
    );
    return {
      runtime,
      run,
      op,
      owners,
      terminals,
      natives,
      frames,
      requests,
      settlements,
      controls,
      tools,
      events,
      entered,
      bridgeEntered,
      released,
      settled,
      idle,
      ackHeld,
      failed,
      launcherExited,
      pulls: () => pulls,
    };
  });
  const successful = Effect.fn("PiSdkSessionRuntime.successful")(function* (
    op: Effect.Success<ReturnType<typeof operation>>,
  ) {
    const result = yield* op.run;
    if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
    expect(result.value.outcome).toBe("success");
    expect(result.value.drain?.childExitCode).toBe(0);
    expect(result.value.native?.persisted).toBe(true);
    const native = result.value.native!;
    const file = yield* fs.readFileString(path.join(state, native.sessionReference));
    expect(file).toContain(native.sessionId);
    expect(file).toContain(native.leafId!);
    expect(file).not.toContain("synthetic-parent-secret");
    expect(file).not.toContain("AMBIENT_CONTEXT_SENTINEL");
    if (op.op.operationKind === "initialize") {
      const reopened = SessionManager.open(
        path.join(state, native.sessionReference),
        path.join(state, "sessions"),
      );
      expect(reopened.getSessionId()).toBe(native.sessionId);
      expect(reopened.getLeafId()).toBe(native.leafId);
      expect(
        reopened
          .getEntries()
          .find((entry) => entry.type === "message" && entry.message.role === "user"),
      ).toMatchObject({
        message: { role: "user", content: [{ type: "text", text: context }] },
      });
    }
    const proof = decodeObject(
      decodeJson(yield* fs.readFileString(path.join(state, op.op.operationId + ".fixture.json"))),
    );
    expect(proof.cwd).toBe("/workspace");
    expect(proof.networkNamespace).not.toBe(hostNetworkNamespace);
    expect(proof.environment).toEqual(["HOME", "LANG", "PATH", "PWD", "TMPDIR"]);
    return native;
  });
  return { fs, path, state, operation, successful };
});

// Portable discovery consumes the pinned SDK; the separately invoked Linux proof requires
// every real child case and hard-fails missing SDK/bundle/ownership prerequisites.
describe("portable pinned SDK session persistence", () => {
  effectIt.live("reopens the native supplied user briefing and observes effective settings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "sdk-native-portable-" });
        expect(VERSION).toBe("0.99.1");
        const manager = SessionManager.create(process.cwd(), directory);
        manager.appendMessage({
          role: "user",
          content: [{ type: "text", text: context }],
          timestamp: yield* Clock.currentTimeMillis,
        });
        const reopened = SessionManager.open(manager.getSessionFile()!, directory);
        expect(reopened.isPersisted()).toBe(true);
        expect(reopened.getLeafId()).toBe(manager.getLeafId());
        expect(reopened.getSessionId()).toBe(manager.getSessionId());
        expect(reopened.buildSessionContext().messages[0]).toMatchObject({
          role: "user",
          content: [{ type: "text", text: context }],
        });
        expect(makePiWorkerSettings(512).getCacheWarmingMode()).toBe("off");
        expect(makePiWorkerSettings(512).getBlockImages()).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe.runIf(process.env.PI_SDK_SESSION_RUNTIME_LINUX_GATE === "1")(
  "actual Linux SDK composed with parent ownership",
  () => {
    effectIt.live("EOF repair joins actual SDK exit before initialized publication", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* workspaceFixture();
          const release = Promise.withResolvers<void>();
          const op = yield* f.operation(
            "initialize",
            null,
            "plain",
            {
              onWorkerFrame: async (frame, signal) => {
                if (frame.message.type !== "initialized") return;
                await new Promise<void>((resolve, reject) => {
                  const abort = () => reject(signal.reason);
                  if (signal.aborted) return abort();
                  signal.addEventListener("abort", abort, { once: true });
                  void release.promise.then(() => {
                    signal.removeEventListener("abort", abort);
                    resolve();
                  });
                });
              },
            },
            true,
          );
          const running = yield* Effect.forkChild(op.run);
          expect(yield* Effect.promise(() => op.launcherExited.promise)).toBe(0);
          release.resolve();
          yield* f.successful({ ...op, run: Fiber.join(running) });
          expect(op.requests).toHaveLength(0);
          expect(op.settlements).toHaveLength(0);
          expect(op.events.indexOf("launcher-exited")).toBeLessThan(
            op.events.indexOf("native-persisted"),
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );

    effectIt.live(
      "initializes, executes two sequential bridge calls, compacts and reopens the exact native session",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* workspaceFixture();
            const initialized = yield* f.operation("initialize");
            const native = yield* f.successful(initialized);
            expect(initialized.requests).toHaveLength(0);
            const promptOp = yield* f.operation("prompt", native, "two-tools");
            const prompted = yield* f.successful(promptOp);
            expect(promptOp.tools).toEqual([
              { callId: 1, nativeCallId: "sdk_call_1", text: "bounded 1" },
              { callId: 2, nativeCallId: "sdk_call_2", text: "bounded 2" },
            ]);
            expect(promptOp.requests).toHaveLength(2);
            expect(promptOp.settlements).toHaveLength(2);
            expect(
              promptOp.frames
                .filter(
                  (frame) =>
                    frame.message.type === "sdk-event" &&
                    ["tool_start", "tool_end"].includes(frame.message.event.type),
                )
                .map((frame) => frame.message),
            ).toMatchObject([
              { event: { type: "tool_start", callId: 1 } },
              { event: { type: "tool_end", callId: 1 } },
              { event: { type: "tool_start", callId: 2 } },
              { event: { type: "tool_end", callId: 2 } },
            ]);
            const compact = yield* f.operation("compact", prompted);
            const compacted = yield* f.successful(compact);
            expect(compacted.sessionId).toBe(native.sessionId);
            expect(compacted.sessionReference).toBe(native.sessionReference);
            expect(compacted.leafId).not.toBe(prompted.leafId);
            expect(compact.frames.some((frame) => frame.message.type === "compaction_start")).toBe(
              true,
            );
            expect(compact.frames.some((frame) => frame.message.type === "agent_start")).toBe(
              false,
            );
            const replacement = yield* f.operation("prompt", compacted, "restore");
            const resumed = yield* f.successful(replacement);
            expect(resumed.sessionId).toBe(native.sessionId);
            expect(resumed.sessionReference).toBe(native.sessionReference);
            expect(json(replacement.requests[0]!)).toContain(
              "Native summary keeps Alpha and pending Beta.",
            );
            expect(json(replacement.requests[0]!)).toContain(prompt);
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
    );
    for (const kind of ["steer", "follow-up"] as const)
      effectIt.live(`delivers exact active ${kind} control and joins native continuation`, () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* workspaceFixture();
            const native = yield* f.successful(yield* f.operation("initialize"));
            const op = yield* f.operation("prompt", native, "active-control");
            const run = yield* Effect.forkChild(op.run);
            yield* Effect.promise(() => op.entered.promise);
            const controlId = kind === "steer" ? 71 : 72;
            yield* op.runtime.control({
              type: "control",
              kind,
              controlId,
              text: `${kind} bounded Beta.`,
            });
            expect(op.controls).toMatchObject([{ controlId, kind, status: "received" }]);
            op.released.resolve();
            const result = yield* Fiber.join(run);
            expect(result._tag).toBe("Success");
            expect(op.requests).toHaveLength(2);
            expect(json(op.requests)).toContain(`${kind} bounded Beta.`);
            expect(
              op.frames.some(
                (frame) =>
                  frame.message.type === "control-receipt" && frame.message.controlId === controlId,
              ),
            ).toBe(true);
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );

    effectIt.live(
      "waits for parent accounting after actual SDK idle before native persistence and success",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* workspaceFixture();
            const native = yield* f.successful(yield* f.operation("initialize"));
            const op = yield* f.operation("prompt", native, "accounting-held");
            const run = yield* Effect.forkChild(op.run);
            yield* Effect.promise(() => Promise.all([op.settled.promise, op.idle.promise]));
            expect(op.natives).toEqual([]);
            expect(op.terminals).toEqual([]);
            expect(
              op.frames.some(
                (frame) => frame.message.type === "done" || frame.message.type === "native",
              ),
            ).toBe(false);
            expect(
              op.frames.some(
                (frame) =>
                  frame.message.type === "sdk-event" &&
                  frame.message.event.type === "assistant_result" &&
                  frame.message.event.stopReason === "stop",
              ),
            ).toBe(true);
            op.released.resolve();
            const result = yield* Fiber.join(run);
            expect(result._tag).toBe("Success");
            expect(op.events.indexOf("accounting-committed")).toBeLessThan(
              op.events.indexOf("native-persisted"),
            );
            expect(op.terminals[0]?.accountingReceipts).toHaveLength(1);
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
    );

    effectIt.live(
      "retains the original late-control ID unresolved without an automatic model retry",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* workspaceFixture();
            const native = yield* f.successful(yield* f.operation("initialize"));
            const op = yield* f.operation("prompt", native, "late-control");
            const run = yield* Effect.forkChild(op.run);
            yield* Effect.promise(() => Promise.all([op.settled.promise, op.idle.promise]));
            const control = yield* Effect.forkChild(
              op.runtime
                .control({
                  type: "control",
                  kind: "steer",
                  controlId: 91,
                  text: "Late Beta remains pending.",
                })
                .pipe(Effect.exit),
            );
            yield* Effect.promise(() => op.failed.promise);
            op.released.resolve();
            expect((yield* Fiber.join(control))._tag).toBe("Failure");
            expect((yield* Fiber.join(run))._tag).toBe("Failure");
            expect(op.controls).toMatchObject([
              { controlId: 91, kind: "steer", status: "unresolved" },
            ]);
            expect(op.requests).toHaveLength(1);
            expect(op.natives).toEqual([]);
            expect(op.terminals[0]?.outcome).not.toBe("success");
            expect(op.frames.some((frame) => frame.message.type === "control-receipt")).toBe(false);
            expect(
              op.frames.some(
                (frame) =>
                  frame.message.type === "worker-failure" && frame.message.code === "INVALID_INPUT",
              ),
            ).toBe(true);
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
    );

    effectIt.live("rejects late accounting failure after the actual SDK stop and idle events", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* workspaceFixture();
          const native = yield* f.successful(yield* f.operation("initialize"));
          const op = yield* f.operation("prompt", native, "accounting-failed");
          const run = yield* Effect.forkChild(op.run);
          yield* Effect.promise(() => Promise.all([op.settled.promise, op.idle.promise]));
          expect(op.natives).toEqual([]);
          op.released.resolve();
          expect((yield* Fiber.join(run))._tag).toBe("Failure");
          expect(op.terminals[0]?.outcome).not.toBe("success");
          expect(op.terminals[0]?.accountingReceipts).toEqual([]);
          expect(
            op.frames.some(
              (frame) => frame.message.type === "done" || frame.message.type === "native",
            ),
          ).toBe(false);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );

    effectIt.live(
      "retains the interrupt ID unresolved when a held ACK precedes a queued SDK event",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* workspaceFixture();
            const native = yield* f.successful(yield* f.operation("initialize"));
            const op = yield* f.operation("prompt", native, "ack-hold");
            const run = yield* Effect.forkChild(op.run);
            yield* Effect.promise(() => op.ackHeld.promise);
            expect(op.frames.some((frame) => frame.message.type === "ack")).toBe(false);
            expect(op.settlements).toEqual([]);
            expect(op.terminals).toEqual([]);
            const pulls = op.pulls();
            yield* op.runtime.interrupt(101).pipe(Effect.exit);
            expect((yield* Fiber.join(run))._tag).toBe("Failure");
            // The SDK queued assistant message_start before cancellation, behind the held ACK.
            // The canceled parent rejects that event before accepting the later control receipt.
            expect(op.controls).toEqual([
              {
                identity: { workerId: "sdk-parent", generation: 1 },
                operation: op.op,
                controlId: 101,
                kind: "interrupt",
                status: "unresolved",
              },
            ]);
            const ackIndex = op.frames.findIndex((frame) => frame.message.type === "ack");
            const receiptIndex = op.frames.findIndex(
              (frame) =>
                frame.message.type === "control-receipt" && frame.message.controlId === 101,
            );
            expect(ackIndex).toBeGreaterThanOrEqual(0);
            expect(receiptIndex).toBeGreaterThan(ackIndex);
            expect(
              op.frames
                .slice(ackIndex + 1, receiptIndex)
                .some(
                  (frame) =>
                    frame.message.type === "sdk-event" &&
                    frame.message.event.type === "message_start",
                ),
            ).toBe(true);
            expect(op.requests).toHaveLength(1);
            expect(op.pulls()).toBeLessThanOrEqual(pulls + 1);
            expect(op.natives).toEqual([]);
            expect(op.terminals[0]?.outcome).not.toBe("success");
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
    );

    effectIt.live(
      "joins canceled parent bridge execution and every captured actual SDK descendant",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* workspaceFixture();
            const native = yield* f.successful(yield* f.operation("initialize"));
            const op = yield* f.operation("prompt", native, "descendant");
            const run = yield* Effect.forkChild(op.run);
            yield* Effect.promise(() => op.bridgeEntered.promise);
            const descendant = decodeJson(
              yield* f.fs.readFileString(f.path.join(f.state, "descendant.json")),
            );
            expect(descendant).toMatchObject({ pid: expect.any(Number) });
            const owner = op.owners[0]!;
            const pids = (yield* f.fs.readFileString(f.path.join(owner.cgroup, "cgroup.procs")))
              .trim()
              .split("\n")
              .map(Number);
            expect(pids.length).toBeGreaterThanOrEqual(4);
            yield* op.runtime.interrupt(119).pipe(Effect.exit);
            expect((yield* Fiber.join(run))._tag).toBe("Failure");
            expect(op.controls).toMatchObject([
              { controlId: 119, kind: "interrupt", status: "received" },
            ]);
            expect(op.tools).toHaveLength(1);
            expect(
              op.frames.some(
                (frame) =>
                  frame.message.type === "tool-result" ||
                  frame.message.type === "done" ||
                  frame.message.type === "native",
              ),
            ).toBe(false);
            for (const pid of pids) expect(yield* f.fs.exists(`/proc/${pid}`)).toBe(false);
            const evidence = process.env.PI_SDK_SESSION_RUNTIME_EVIDENCE_DIR;
            if (evidence)
              yield* f.fs.writeFileString(
                f.path.join(evidence, op.op.operationId + ".descendants.json"),
                evidenceJson({ descendant, pids, owner, terminal: op.terminals[0]! }),
              );
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
    );

    effectIt.live(
      "requires parent native persistence even after the genuine SDK file changed",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* workspaceFixture();
            const native = yield* f.successful(yield* f.operation("initialize"));
            const op = yield* f.operation("prompt", native, "native-denied");
            expect((yield* op.run)._tag).toBe("Failure");
            expect(op.frames.some((frame) => frame.message.type === "native")).toBe(true);
            expect(op.natives).toEqual([]);
            expect(op.terminals[0]?.native).toBeNull();
            expect(op.terminals[0]?.outcome).not.toBe("success");
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
    );

    effectIt.live("denies a stale parent tool capability before the actual bridge callback", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* workspaceFixture();
          const native = yield* f.successful(yield* f.operation("initialize"));
          const denied: string[] = [];
          const op = yield* f.operation("prompt", native, "bridge", {
            authorizeCurrent: async (request) => {
              denied.push(request.phase);
              if (request.phase === "beforeToolInvoke") throw Error("stale parent capability");
            },
          });
          expect((yield* op.run)._tag).toBe("Failure");
          expect(denied).toContain("beforeToolInvoke");
          expect(op.tools).toEqual([]);
          expect(op.terminals[0]?.outcome).not.toBe("success");
          expect(op.requests).toHaveLength(1);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);
