import * as NodeCrypto from "node:crypto";
import {
  IsoDateTime,
  ProjectWorkReadIntent,
  ProjectWorkWriteIntent,
  ProviderDriverKind,
  TurnId,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  ProjectTeamAuthorization,
  type ProjectTeamAuthority,
} from "../../projectWork/ProjectTeamAuthorization.ts";
import { makeProjectTeamPiOperations } from "../../projectWork/ProjectTeamPiOperations.ts";
import { make as makeAccounting } from "../../projectWork/ProjectTeamModelAccounting.ts";
import { ProjectWorkGateway } from "../../projectWork/ProjectWorkGateway.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { buildServerProvider } from "../providerSnapshot.ts";
import {
  PiManagedRuntime,
  PiManagedRuntimeError,
  type PiManagedRuntimeInstance,
  type PiManagedPreparedOperation,
} from "./PiManagedRuntime.ts";
import { preallocatePiManagedProcess, type PiManagedLaunch } from "./PiManagedProcess.ts";
import {
  inspectPiNativeConfiguration,
  readPiSavedLiteralCredential,
} from "./PiNativeConfiguration.ts";
import { readPiNativeSession } from "./PiNativeSessionReader.ts";
import { makePiRuntimeEventTranslator } from "./PiRuntimeEvents.ts";
import { makePiSessionRuntime } from "./PiSessionRuntime.ts";
import type { PiModelBrokerConfig, PiModelTool } from "./PiModelBroker.ts";
import type { PiNativeReference, PiWorkerIdentity, PiWorkerOperation } from "./PiWorkerProtocol.ts";

const provider = ProviderDriverKind.make("piAgent");
const routeId = "command-code-ling-free";
const model = "inclusionai/ling-3.1-flash:free";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isRuntimeError = Schema.is(PiManagedRuntimeError);
const decodeReadIntent = Schema.decodeUnknownEffect(ProjectWorkReadIntent, {
  onExcessProperty: "error",
});
const writeEnvelope = Schema.Struct({
  intentJSON: Schema.String.check(Schema.isMaxLength(262144)),
});
const decodeWriteEnvelope = Schema.decodeUnknownEffect(writeEnvelope, {
  onExcessProperty: "error",
});
const decodeWriteIntentJSON = Schema.decodeEffect(Schema.fromJsonString(ProjectWorkWriteIntent), {
  onExcessProperty: "error",
});
const decodeJsonObject = Schema.decodeUnknownSync(Schema.JsonObject);
const readParameters = decodeJsonObject(Schema.toJsonSchemaDocument(ProjectWorkReadIntent).schema);
const writeParameters = decodeJsonObject(Schema.toJsonSchemaDocument(writeEnvelope).schema);
const digest = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const deny = (detail: string, code: PiManagedRuntimeError["code"] = "denied") =>
  new PiManagedRuntimeError({ code, detail });
const guard = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      isRuntimeError(error) ? error : deny("Pi managed runtime unavailable", "unavailable"),
    ),
  );
export interface PiManagedRuntimeLiveOptions {
  readonly environmentId: string;
  readonly agentDirectory: string;
  readonly nativeStateRoot: string;
  readonly protectedRoots: ReadonlyArray<string>;
  readonly runtimeFiles: PiManagedLaunch["runtimeFiles"];
  /** The owned state is mounted at /state; the worker must use /state/sessions. */
  readonly workerArgv: (
    identity: PiWorkerIdentity,
    operation: PiWorkerOperation,
    nativeStateDirectory: string,
  ) => ReadonlyArray<string>;
  readonly memoryBytes: number;
  readonly cleanupDeadlineMs: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly readCatalogue: Effect.Effect<
    | {
        readonly source: "https://api.commandcode.ai/provider/v1/models";
        readonly fetchedAt: string;
        readonly selectedEntry: {
          readonly id: "inclusionai/ling-3.1-flash:free";
          readonly owned_by: "command-code";
          readonly context_length: number;
          readonly supported_endpoints: ReadonlyArray<string>;
          readonly max_output_tokens?: number;
        };
      }
    | undefined,
    PiManagedRuntimeError
  >;
  readonly transport: PiModelBrokerConfig["transport"];
}

/** Builds the production port. Only this parent-owned constructor supplies the worker closure. */
export const makePiManagedRuntimeLive = Effect.fn("makePiManagedRuntimeLive")(function* (
  supplied: PiManagedRuntimeLiveOptions,
) {
  const options = {
    ...supplied,
    runtimeFiles: structuredClone(supplied.runtimeFiles),
    protectedRoots: [...supplied.protectedRoots],
  };
  const operations = yield* makeProjectTeamPiOperations({ environmentId: options.environmentId });
  const authorization = yield* ProjectTeamAuthorization;
  const gateway = yield* ProjectWorkGateway;
  const accounting = yield* makeAccounting({
    environmentId: options.environmentId,
    routeId,
    model,
    acceptedReportedModels: [model, "inclusionai/ling-3.1-flash"],
    resolveOperation: operations.resolveOperation,
  });
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const services = yield* Effect.context<
    Crypto.Crypto | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const perform = Effect.runPromiseWith(services);
  const git = Effect.fn("PiManagedRuntimeLive.git")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make("/usr/bin/git", ["-C", cwd, ...args], {
            env: {
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_TERMINAL_PROMPT: "0",
            },
            extendEnv: false,
            stdin: "ignore",
          }),
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [
            collectUint8StreamText({ stream: child.stdout, maxBytes: 262144 }),
            collectUint8StreamText({ stream: child.stderr, maxBytes: 8192 }),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (
          Number(code) !== 0 ||
          stderr.truncated ||
          stdout.truncated ||
          stdout.invalidUtf8 ||
          stderr.invalidUtf8
        )
          return yield* deny("Assigned Git worktree cannot be verified");
        return stdout.text;
      }),
    );
  });
  const verifyWorkspace = Effect.fn("PiManagedRuntimeLive.verifyWorkspace")(function* (
    authority: ProjectTeamAuthority,
  ) {
    const cwd = authority.binding.worktree;
    if (
      (yield* fs.realPath(cwd)) !== cwd ||
      (yield* git(cwd, ["rev-parse", "--show-toplevel"])).trim() !== cwd ||
      (yield* git(cwd, ["symbolic-ref", "--short", "HEAD"])).trim() !== authority.binding.branch
    )
      return yield* deny("Assigned canonical Git worktree or branch changed");
    const records = (yield* git(cwd, ["worktree", "list", "--porcelain", "-z"]))
      .split("\0\0")
      .filter(Boolean)
      .map((record) => record.split("\0"));
    if (
      authority.binding.branch === "main" ||
      authority.binding.branch === "master" ||
      records[0]?.includes(`branch refs/heads/${authority.binding.branch}`) ||
      records[0]?.includes(`worktree ${cwd}`) ||
      !records.some(
        (record) =>
          record.includes(`worktree ${cwd}`) &&
          record.includes(`branch refs/heads/${authority.binding.branch}`),
      )
    )
      return yield* deny("Pi requires a registered isolated worktree");
    if (
      (yield* git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
        .trim()
        .startsWith(cwd + "/")
    )
      return yield* deny("Pi worktree cannot own the main Git directory");
  });
  const configuration = Effect.fn("PiManagedRuntimeLive.configuration")(function* (
    agentDirectory: string,
    authority?: ProjectTeamAuthority,
  ) {
    const catalogue = yield* options.readCatalogue.pipe(
      Effect.mapError(() => deny("Pi catalogue read unavailable", "unavailable")),
    );
    if (!catalogue) return yield* deny("Refresh the Pi model catalogue explicitly", "unavailable");
    const fetchedAt = Date.parse(catalogue.fetchedAt);
    const now = yield* Clock.currentTimeMillis;
    if (!Number.isSafeInteger(fetchedAt) || fetchedAt > now || now - fetchedAt >= 86_400_000)
      return yield* deny("Pi model catalogue is stale", "unavailable");
    const maxInputTokens = options.maxInputTokens;
    const maxOutputTokens = options.maxOutputTokens;
    if (authority && maxInputTokens + maxOutputTokens > authority.binding.configuration.maxTokens)
      return yield* deny("Pi request limits exceed the frozen run budget");
    return yield* inspectPiNativeConfiguration({
      agentDirectory,
      selectedModel: { provider: "command-code", model },
      catalogue,
      limits: {
        maxInputTokens,
        maxOutputTokens,
        deadlineMs: Math.min(300_000, authority?.binding.configuration.maxDurationMs ?? 300_000),
      },
      nodeVersion: process.versions.node,
    });
  });
  const contextFor = (authority: ProjectTeamAuthority) => {
    const binding = authority.binding;
    const task = authority.state.tasks.find((entry) => entry.taskId === binding.taskId);
    const records = authority.state.foundationRecords ?? [];
    return encode({
      binding,
      role: authority.role,
      task,
      specification: task?.specification,
      plan: records.filter(
        (entry) =>
          entry.kind === "plan-revision" &&
          entry.taskId === binding.taskId &&
          entry.planRevision === binding.planRevision,
      ),
      gates: records.filter(
        (entry) =>
          entry.kind === "gate" &&
          [binding.authorizationGateId, binding.specificationGateId, binding.planGateId].includes(
            entry.recordId,
          ),
      ),
    });
  };
  const forInstance: PiManagedRuntime["Service"]["forInstance"] = (instance) =>
    guard(
      Effect.gen(function* () {
        const agentDirectory = instance.configuration.agentDirectory ?? options.agentDirectory;
        const active = new Map<
          ThreadId,
          {
            readonly prepared: PiManagedPreparedOperation;
            readonly stop: Effect.Effect<void, PiManagedRuntimeError>;
          }
        >();
        const sessionFor = (
          authority: ProjectTeamAuthority,
          native?: PiNativeReference,
        ): ProviderSession => ({
          provider,
          providerInstanceId: instance.instanceId,
          threadId: authority.binding.threadId,
          status: "ready",
          runtimeMode: "approval-required",
          cwd: authority.binding.worktree,
          model: authority.binding.model,
          createdAt: IsoDateTime.make(authority.binding.updatedAt),
          updatedAt: IsoDateTime.make(authority.binding.updatedAt),
          ...(native ? { resumeCursor: native } : {}),
        });
        const identity = (threadId: ThreadId) => ({
          providerInstanceId: instance.instanceId,
          threadId,
        });
        const inspect = guard(
          Effect.gen(function* () {
            const native = yield* configuration(agentDirectory);
            const checkedAt = DateTime.formatIso(yield* DateTime.now);
            return buildServerProvider({
              presentation: { displayName: "Pi Agent" },
              enabled: instance.enabled,
              checkedAt,
              models: [
                { slug: model, name: "Ling 3.1 Flash (free)", isCustom: false, capabilities: {} },
              ],
              probe: {
                installed: true,
                version: "0.99.1",
                status: "ready",
                auth: { status: "unknown" },
                message: `Managed Linux runtime; catalogue checked ${native.catalogue.fetchedAt}.`,
              },
            });
          }),
        );
        const prepareOperation: PiManagedRuntimeInstance["prepareOperation"] = (request, observe) =>
          guard(
            Effect.gen(function* () {
              if (!instance.enabled) return yield* deny("Pi instance disabled");
              const authority = yield* operations.current(
                identity(request.threadId),
                request.kind === "initialize",
              );
              const binding = authority.binding;
              if (
                (request.cwd !== undefined && request.cwd !== binding.worktree) ||
                (request.runtimeMode !== undefined &&
                  request.runtimeMode !== "approval-required") ||
                (request.modelSelection !== undefined &&
                  (request.modelSelection.instanceId !== instance.instanceId ||
                    request.modelSelection.model !== binding.model))
              )
                return yield* deny("Pi caller hints differ from durable assignment");
              if (
                binding.configuration.runtimeVersion !== "0.99.1" ||
                binding.configuration.instructionsHash !== digest(authority.role.instructions)
              )
                return yield* deny("Pi frozen runtime or instructions digest mismatch");
              if (binding.configuration.skillIds.length || authority.role.skills.length)
                return yield* deny("Pi managed skill delivery is unavailable", "unavailable");
              const supported = new Set([
                "project-work.read-project",
                "project-work.read-task",
                "project-work.write",
              ]);
              if (
                binding.configuration.toolIds.some(
                  (tool) => !supported.has(tool) || !authority.role.tools.includes(tool),
                )
              )
                return yield* deny("Pi profile includes an unsupported tool", "unavailable");
              yield* verifyWorkspace(authority);
              const nativeConfig = yield* configuration(agentDirectory, authority);
              const previous =
                request.kind === "initialize" && binding.status === "reserved"
                  ? undefined
                  : yield* operations.nativeFor(identity(request.threadId));
              if (
                request.resumeCursor !== undefined &&
                encode(request.resumeCursor) !== encode(previous?.native ?? null)
              )
                return yield* deny("Pi resume hint differs from durable native identity");
              const context = contextFor(authority);
              if (Buffer.byteLength(context) > 131072)
                return yield* deny(
                  "Pi current assignment context exceeds its bound",
                  "unavailable",
                );
              const operation: PiWorkerOperation = {
                operationId: yield* crypto.randomUUIDv4,
                operationKind: request.kind,
              };
              const workerId = yield* crypto.randomUUIDv4;
              const workerIdentity = { workerId, generation: binding.generation };
              const nativeStateDirectory =
                options.nativeStateRoot +
                "/" +
                digest(
                  encode([
                    options.environmentId,
                    instance.instanceId,
                    request.threadId,
                    binding.recordId,
                    binding.generation,
                  ]),
                );
              yield* fs.makeDirectory(nativeStateDirectory, { recursive: true, mode: 0o700 });
              if ((yield* fs.realPath(nativeStateDirectory)) !== nativeStateDirectory)
                return yield* deny("Pi native state directory is not canonical");
              const launch: PiManagedLaunch = {
                workspaceRoot: binding.worktree,
                workspaceAccess: "readonly",
                nativeStateRoot: nativeStateDirectory,
                protectedWorkspaceEntries: [".git"],
                protectedRoots: options.protectedRoots,
                runtimeFiles: options.runtimeFiles,
                argv: options.workerArgv(workerIdentity, operation, nativeStateDirectory),
                memoryBytes: options.memoryBytes,
                runtimeSeconds: Math.ceil(nativeConfig.deadlineMs / 1000),
              };
              const allocation = yield* preallocatePiManagedProcess(launch).pipe(
                Effect.provide(services),
              );
              const durable = yield* operations.prepare(
                identity(request.threadId),
                request,
                digest(encode(request)),
                { allocation, workerId, operationId: operation.operationId },
              );
              if (contextFor(durable.authority) !== context)
                return yield* deny("Pi assignment changed before durable handoff", "conflict");
              const turnId = TurnId.make(operation.operationId);
              const translator =
                request.kind === "prompt"
                  ? makePiRuntimeEventTranslator({
                      providerInstanceId: instance.instanceId,
                      threadId: request.threadId,
                      turnId,
                      identity: workerIdentity,
                      operation: { ...operation, operationKind: "prompt" },
                      operationOrdinal: durable.ordinal,
                      ...(previous ? { sessionId: previous.native.sessionId } : {}),
                    })
                  : undefined;
              const tools: PiModelTool[] = [];
              const toolCapabilities: import("./PiSessionRuntime.ts").PiSessionToolCapability[] =
                [];
              for (const [name, capability] of [
                [
                  "project_work_read",
                  binding.configuration.toolIds.includes("project-work.read-project")
                    ? "project-work.read-project"
                    : "project-work.read-task",
                ],
                ["project_work_write", "project-work.write"],
              ] as const) {
                if (!binding.configuration.toolIds.includes(capability)) continue;
                tools.push({
                  type: "function",
                  function: {
                    name,
                    description:
                      name === "project_work_read"
                        ? "Read current assigned project work"
                        : "Write an authorized project work intent",
                    parameters: name === "project_work_read" ? readParameters : writeParameters,
                  },
                });
                toolCapabilities.push({ name, capability, execution: "bridge" });
              }
              const texts = [
                { transferId: "context", text: context },
                ...(request.kind === "prompt"
                  ? [{ transferId: "prompt", text: request.prompt }]
                  : []),
                ...tools.map((tool) => ({
                  transferId: tool.function.name,
                  text: encode(tool.function.parameters),
                })),
              ];
              const descriptor = (transferId: string) => ({
                transferId,
                totalBytes: Buffer.byteLength(
                  texts.find((item) => item.transferId === transferId)!.text,
                ),
              });
              const check = (signal: AbortSignal, workspace = false) =>
                guard(
                  Effect.gen(function* () {
                    if (signal.aborted) return yield* deny("Pi operation canceled");
                    const current = yield* operations.authorize(durable);
                    if (workspace) yield* verifyWorkspace(current);
                    yield* operations.authorize(durable);
                    if (signal.aborted) return yield* deny("Pi operation canceled");
                  }),
                );
              const runtime = yield* makePiSessionRuntime({
                identity: workerIdentity,
                operation,
                bootstrap: {
                  type: "bootstrap",
                  executionMode: "managed",
                  expectedCwd: "/workspace",
                  native: previous?.native ?? null,
                  context: descriptor("context"),
                  prompt: request.kind === "prompt" ? descriptor("prompt") : null,
                  model: {
                    provider: nativeConfig.provider,
                    modelId: nativeConfig.model,
                    api: nativeConfig.api,
                    contextWindow: nativeConfig.contextWindow,
                    maxTokens: nativeConfig.maxOutputTokens,
                    reasoning: false,
                  },
                  allowedTools: tools.map((tool) => ({
                    name: tool.function.name,
                    execution: "bridge",
                    description: tool.function.description,
                    inputSchema: descriptor(tool.function.name),
                  })),
                },
                transferTexts: texts,
                launch,
                persistence: operations.persistence(durable),
                toolCapabilities,
                deadlineMs: Math.max(
                  1,
                  Math.min(
                    nativeConfig.deadlineMs,
                    durable.deadlineAtMs - (yield* Clock.currentTimeMillis),
                  ),
                ),
                cleanupDeadlineMs: options.cleanupDeadlineMs,
                authorizeCurrent: (input, signal) =>
                  perform(
                    check(
                      signal,
                      [
                        "beforeAcquire",
                        "beforeStart",
                        "beforeToolInvoke",
                        "beforeToolReturn",
                      ].includes(input.phase),
                    ).pipe(
                      Effect.andThen(
                        input.tool
                          ? authorization.capability(
                              durable.principal,
                              input.tool.capability,
                              binding.projectId,
                            )
                          : Effect.void,
                      ),
                    ),
                  ),
                executeBridgeTool: (call, input, signal) =>
                  perform(
                    guard(
                      Effect.gen(function* () {
                        yield* check(signal);
                        let result: unknown;
                        if (call.toolName === "project_work_read")
                          result = yield* gateway.read(
                            yield* decodeReadIntent(input.arguments),
                            durable.principal,
                          );
                        else if (call.toolName === "project_work_write") {
                          const envelope = yield* decodeWriteEnvelope(input.arguments);
                          if (Buffer.byteLength(envelope.intentJSON) > 262144)
                            return yield* deny("Pi write intent exceeds its bound");
                          result = yield* gateway.write(
                            yield* decodeWriteIntentJSON(envelope.intentJSON),
                            durable.principal.actor,
                            { kind: "mcp", id: workerId },
                            durable.principal,
                          );
                        } else return yield* deny("Pi bridge tool unavailable", "unavailable");
                        yield* check(signal);
                        return { kind: "text" as const, text: encode(result) };
                      }),
                    ),
                  ),
                persistNative: (frame, signal) =>
                  perform(
                    guard(
                      Effect.gen(function* () {
                        yield* check(signal);
                        if (!("native" in frame.message))
                          return yield* deny("Pi native receipt absent");
                        yield* operations.persistNative(durable, frame.message.native);
                        yield* check(signal);
                      }),
                    ),
                  ),
                onSdkEvent: () => Promise.resolve(),
                onWorkerFrame: (frame, signal) =>
                  perform(
                    guard(
                      Effect.gen(function* () {
                        yield* check(signal);
                        if (!translator) return;
                        const translated = translator.accept(
                          frame,
                          IsoDateTime.make(DateTime.formatIso(yield* DateTime.now)),
                        );
                        for (const event of translated.events) {
                          yield* check(signal);
                          yield* observe(event);
                        }
                        yield* check(signal);
                      }),
                    ),
                  ),
                persistControl: (receipt, signal) =>
                  perform(
                    guard(
                      Effect.gen(function* () {
                        if (receipt.status === "received") yield* check(signal);
                        yield* operations.persistControl(durable, receipt);
                        if (receipt.status === "received") yield* check(signal);
                      }),
                    ),
                  ),
                persistTerminal: (terminal) =>
                  perform(operations.persistTerminal(durable, terminal)),
                broker: {
                  ...workerIdentity,
                  operationId: operation.operationId,
                  routeId,
                  provider: nativeConfig.provider,
                  model: nativeConfig.model,
                  endpoint: nativeConfig.endpoint,
                  acceptedReportedModels: [model, "inclusionai/ling-3.1-flash"],
                  tools,
                  maxInputTokens: nativeConfig.maxInputTokens,
                  maxOutputTokens: nativeConfig.maxOutputTokens,
                  deadlineMs: Math.max(
                    1,
                    Math.min(
                      30000,
                      Math.floor((durable.deadlineAtMs - (yield* Clock.currentTimeMillis)) / 2),
                    ),
                  ),
                  authorizeCurrent: (_phase, signal) => perform(check(signal)),
                  getCredential: (signal) =>
                    perform(
                      check(signal).pipe(
                        Effect.andThen(readPiSavedLiteralCredential(agentDirectory)),
                        Effect.map(Redacted.value),
                      ),
                    ),
                  reserveRequest: (reservation, signal) =>
                    perform(
                      guard(
                        check(signal).pipe(
                          Effect.andThen(accounting.reserve(durable.principal, reservation)),
                          Effect.flatMap((receipt) =>
                            receipt.status === "existing"
                              ? Effect.fail(deny("Pi model request already reserved", "conflict"))
                              : Effect.succeed({ reservationId: receipt.reservationId }),
                          ),
                        ),
                      ),
                    ),
                  settleRequest: (settlement) => perform(accounting.settle(settlement)),
                  transport: options.transport,
                },
              });
              let controlId = 0;
              const done = Promise.withResolvers<void>();
              let started = false;
              const cancellation = new AbortController();
              let execution: Promise<import("./PiSessionRuntime.ts").PiSessionTerminal> | undefined;
              const run = Effect.suspend(() => {
                let ownsRun = false;
                return guard(
                  Effect.gen(function* () {
                    if (started) return yield* deny("Pi operation already attempted", "conflict");
                    yield* operations.assertIndependent();
                    if (started) return yield* deny("Pi operation already attempted", "conflict");
                    started = true;
                    ownsRun = true;
                    const terminal = yield* Effect.tryPromise({
                      try: (signal) => {
                        execution = perform(Effect.scoped(runtime.run()), {
                          signal: AbortSignal.any([signal, cancellation.signal]),
                        });
                        return execution;
                      },
                      catch: () => deny("Pi operation requires reconciliation", "uncertain"),
                    }).pipe(Effect.onInterrupt(() => Effect.sync(() => cancellation.abort())));
                    const current = yield* operations.current(identity(request.threadId));
                    if (terminal.outcome !== "success")
                      return yield* deny("Pi operation requires reconciliation", "uncertain");
                    return { terminal, session: sessionFor(current, terminal.native ?? undefined) };
                  }),
                ).pipe(
                  Effect.ensuring(
                    Effect.suspend(() =>
                      ownsRun
                        ? Effect.gen(function* () {
                            cancellation.abort();
                            if (execution)
                              yield* Effect.promise(() =>
                                execution!.then(
                                  () => {},
                                  () => {},
                                ),
                              );
                            if (
                              active.get(request.threadId)?.prepared.operation.operationId ===
                              operation.operationId
                            )
                              active.delete(request.threadId);
                            done.resolve();
                          })
                        : Effect.void,
                    ),
                  ),
                );
              });
              const steer: PiManagedPreparedOperation["steer"] = (kind, text) =>
                guard(
                  runtime
                    .control({ type: "control", controlId: ++controlId, kind, text })
                    .pipe(Effect.as({ controlId, status: "received" as const })),
                );
              const interrupt = guard(
                Effect.suspend(() => {
                  const id = ++controlId;
                  return runtime
                    .interrupt(id)
                    .pipe(Effect.as({ controlId: id, status: "received" as const }));
                }),
              );
              const prepared: PiManagedPreparedOperation =
                request.kind === "prompt"
                  ? { kind: "prompt", turnId, operation, run, steer, interrupt }
                  : { kind: request.kind, operation, run, steer, interrupt };
              const stop = guard(
                Effect.uninterruptible(
                  Effect.gen(function* () {
                    if (!started) {
                      started = true;
                      yield* operations.persistTerminal(durable, {
                        identity: workerIdentity,
                        operation,
                        outcome: "canceled",
                        ownerCaptured: false,
                        native: null,
                        drain: null,
                        accountingReceipts: [],
                      });
                      if (
                        active.get(request.threadId)?.prepared.operation.operationId ===
                        operation.operationId
                      )
                        active.delete(request.threadId);
                      done.resolve();
                      return;
                    }
                    cancellation.abort();
                    yield* Effect.promise(() => done.promise);
                  }),
                ),
              );
              active.set(request.threadId, { prepared, stop });
              return prepared;
            }),
          );
        const requestStop = (threadId: ThreadId) =>
          guard(
            Effect.gen(function* () {
              const running = active.get(threadId);
              if (!running) {
                yield* operations.current(identity(threadId));
                return;
              }
              yield* running.stop;
            }),
          );
        const stopAll = Effect.suspend(() =>
          Effect.forEach([...active.keys()], requestStop, { discard: true }),
        ).pipe(Effect.asVoid);
        yield* Effect.addFinalizer(() =>
          Effect.suspend(() =>
            Effect.forEach([...active.keys()], requestStop, { discard: true }),
          ).pipe(Effect.catch(() => Effect.void)),
        );
        return {
          inspect,
          prepareOperation,
          requestStop,
          stopAll,
          readSession: (threadId: ThreadId) =>
            guard(
              operations
                .current(identity(threadId))
                .pipe(Effect.map((authority) => sessionFor(authority))),
            ),
          readThread: (threadId: ThreadId) =>
            guard(
              Effect.gen(function* () {
                const committed = yield* operations.nativeFor(identity(threadId));
                const native = yield* Effect.tryPromise({
                  try: () =>
                    readPiNativeSession({
                      sessionDirectoryRoot:
                        options.nativeStateRoot +
                        "/" +
                        digest(
                          encode([
                            options.environmentId,
                            instance.instanceId,
                            threadId,
                            committed.authority.binding.recordId,
                            committed.authority.binding.generation,
                          ]),
                        ) +
                        "/sessions",
                      expectedCwd: "/workspace",
                      native: committed.native,
                    }),
                  catch: () => deny("Pi native session read unavailable", "unavailable"),
                }).pipe(Effect.uninterruptible);
                const current = yield* operations.nativeFor(identity(threadId));
                if (
                  current.operationId !== committed.operationId ||
                  encode(current.native) !== encode(committed.native)
                )
                  return yield* deny("Pi native reference changed", "conflict");
                return {
                  threadId,
                  turns: [
                    {
                      id: TurnId.make(committed.operationId),
                      items: native.selectedBranch.map((entry) => entry.payload),
                    },
                  ],
                };
              }),
            ),
          authorizeSkills: () =>
            Effect.fail(deny("Pi managed skill delivery unavailable", "unavailable")),
          discoverNativeSkills: () =>
            Effect.fail(deny("Pi native extension discovery unavailable", "unavailable")),
        };
      }),
    );
  return PiManagedRuntime.of({ forInstance });
});
export const piManagedRuntimeLayer = (options: PiManagedRuntimeLiveOptions) =>
  Layer.effect(PiManagedRuntime, makePiManagedRuntimeLive(options));
