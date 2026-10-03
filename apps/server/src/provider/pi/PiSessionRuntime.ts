import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  acquirePiManagedProcess,
  type PiManagedDrain,
  type PiManagedLaunch,
  type PiManagedProcessPersistence,
} from "./PiManagedProcess.ts";
import {
  makePiModelBroker,
  type PiModelAccountingReceipt,
  type PiModelBrokerConfig,
} from "./PiModelBroker.ts";
import {
  decodePiWorkerFrame,
  encodePiParentFrame,
  makePiWorkerDispatchQueue,
  makePiWorkerLineFramer,
  makePiWorkerProtocol,
  PI_WORKER_MAX_CHUNK_BYTES,
  PI_WORKER_MAX_EVENT_BYTES,
  PI_WORKER_MAX_TOOL_BYTES,
  PiWorkerBootstrap,
  PiWorkerIdentity,
  PiWorkerOperation,
  PiWorkerToolInput,
  PiWorkerToolOutput,
  type PiNativeReference,
  type PiParentFrame,
  type PiWorkerControl,
  type PiWorkerFrame,
  type PiWorkerToolCall,
} from "./PiWorkerProtocol.ts";

export class PiSessionRuntimeError extends Schema.TaggedError<PiSessionRuntimeError>()(
  "PiSessionRuntimeError",
  { code: Schema.String },
) {}
const failure = (code: string) => new PiSessionRuntimeError({ code });
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Json));
const output = Schema.decodeUnknownSync(PiWorkerToolOutput, { onExcessProperty: "error" });
const strict = { onExcessProperty: "error" } as const;
const decodeIdentity = Schema.decodeSync(PiWorkerIdentity, strict);
const decodeOperation = Schema.decodeSync(PiWorkerOperation, strict);
const decodeBootstrap = Schema.decodeSync(PiWorkerBootstrap, strict);
const isRuntimeError = Schema.is(PiSessionRuntimeError);

export interface PiSessionToolCapability {
  readonly name: string;
  readonly execution: "local" | "bridge";
  readonly capability: string;
}
export interface PiSessionAuthorization {
  readonly identity: PiWorkerIdentity;
  readonly operation: PiWorkerOperation;
  readonly phase:
    | "beforeAcquire"
    | "beforeStart"
    | "beforeTool"
    | "beforeToolInvoke"
    | "beforeToolReturn"
    | "beforeControl";
  readonly tool?: PiSessionToolCapability;
}
export interface PiSessionTerminal {
  readonly identity: PiWorkerIdentity;
  readonly operation: PiWorkerOperation;
  readonly outcome: "success" | "failed" | "canceled" | "quarantine";
  readonly ownerCaptured: boolean;
  readonly native: PiNativeReference | null;
  readonly drain: PiManagedDrain | null;
  readonly accountingReceipts: readonly PiModelAccountingReceipt[];
  readonly failureCode?: string;
}
export interface PiSessionRuntimeOptions {
  readonly identity: PiWorkerIdentity;
  readonly operation: PiWorkerOperation;
  readonly bootstrap: PiWorkerBootstrap;
  readonly transferTexts: ReadonlyArray<{ readonly transferId: string; readonly text: string }>;
  readonly launch: PiManagedLaunch;
  readonly persistence: PiManagedProcessPersistence;
  readonly broker: PiModelBrokerConfig;
  readonly toolCapabilities: readonly PiSessionToolCapability[];
  readonly deadlineMs: number;
  readonly cleanupDeadlineMs: number;
  // All callbacks must honor their signal. An unjoined callback quarantines the run.
  readonly authorizeCurrent: (
    request: PiSessionAuthorization,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly executeBridgeTool: (
    call: PiWorkerToolCall,
    input: typeof PiWorkerToolInput.Type,
    signal: AbortSignal,
  ) => Promise<typeof PiWorkerToolOutput.Type>;
  readonly persistNative: (frame: PiWorkerFrame, signal: AbortSignal) => Promise<void>;
  readonly onSdkEvent: (frame: PiWorkerFrame, signal: AbortSignal) => Promise<void>;
  // Observations are sequential. Never await later frames or model completion here.
  readonly onWorkerFrame?: (frame: PiWorkerFrame, signal: AbortSignal) => Promise<void>;
  readonly persistControl: (
    receipt: {
      readonly identity: PiWorkerIdentity;
      readonly operation: PiWorkerOperation;
      readonly controlId: number;
      readonly kind: "steer" | "follow-up" | "interrupt";
      readonly status: "received" | "unresolved";
    },
    signal: AbortSignal,
  ) => Promise<void>;
  readonly persistTerminal: (terminal: PiSessionTerminal, signal: AbortSignal) => Promise<void>;
}

function canonical(value: Schema.Json): string {
  if (value === null || typeof value !== "object") return json(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${json(key)}:${canonical(entry)}`)
    .join(",")}}`;
}
function freezeJson<A>(value: A): A {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) freezeJson(entry);
    Object.freeze(value);
  }
  return value;
}
function waitSignal<A>(promise: Promise<A>, signal: AbortSignal): Promise<A> {
  if (signal.aborted) return Promise.reject(failure("CANCELED"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure("CANCELED"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** One frozen operation owns one captured process. Durable authority remains in the injected parent. */
function captureOptions(input: PiSessionRuntimeOptions) {
  const identity = Object.freeze(decodeIdentity(input.identity));
  const operation = Object.freeze(decodeOperation(input.operation));
  const bootstrap = freezeJson(decodeBootstrap(structuredClone(input.bootstrap)));
  const broker = {
    ...input.broker,
    tools: freezeJson(structuredClone(input.broker.tools)),
    acceptedReportedModels: Object.freeze([...input.broker.acceptedReportedModels]),
  };
  const texts = new Map(input.transferTexts.map((item) => [item.transferId, item.text]));
  const descriptors = [
    bootstrap.context,
    ...(bootstrap.prompt ? [bootstrap.prompt] : []),
    ...bootstrap.allowedTools.flatMap((tool) => (tool.inputSchema ? [tool.inputSchema] : [])),
  ];
  if (
    texts.size !== input.transferTexts.length ||
    descriptors.length !== texts.size ||
    new Set(descriptors.map((item) => item.transferId)).size !== descriptors.length
  )
    throw failure("TRANSFER_CONFIGURATION");
  for (const descriptor of descriptors)
    if (
      Buffer.byteLength(texts.get(descriptor.transferId) ?? "") !== descriptor.totalBytes ||
      !texts.has(descriptor.transferId)
    )
      throw failure("TRANSFER_CONFIGURATION");
  if (
    bootstrap.executionMode !== "managed" ||
    bootstrap.expectedCwd !== "/workspace" ||
    broker.workerId !== identity.workerId ||
    broker.generation !== identity.generation ||
    broker.operationId !== operation.operationId ||
    broker.provider !== bootstrap.model.provider ||
    broker.model !== bootstrap.model.modelId ||
    broker.maxOutputTokens !== bootstrap.model.maxTokens
  )
    throw failure("BROKER_CONFIGURATION");
  const capabilities = new Map(
    input.toolCapabilities.map((tool) => [tool.name, Object.freeze({ ...tool })]),
  );
  if (
    capabilities.size !== input.toolCapabilities.length ||
    capabilities.size !== bootstrap.allowedTools.length ||
    broker.tools.length !== bootstrap.allowedTools.length
  )
    throw failure("TOOL_CONFIGURATION");
  for (const tool of bootstrap.allowedTools) {
    const capability = capabilities.get(tool.name);
    const modelTool = broker.tools.find((item) => item.function.name === tool.name);
    if (
      !capability?.capability ||
      capability.execution !== tool.execution ||
      !modelTool ||
      modelTool.function.description !== tool.description ||
      !tool.inputSchema ||
      canonical(decodeJson(texts.get(tool.inputSchema.transferId)!)) !==
        canonical(modelTool.function.parameters)
    )
      throw failure("TOOL_CONFIGURATION");
  }
  if (
    !Number.isSafeInteger(input.deadlineMs) ||
    input.deadlineMs < 1 ||
    input.deadlineMs > 300_000 ||
    !Number.isSafeInteger(input.cleanupDeadlineMs) ||
    input.cleanupDeadlineMs < 1 ||
    input.cleanupDeadlineMs > 30_000 ||
    !input.persistence ||
    (input.onWorkerFrame !== undefined && typeof input.onWorkerFrame !== "function") ||
    [
      input.authorizeCurrent,
      input.executeBridgeTool,
      input.persistNative,
      input.onSdkEvent,
      input.persistControl,
      input.persistTerminal,
      input.persistence.claimActivation,
      input.persistence.beforeStart,
    ].some((callback) => typeof callback !== "function")
  )
    throw failure("CALLBACK_CONFIGURATION");
  // Construct before process effects so route and callback validation cannot occur after START.
  makePiModelBroker(broker);
  const protocol = makePiWorkerProtocol(identity, operation);
  protocol.acceptParent({ version: 1, ...identity, ...operation, sequence: 0, message: bootstrap });
  let sequence = 1;
  for (const descriptor of descriptors) {
    const bytes = Buffer.from(texts.get(descriptor.transferId)!);
    for (
      let offset = 0, index = 0;
      offset < bytes.length;
      offset += PI_WORKER_MAX_CHUNK_BYTES, index++
    )
      protocol.acceptParent({
        version: 1,
        ...identity,
        ...operation,
        sequence: sequence++,
        message: {
          type: "transfer-chunk",
          transferId: descriptor.transferId,
          index,
          offset,
          data: bytes.subarray(offset, offset + PI_WORKER_MAX_CHUNK_BYTES).toString("base64"),
        },
      });
    protocol.acceptParent({
      version: 1,
      ...identity,
      ...operation,
      sequence: sequence++,
      message: { type: "transfer-end", transferId: descriptor.transferId },
    });
    protocol.takeTransfer(descriptor.transferId);
  }
  return { identity, operation, bootstrap, broker, texts, descriptors, capabilities };
}

export const makePiSessionRuntime = Effect.fn("makePiSessionRuntime")(function* (
  input: PiSessionRuntimeOptions,
) {
  const captured = yield* Effect.try({
    try: () => captureOptions(input),
    catch: (error) => (isRuntimeError(error) ? error : failure("CONFIGURATION_INVALID")),
  });
  const {
    identity,
    operation,
    bootstrap,
    broker: brokerConfig,
    texts,
    descriptors,
    capabilities,
  } = captured;
  const callbacks = { ...input };
  const deadlineMs = input.deadlineMs;
  const cleanupDeadlineMs = input.cleanupDeadlineMs;
  const launch = freezeJson(structuredClone(input.launch));
  const persistence = {
    ...input.persistence,
    allocation: freezeJson(structuredClone(input.persistence.allocation)),
  };
  let used = false;
  const runFinished = Promise.withResolvers<void>();
  let finalizing = false;
  let unresolvedInRun:
    | ((controlId: number, kind: "steer" | "follow-up" | "interrupt") => Promise<void>)
    | undefined;
  let cancelActive: (() => void) | undefined;
  let activeControl: ((message: PiParentFrame["message"]) => Promise<void>) | undefined;
  const run = Effect.fn("PiSessionRuntime.run")(function* () {
    if (used) return yield* failure("RUN_ALREADY_ATTEMPTED");
    used = true;
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const controller = new AbortController();
        const deadline = AbortSignal.timeout(deadlineMs);
        let canceled = false;
        const abort = () => {
          canceled = true;
          controller.abort();
        };
        deadline.addEventListener("abort", abort, { once: true });
        const pending = new Set<Promise<unknown>>();
        let native: PiNativeReference | null = null;
        let drain: PiManagedDrain | null = null;
        let ownerCaptured = false;
        let activationAttempted = false;
        let terminal: PiSessionTerminal | undefined;
        let unresolvedPersistenceFailed = false;
        const accountingReceipts: PiModelAccountingReceipt[] = [];
        const tracked = <A>(promise: Promise<A>) => {
          pending.add(promise);
          promise.then(
            () => pending.delete(promise),
            () => pending.delete(promise),
          );
          return promise;
        };
        const callback = <A>(body: () => Promise<A>, signal = controller.signal) =>
          waitSignal(tracked(Promise.resolve().then(body)), signal);
        unresolvedInRun = (controlId, kind) => {
          const signal = AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(cleanupDeadlineMs),
          ]);
          return callback(
            () =>
              callbacks.persistControl(
                { identity, operation, controlId, kind, status: "unresolved" },
                signal,
              ),
            signal,
          ).then(
            () => {
              throw failure("OPERATION_NOT_ACTIVE");
            },
            (error) => {
              unresolvedPersistenceFailed = true;
              throw error;
            },
          );
        };
        const authorize = (
          phase: PiSessionAuthorization["phase"],
          tool?: PiSessionToolCapability,
        ) =>
          callback(() =>
            callbacks.authorizeCurrent(
              { identity, operation, phase, ...(tool ? { tool } : {}) },
              controller.signal,
            ),
          );
        const promiseEffect = <A>(body: () => Promise<A>) =>
          Effect.tryPromise({
            try: body,
            catch: (error) => (isRuntimeError(error) ? error : failure("OPERATION_FAILED")),
          });
        const execute = Effect.gen(function* () {
          yield* promiseEffect(() => authorize("beforeAcquire"));
          const child = yield* acquirePiManagedProcess(launch, {
            ...persistence,
            claimActivation: (allocation) =>
              Effect.sync(() => {
                activationAttempted = true;
              }).pipe(Effect.andThen(persistence.claimActivation(allocation))),
            beforeStart: (owner) =>
              Effect.sync(() => {
                ownerCaptured = true;
              }).pipe(Effect.andThen(persistence.beforeStart(owner))),
          });
          const services = yield* Effect.context<never>();
          const perform = Effect.runPromiseWith(services);
          const protocol = makePiWorkerProtocol(identity, operation);
          let parentSequence = 0;
          let fatal: unknown;
          let readerEnded = false;
          let stderrBytes = 0;
          let closing = false;
          const modelController = new AbortController();
          const modelSignal = AbortSignal.any([controller.signal, modelController.signal]);
          let exitTask: Promise<PiManagedDrain> | undefined;
          let brokerTask: Promise<void> | undefined;
          let toolTask: Promise<void> | undefined;
          let toolCall: PiWorkerToolCall | undefined;
          let localOutput:
            | { readonly transferId: string; readonly capability: PiSessionToolCapability }
            | undefined;
          let toolStarted = Promise.withResolvers<void>();
          let ack:
            | {
                requestId: number;
                sequence: number;
                receipt: ReturnType<typeof Promise.withResolvers<void>>;
              }
            | undefined;
          let control:
            | {
                id: number;
                kind: "steer" | "follow-up" | "interrupt";
                receipt: ReturnType<typeof Promise.withResolvers<void>>;
              }
            | undefined;
          const completed = Promise.withResolvers<void>();
          // A rejection is observed immediately; the main join still determines the outcome.
          completed.promise.catch(() => {});
          let wake = Promise.withResolvers<void>();
          let flushed = Promise.withResolvers<void>();
          const fail = (error: unknown) => {
            const first = fatal === undefined;
            fatal ??= error;
            if (first && isRuntimeError(error) && error.code === "CANCELED") canceled = true;
            controller.abort();
            completed.reject(error);
            wake.resolve();
          };
          const outbound = makePiWorkerDispatchQueue(async (raw) => {
            const bytes = Buffer.from(raw + "\n");
            for (let offset = 0; offset < bytes.length; offset += PI_WORKER_MAX_CHUNK_BYTES)
              await perform(child.send(bytes.subarray(offset, offset + PI_WORKER_MAX_CHUNK_BYTES)));
          });
          const send = (message: PiParentFrame["message"]) => {
            if (fatal || controller.signal.aborted) throw failure("CANCELED");
            const frame = {
              version: 1 as const,
              ...identity,
              ...operation,
              sequence: parentSequence,
              message,
            };
            const encoded = encodePiParentFrame(frame);
            protocol.acceptParent(frame);
            outbound.push(encoded.toString("utf8").slice(0, -1));
            parentSequence++;
            wake.resolve();
            return frame.sequence;
          };
          const transfer = async (transferId: string, text: string) => {
            const bytes = Buffer.from(text);
            for (
              let offset = 0, index = 0;
              offset < bytes.length;
              offset += PI_WORKER_MAX_CHUNK_BYTES, index++
            ) {
              send({
                type: "transfer-chunk",
                transferId,
                index,
                offset,
                data: bytes.subarray(offset, offset + PI_WORKER_MAX_CHUNK_BYTES).toString("base64"),
              });
              if ((index + 1) % 8 === 0) await waitSignal(flushed.promise, controller.signal);
            }
            send({ type: "transfer-end", transferId });
            await waitSignal(flushed.promise, controller.signal);
          };
          const writer = tracked(
            (async () => {
              while (true) {
                await wake.promise;
                wake = Promise.withResolvers<void>();
                if (closing || controller.signal.aborted) break;
                await outbound.drain();
                flushed.resolve();
                flushed = Promise.withResolvers<void>();
              }
              if (!controller.signal.aborted) {
                await outbound.drain();
                outbound.finish();
              } else outbound.abort();
            })().catch(fail),
          );
          const broker = makePiModelBroker({
            ...brokerConfig,
            authorizeCurrent: (phase, signal) =>
              callback(() => brokerConfig.authorizeCurrent(phase, signal), signal),
            getCredential: (signal) => callback(() => brokerConfig.getCredential(signal), signal),
            reserveRequest: (reservation, signal) =>
              callback(() => brokerConfig.reserveRequest(reservation, signal), signal),
            settleRequest: (settlement) => tracked(brokerConfig.settleRequest(settlement)),
            transport: (endpoint, init) =>
              callback(async () => {
                const response = await brokerConfig.transport(endpoint, init);
                if (init.signal.aborted) {
                  await response.body?.cancel();
                  throw failure("CANCELED");
                }
                return response;
              }, init.signal),
          });
          const dispatch = async (raw: string) => {
            const frame = freezeJson(decodePiWorkerFrame(raw));
            protocol.acceptWorker(frame);
            if (
              frame.message.type === "transfer-end" &&
              localOutput?.transferId === frame.message.transferId
            ) {
              await authorize("beforeToolReturn", localOutput.capability);
              localOutput = undefined;
            }
            const observer = callbacks.onWorkerFrame;
            if (observer) await callback(() => observer(frame, controller.signal));
            const message = frame.message;
            switch (message.type) {
              case "request": {
                if (brokerTask) throw failure("MODEL_TASK_CONCURRENT");
                send({ type: "headers", requestId: message.requestId, status: 200 });
                brokerTask = tracked(
                  (async () => {
                    const receipt = await broker.request({
                      requestId: message.requestId,
                      body: message.body,
                      signal: modelSignal,
                      onChunk: async (chunk, signal) => {
                        if (ack) throw failure("ACK_CONCURRENT");
                        const receipt = Promise.withResolvers<void>();
                        // Install before write, since a receipt can arrive before the writer returns.
                        ack = { requestId: message.requestId, sequence: parentSequence, receipt };
                        send({
                          type: "chunk",
                          requestId: message.requestId,
                          data: Buffer.from(chunk).toString("base64"),
                        });
                        await waitSignal(receipt.promise, signal);
                      },
                    });
                    accountingReceipts.push(Object.freeze(receipt));
                    send({ type: "end", requestId: message.requestId });
                  })().then(
                    () => {
                      brokerTask = undefined;
                    },
                    (error) => {
                      if (control?.kind !== "interrupt") fail(error);
                    },
                  ),
                );
                break;
              }
              case "ack":
                if (
                  !ack ||
                  ack.requestId !== message.requestId ||
                  ack.sequence !== message.chunkSequence
                )
                  throw failure("ACK_MISMATCH");
                ack.receipt.resolve();
                ack = undefined;
                break;
              case "cancel":
                fail(failure("CANCELED"));
                break;
              case "worker-failure":
                fail(failure(message.code));
                break;
              case "tool-call":
                toolCall = message;
                toolStarted = Promise.withResolvers<void>();
                break;
              case "tool-result": {
                const capability = toolCall && capabilities.get(toolCall.toolName);
                if (
                  !toolCall ||
                  toolCall.callId !== message.callId ||
                  !capability ||
                  capability.execution !== "local" ||
                  localOutput
                )
                  throw failure("TOOL_CAPABILITY_INVALID");
                localOutput = { transferId: message.output.transferId, capability };
                break;
              }
              case "transfer-end": {
                if (!toolCall || message.transferId !== toolCall.input.transferId) break;
                if (toolTask) throw failure("TOOL_TASK_CONCURRENT");
                const call = toolCall;
                const value = freezeJson(protocol.takeTransfer(message.transferId));
                if (value.purpose !== "tool-input") throw failure("TOOL_INPUT_INVALID");
                const capability = capabilities.get(call.toolName);
                if (!capability || capability.execution !== call.execution)
                  throw failure("TOOL_CAPABILITY_INVALID");
                toolTask = tracked(
                  (async () => {
                    await authorize("beforeTool", capability);
                    if (call.execution === "local") await authorize("beforeToolInvoke", capability);
                    send({ type: "tool-authorized", callId: call.callId, allowed: true });
                    if (call.execution === "local") return;
                    await waitSignal(toolStarted.promise, controller.signal);
                    await authorize("beforeToolInvoke", capability);
                    const result = freezeJson(
                      output(
                        structuredClone(
                          await callback(() =>
                            callbacks.executeBridgeTool(call, value.value, controller.signal),
                          ),
                        ),
                      ),
                    );
                    const text = json(result);
                    if (Buffer.byteLength(text) + call.input.totalBytes > PI_WORKER_MAX_TOOL_BYTES)
                      throw failure("TOOL_OUTPUT_LIMIT");
                    await authorize("beforeToolReturn", capability);
                    const transferId = `parent_tool_${call.callId}`;
                    send({
                      type: "tool-result",
                      callId: call.callId,
                      output: { transferId, totalBytes: Buffer.byteLength(text) },
                    });
                    await transfer(transferId, text);
                  })().then(
                    () => {
                      toolTask = undefined;
                    },
                    (error) => fail(error),
                  ),
                );
                break;
              }
              case "sdk-event":
                if (message.event.type === "tool_start") toolStarted.resolve();
                if (message.event.type === "tool_end") toolCall = undefined;
                await callback(() => callbacks.onSdkEvent(frame, controller.signal));
                break;
              case "native":
              case "compacted":
              case "initialized":
                await callback(() => callbacks.persistNative(frame, controller.signal));
                native = Object.freeze({ ...message.native });
                if (message.type === "initialized") completed.resolve();
                break;
              case "done":
                completed.resolve();
                break;
              case "control-receipt":
                if (!control || message.controlId !== control.id || message.kind !== control.kind)
                  throw failure("CONTROL_RECEIPT_MISMATCH");
                await callback(() =>
                  callbacks.persistControl(
                    {
                      identity,
                      operation,
                      controlId: control!.id,
                      kind: control!.kind,
                      status: "received",
                    },
                    controller.signal,
                  ),
                );
                control.receipt.resolve();
                control = undefined;
                if (message.kind === "interrupt") {
                  await Promise.resolve();
                  fail(failure("CANCELED"));
                }
                break;
            }
          };
          const inbound = makePiWorkerDispatchQueue(dispatch);
          const framer = makePiWorkerLineFramer(inbound.push);
          const reader = tracked(
            perform(
              Stream.runForEach(child.stdout, (chunk) =>
                promiseEffect(async () => {
                  framer.push(chunk);
                  await inbound.drain();
                }),
              ),
            )
              .then(() => {
                readerEnded = true;
                framer.finish();
                inbound.finish();
                if (!protocol.successful) throw failure("EARLY_EOF");
              })
              .catch(fail),
          );
          const stderr = tracked(
            perform(
              Stream.runForEach(child.stderr, (chunk) =>
                Effect.sync(() => {
                  stderrBytes += chunk.byteLength;
                  if (stderrBytes > PI_WORKER_MAX_EVENT_BYTES) fail(failure("STDERR_LIMIT"));
                }),
              ),
            ).catch(fail),
          );
          cancelActive = abort;
          activeControl = async (message) => {
            if (message.type !== "control" && message.type !== "interrupt")
              throw failure("CONTROL_INVALID");
            if (control)
              return unresolvedControl(
                message.controlId,
                message.type === "interrupt" ? "interrupt" : message.kind,
              );
            const pendingControl = {
              id: message.controlId,
              kind: message.type === "interrupt" ? ("interrupt" as const) : message.kind,
              receipt: Promise.withResolvers<void>(),
            };
            control = pendingControl;
            try {
              await authorize("beforeControl");
              send(message);
              if (message.type === "interrupt") modelController.abort();
              await waitSignal(pendingControl.receipt.promise, controller.signal);
            } catch (error) {
              fail(error);
              throw error;
            }
          };
          let cleanupFailure = false;
          let processFailure: unknown;
          const work = Effect.gen(function* () {
            yield* promiseEffect(() => authorize("beforeStart"));
            const childPid = yield* child.start;
            exitTask = tracked(
              perform(child.awaitExit).then(
                (receipt) => {
                  drain = receipt;
                  if (!protocol.successful) fail(failure("EARLY_EXIT"));
                  return receipt;
                },
                (error) => {
                  fail(error);
                  throw error;
                },
              ),
            );
            exitTask.catch(() => {});
            send(bootstrap);
            for (const descriptor of descriptors)
              yield* promiseEffect(() =>
                transfer(descriptor.transferId, texts.get(descriptor.transferId)!),
              );
            yield* promiseEffect(() => waitSignal(completed.promise, controller.signal));
            if (brokerTask) yield* promiseEffect(() => waitSignal(brokerTask!, controller.signal));
            if (toolTask) yield* promiseEffect(() => waitSignal(toolTask!, controller.signal));
            if (!native || !protocol.successful || fatal || controller.signal.aborted)
              return yield* failure("SUCCESS_BARRIER");
            closing = true;
            wake.resolve();
            yield* promiseEffect(() => waitSignal(writer, controller.signal));
            yield* child.endInput.pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  if (
                    error.phase !== "transport" ||
                    error.message !== "Managed input cannot close before start or after exit."
                  )
                    return yield* Effect.fail(error);
                  // A native worker may close first. Accept that race only after its owned drain.
                  const receipt = yield* promiseEffect(() =>
                    waitSignal(exitTask!, controller.signal),
                  );
                  if (
                    receipt.childExitCode !== 0 ||
                    receipt.childPid !== childPid ||
                    receipt.unit !== child.owner.unit ||
                    receipt.invocation !== child.owner.invocation ||
                    receipt.cgroup !== child.owner.cgroup ||
                    receipt.ownerPid !== child.owner.pid ||
                    receipt.memoryBytes !== child.owner.memoryBytes ||
                    receipt.swapBytes !== child.owner.swapBytes ||
                    receipt.oomGroup !== child.owner.oomGroup ||
                    (receipt.kernel !== "removed" &&
                      !receipt.kernel.split("\n").includes("populated 0"))
                  )
                    return yield* Effect.fail(error);
                }),
              ),
            );
            drain = yield* promiseEffect(() => waitSignal(exitTask!, controller.signal));
            yield* promiseEffect(() =>
              waitSignal(
                Promise.all([reader, stderr]).then(() => {}),
                controller.signal,
              ),
            );
            if (fatal || controller.signal.aborted || !readerEnded || drain.childExitCode !== 0)
              return yield* failure("DRAIN_BARRIER");
          });
          const cleanup = Effect.gen(function* () {
            activeControl = undefined;
            cancelActive = undefined;
            closing = true;
            wake.resolve();
            controller.abort();
            const stop = yield* child.stop.pipe(Effect.exit);
            if (stop._tag === "Success") drain = stop.value;
            else {
              cleanupFailure = true;
              processFailure = stop.cause;
            }
            const cleanupSignal = AbortSignal.timeout(cleanupDeadlineMs);
            const joined = yield* promiseEffect(() =>
              waitSignal(
                Promise.allSettled(pending).then(() => {}),
                cleanupSignal,
              ),
            ).pipe(Effect.exit);
            if (joined._tag === "Failure") cleanupFailure = true;
            if (control) {
              const unresolved = {
                identity,
                operation,
                controlId: control.id,
                kind: control.kind,
                status: "unresolved" as const,
              };
              const persisted = yield* promiseEffect(() =>
                callback(() => callbacks.persistControl(unresolved, cleanupSignal), cleanupSignal),
              ).pipe(Effect.exit);
              if (persisted._tag === "Failure") cleanupFailure = true;
            }
            if (unresolvedPersistenceFailed) cleanupFailure = true;
            if (cleanupFailure) {
              terminal = {
                identity,
                operation,
                outcome: "quarantine",
                ownerCaptured,
                native,
                drain,
                accountingReceipts: [...accountingReceipts],
                failureCode: "DRAIN_UNKNOWN",
              };
            }
          });
          yield* work.pipe(
            Effect.onInterrupt(() => Effect.sync(abort)),
            Effect.ensuring(cleanup),
          );
          if (cleanupFailure)
            return yield* failure(processFailure ? "PROCESS_DRAIN_UNKNOWN" : "TASK_DRAIN_UNKNOWN");
          terminal = {
            identity,
            operation,
            outcome: "success",
            ownerCaptured,
            native,
            drain,
            accountingReceipts: [...accountingReceipts],
          };
          return terminal;
        });
        const result = yield* restore(
          execute.pipe(
            Effect.timeoutOrElse({
              duration: deadlineMs,
              orElse: () => Effect.fail(failure("OPERATION_DEADLINE")),
            }),
          ),
        ).pipe(
          Effect.onInterrupt(() => Effect.sync(abort)),
          Effect.exit,
        );
        // Close admission before the final join. Later calls wait for this run's terminal
        // persistence before beginning their standalone unresolved callback.
        finalizing = true;
        unresolvedInRun = undefined;
        deadline.removeEventListener("abort", abort);
        controller.abort();
        const outerJoin = yield* promiseEffect(() =>
          waitSignal(
            Promise.allSettled(pending).then(() => {}),
            AbortSignal.timeout(cleanupDeadlineMs),
          ),
        ).pipe(Effect.exit);
        if (outerJoin._tag === "Failure" || unresolvedPersistenceFailed)
          terminal = {
            identity,
            operation,
            outcome: "quarantine",
            ownerCaptured,
            native,
            drain,
            accountingReceipts: [...accountingReceipts],
            failureCode: "CALLBACK_DRAIN_UNKNOWN",
          };
        if (!terminal)
          terminal = {
            identity,
            operation,
            outcome:
              activationAttempted && !drain ? "quarantine" : canceled ? "canceled" : "failed",
            ownerCaptured,
            native,
            drain,
            accountingReceipts: [...accountingReceipts],
            failureCode: "OPERATION_FAILED",
          };
        yield* promiseEffect(() =>
          waitSignal(
            callbacks.persistTerminal(terminal!, AbortSignal.timeout(cleanupDeadlineMs)),
            AbortSignal.timeout(cleanupDeadlineMs),
          ),
        );
        if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
        if (terminal.outcome === "quarantine") return yield* failure("CALLBACK_DRAIN_UNKNOWN");
        return result.value;
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          unresolvedInRun = undefined;
          finalizing = false;
          runFinished.resolve();
        }),
      ),
    );
  });
  const unresolvedControl = async (
    controlId: number,
    kind: "steer" | "follow-up" | "interrupt",
  ) => {
    if (unresolvedInRun) return unresolvedInRun(controlId, kind);
    if (finalizing)
      await waitSignal(
        runFinished.promise,
        AbortSignal.timeout(deadlineMs + 4 * cleanupDeadlineMs),
      );
    const signal = AbortSignal.timeout(cleanupDeadlineMs);
    return waitSignal(
      callbacks.persistControl(
        { identity, operation, controlId, kind, status: "unresolved" },
        signal,
      ),
      signal,
    ).then(() => {
      throw failure("OPERATION_NOT_ACTIVE");
    });
  };
  const control = (message: PiWorkerControl) =>
    Effect.tryPromise({
      try: () =>
        activeControl ? activeControl(message) : unresolvedControl(message.controlId, message.kind),
      catch: (error) => (isRuntimeError(error) ? error : failure("CONTROL_FAILED")),
    }).pipe(Effect.onInterrupt(() => Effect.sync(() => cancelActive?.())));
  const interrupt = (controlId: number) =>
    Effect.tryPromise({
      try: () =>
        activeControl
          ? activeControl({ type: "interrupt", controlId })
          : unresolvedControl(controlId, "interrupt"),
      catch: (error) => (isRuntimeError(error) ? error : failure("CONTROL_FAILED")),
    }).pipe(Effect.onInterrupt(() => Effect.sync(() => cancelActive?.())));
  return { run, control, interrupt };
});
