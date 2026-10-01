import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { InMemoryCredentialStore, InMemoryModelsStore, Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import {
  VERSION,
  SessionManager,
  ModelRuntime,
  SettingsManager,
  createAgentSession,
  createExtensionRuntime,
  createSyntheticSourceInfo,
  defineTool,
  type AgentSession,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
  PI_WORKER_MAX_REQUEST_BYTES,
  PI_WORKER_MAX_QUEUE_FRAMES,
  PI_WORKER_MAX_QUEUE_BYTES,
  PI_WORKER_MAX_CHUNK_BYTES,
  PI_WORKER_MAX_TOOL_BYTES,
  PI_WORKER_MAX_FRAME_BYTES,
  PI_WORKER_MAX_EVENT_BYTES,
  PiWorkerToolInput,
  PiWorkerToolOutput,
  decodePiParentFrame,
  encodePiWorkerFrame,
  makePiWorkerProtocol,
  type PiParentFrame,
  type PiWorkerFrame,
  type PiWorkerIdentity,
  type PiWorkerOperation,
  type PiNativeReference,
} from "./PiWorkerProtocol.ts";

const encodeToolInput = Schema.encodeSync(Schema.fromJsonString(PiWorkerToolInput), {
  onExcessProperty: "error",
});
const encodeToolOutput = Schema.encodeSync(Schema.fromJsonString(PiWorkerToolOutput), {
  onExcessProperty: "error",
});

export interface PiSdkWorkerOptions {
  readonly identity: PiWorkerIdentity;
  readonly operation: PiWorkerOperation;
  /** Trusted private directory supplied by the parent, never from the bootstrap. */
  readonly sessionDirectory: string;
  /** Parent freezes this native retention setting with the run configuration. */
  readonly compactionKeepRecentTokens?: number;
  readonly emit: (bytes: Buffer) => Promise<void>;
  readonly localTools: Readonly<
    Record<
      string,
      (args: Schema.JsonObject, signal: AbortSignal) => Promise<typeof PiWorkerToolOutput.Type>
    >
  >;
}

export function makePiWorkerSettings(keepRecentTokens: number) {
  return SettingsManager.inMemory({
    packages: [],
    images: { blockImages: true },
    compaction: { enabled: false, keepRecentTokens },
    retry: { enabled: false, provider: { maxRetries: 0 } },
    cacheWarming: "off",
  });
}

/** One child owns one SDK operation. Parent assembly owns isolation and durable authority. */
export function makePiSdkWorker(options: PiSdkWorkerOptions) {
  options = Object.freeze({
    ...options,
    identity: Object.freeze({ ...options.identity }),
    operation: Object.freeze({ ...options.operation }),
    localTools: Object.freeze({ ...options.localTools }),
  });
  const fileRuntime = ManagedRuntime.make(NodeFileSystem.layer);
  const path = Effect.runSync(Effect.provide(Path.Path, Path.layer));
  const realPath = (value: string) =>
    fileRuntime.runPromise(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.realPath(value)));
  const protocol = makePiWorkerProtocol(options.identity, options.operation);
  const bootstrapped = Promise.withResolvers<void>();
  bootstrapped.promise.catch(() => {});
  const initialTransfers = new Set<string>();
  let session: AgentSession | undefined;
  let manager: SessionManager | undefined;
  let canceled = false;
  let running = false;
  let terminal = false;
  let sequence = 0;
  let queuedBytes = 0;
  let queuedFrames = 0;
  let writes = Promise.resolve();
  let failure: Error | undefined;
  let nativeIdle = false;
  let lifecycleId = 0;
  let callId = 0;
  let messageId = 0;
  let lastAssistantStop: string | undefined;
  let controlTask = Promise.resolve();
  let unsubscribe: (() => void) | undefined;
  const sessionReady = Promise.withResolvers<AgentSession>();
  sessionReady.promise.catch(() => {});
  const nativeTools = new Map<string, { name: string; lifecycleId: number }>();
  let tool:
    | {
        id: number;
        nativeId: string;
        lifecycleId: number;
        name: string;
        authorization: ReturnType<typeof Promise.withResolvers<boolean>>;
        result: ReturnType<typeof Promise.withResolvers<typeof PiWorkerToolOutput.Type>>;
      }
    | undefined;
  const stop = (error: Error) => {
    bootstrapped.reject(error);
    modelBridge.abort();
    tool?.authorization.reject(Error("CANCELED"));
    tool?.result.reject(Error("CANCELED"));
    void session?.abort().catch(() => {});
  };
  const abort = () => {
    canceled = true;
    stop(Error("CANCELED"));
  };
  const recordFailure = (error: unknown) => {
    failure ??= error instanceof Error ? error : Error("SDK_FAILURE");
    stop(failure);
  };
  const emit = (message: PiWorkerFrame["message"]) => {
    const frame = {
      version: 1 as const,
      ...options.identity,
      ...options.operation,
      sequence,
      message,
    };
    const bytes = encodePiWorkerFrame(frame);
    if (
      queuedFrames + 1 > PI_WORKER_MAX_QUEUE_FRAMES ||
      queuedBytes + bytes.length > PI_WORKER_MAX_QUEUE_BYTES
    )
      throw Error("WORKER_WRITE_QUEUE_LIMIT");
    protocol.acceptWorker(frame);
    sequence++;
    queuedFrames++;
    queuedBytes += bytes.length;
    writes = writes
      .then(() => options.emit(bytes))
      .finally(() => {
        queuedFrames--;
        queuedBytes -= bytes.length;
      });
    writes.catch(recordFailure);
    return writes;
  };
  const modelBridge = makePiWorkerModelBridge({
    lifecycleId: () => lifecycleId,
    emit: (message) => {
      if (message.type === "request" && !protocol.canStartRequest) throw Error("REQUEST_BARRIER");
      return emit(message);
    },
  });
  const transfer = async (id: string, text: string) => {
    const bytes = Buffer.from(text);
    for (
      let offset = 0, index = 0;
      offset < bytes.length;
      offset += PI_WORKER_MAX_CHUNK_BYTES, index++
    )
      await emit({
        type: "transfer-chunk",
        transferId: id,
        index,
        offset,
        data: bytes.subarray(offset, offset + PI_WORKER_MAX_CHUNK_BYTES).toString("base64"),
      });
    await emit({ type: "transfer-end", transferId: id });
  };
  const nativeReference = (persisted: boolean): PiNativeReference => {
    if (!manager?.getSessionFile()) throw Error("PERSISTENCE_FAILURE");
    return {
      sessionId: manager.getSessionId(),
      sessionReference: `sessions/${path.basename(manager.getSessionFile()!)}`,
      leafId: manager.getLeafId(),
      persisted,
    };
  };
  const persist = async () => {
    try {
      if (!manager) throw Error("PERSISTENCE_FAILURE");
      const reference = nativeReference(true);
      const file = manager.getSessionFile()!;
      const actual = await realPath(file);
      if (path.dirname(actual) !== (await realPath(options.sessionDirectory)))
        throw Error("PERSISTENCE_FAILURE");
      await fileRuntime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const file = yield* fs.open(actual, { flag: "r+" });
            yield* file.sync;
            const directory = yield* fs.open(options.sessionDirectory, { flag: "r" });
            yield* directory.sync;
          }),
        ),
      );
      const reopened = SessionManager.open(actual, options.sessionDirectory);
      if (
        !reopened.isPersisted() ||
        reopened.getCwd() !== manager.getCwd() ||
        reopened.getSessionId() !== reference.sessionId ||
        reopened.getLeafId() !== reference.leafId
      )
        throw Error("PERSISTENCE_FAILURE");
      return reference;
    } catch (cause) {
      throw Error("PERSISTENCE_FAILURE", { cause });
    }
  };
  return {
    acceptParent(raw: string) {
      const frame = decodePiParentFrame(raw);
      protocol.acceptParent(frame);
      if (frame.message.type === "bootstrap") {
        initialTransfers.add(frame.message.context.transferId);
        if (frame.message.prompt) initialTransfers.add(frame.message.prompt.transferId);
        for (const tool of frame.message.allowedTools)
          if (tool.inputSchema) initialTransfers.add(tool.inputSchema.transferId);
      } else if (frame.message.type === "transfer-end") {
        initialTransfers.delete(frame.message.transferId);
        if (protocol.bootstrap && initialTransfers.size === 0) bootstrapped.resolve();
        if (tool) {
          try {
            const output = protocol.takeTransfer(frame.message.transferId);
            if (output.purpose !== "tool-result") throw Error("INVALID_INPUT");
            tool.result.resolve(output.value);
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "TRANSFER_UNAVAILABLE") throw error;
          }
        }
      } else if (frame.message.type === "interrupt") {
        const controlId = frame.message.controlId;
        abort();
        controlTask = (async () => {
          await session?.abort();
          await emit({ type: "control-receipt", controlId, kind: "interrupt" });
        })();
        controlTask.catch(() => {});
      } else if (frame.message.type === "control") {
        const control = frame.message;
        controlTask = (async () => {
          const activeSession = await sessionReady.promise;
          if (nativeIdle) throw Error("INVALID_INPUT");
          if (control.kind === "steer") await activeSession.steer(control.text);
          else await activeSession.followUp(control.text);
          if (nativeIdle) throw Error("INVALID_INPUT");
          await emit({ type: "control-receipt", controlId: control.controlId, kind: control.kind });
        })();
        controlTask.catch(recordFailure);
      } else if (frame.message.type === "tool-authorized") {
        tool?.authorization.resolve(frame.message.allowed);
      } else if (frame.message.type === "tool-failure") {
        tool?.result.reject(Error(frame.message.code));
      }
      modelBridge.accept(frame.message, frame.sequence);
    },
    async run() {
      if (running) throw Error("WORKER_ALREADY_RUNNING");
      running = true;
      try {
        if (VERSION !== "0.99.1") throw Error("UNAVAILABLE");
        await bootstrapped.promise;
        const bootstrap = protocol.bootstrap!;
        const keepRecentTokens = Schema.decodeSync(
          Schema.Int.check(Schema.isBetween({ minimum: 128, maximum: 4096 })),
        )(options.compactionKeepRecentTokens ?? 512);
        if (keepRecentTokens >= bootstrap.model.contextWindow) throw Error("INVALID_INPUT");
        if (canceled) throw Error("CANCELED");
        const actualCwd = await realPath(process.cwd());
        if (actualCwd !== bootstrap.expectedCwd) throw Error("INVALID_INPUT");
        const context = protocol.takeTransfer(bootstrap.context.transferId);
        if (context.purpose !== "context") throw Error("INVALID_INPUT");
        if (bootstrap.native) {
          const reference = bootstrap.native.sessionReference;
          if (!reference.startsWith("sessions/") || reference.slice(9).includes("/"))
            throw Error("INVALID_INPUT");
          const file = await realPath(path.join(options.sessionDirectory, reference.slice(9)));
          if (path.dirname(file) !== (await realPath(options.sessionDirectory)))
            throw Error("INVALID_INPUT");
          manager = SessionManager.open(file, options.sessionDirectory);
          if (
            manager.getCwd() !== actualCwd ||
            manager.getSessionId() !== bootstrap.native.sessionId ||
            manager.getLeafId() !== bootstrap.native.leafId
          )
            throw Error("INVALID_INPUT");
        } else manager = SessionManager.create(actualCwd, options.sessionDirectory);
        await emit({
          type: "ready",
          actualCwd,
          native: nativeReference(bootstrap.native !== null),
        });
        const runtime = await ModelRuntime.create({
          credentials: new InMemoryCredentialStore(),
          modelsStore: new InMemoryModelsStore(),
          modelsPath: null,
          allowModelNetwork: false,
          refreshOnCreate: false,
        });
        runtime.registerProvider(bootstrap.model.provider, {
          api: "openai-completions",
          baseUrl: "https://t3-worker.invalid/v1",
          apiKey: "worker-placeholder",
          models: [
            {
              id: bootstrap.model.modelId,
              name: bootstrap.model.modelId,
              reasoning: bootstrap.model.reasoning,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: bootstrap.model.contextWindow,
              maxTokens: bootstrap.model.maxTokens,
              compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
            },
          ],
          streamSimple: (model, requestContext, requestOptions) => {
            if (
              model.api !== "openai-completions" ||
              model.provider !== bootstrap.model.provider ||
              model.id !== bootstrap.model.modelId
            )
              throw Error("INVALID_MODEL_REQUEST");
            return streamSimple({ ...model, api: "openai-completions" }, requestContext, {
              ...requestOptions,
              apiKey: "worker-placeholder",
              env: {},
              fetch: modelBridge.fetch,
              maxRetries: 0,
              maxTokens: bootstrap.model.maxTokens,
            });
          },
        });
        const resourceLoader: ResourceLoader = {
          getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
          getSkills: () => ({
            skills: (bootstrap.resources?.skills ?? []).map((skill) => ({
              name: skill.key,
              description: skill.description,
              filePath: skill.path,
              baseDir: path.dirname(skill.path),
              disableModelInvocation: false,
              sourceInfo: createSyntheticSourceInfo(skill.path, {
                source: "t3-frozen",
                scope: "temporary",
              }),
            })),
            diagnostics: [],
          }),
          getPrompts: () => ({ prompts: [], diagnostics: [] }),
          getThemes: () => ({ themes: [], diagnostics: [] }),
          getAgentsFiles: () => ({ agentsFiles: [] }),
          getSystemPrompt: () => context.text,
          getSystemPromptSource: () => undefined,
          getAppendSystemPrompt: () => [],
          getAppendSystemPromptSources: () => [],
          extendResources: () => {
            throw Error("RESOURCE_MUTATION_FORBIDDEN");
          },
          reload: async () => {},
        };
        const customTools = bootstrap.allowedTools.map((allowed) => {
          const schema = allowed.inputSchema
            ? protocol.takeTransfer(allowed.inputSchema.transferId)
            : undefined;
          if (schema && (schema.purpose !== "tool-schema" || schema.value.type !== "object"))
            throw Error("INVALID_INPUT");
          if (allowed.execution === "local" && !Object.hasOwn(options.localTools, allowed.name))
            throw Error("UNAVAILABLE");
          const parameters =
            schema?.purpose === "tool-schema"
              ? schema.value
              : { type: "object", properties: {}, additionalProperties: false };
          return defineTool({
            executionMode: "sequential",
            name: allowed.name,
            label: allowed.name,
            description: allowed.description,
            parameters: Type.Unsafe<Schema.JsonObject>(parameters),
            execute: async (nativeId, args, signal) => {
              try {
                await modelBridge.drain();
                if (tool || canceled || !signal) throw Error("TOOL_FAILURE");
                const start = nativeTools.get(nativeId);
                if (!start || start.name !== allowed.name) throw Error("TOOL_FAILURE");
                const active = {
                  id: ++callId,
                  nativeId,
                  lifecycleId: start.lifecycleId,
                  name: allowed.name,
                  authorization: Promise.withResolvers<boolean>(),
                  result: Promise.withResolvers<typeof PiWorkerToolOutput.Type>(),
                };
                active.authorization.promise.catch(() => {});
                active.result.promise.catch(() => {});
                tool = active;
                const inputText = encodeToolInput({ arguments: args });
                await emit({
                  type: "tool-call",
                  callId: active.id,
                  nativeCallId: nativeId,
                  lifecycleId: active.lifecycleId,
                  toolName: allowed.name,
                  execution: allowed.execution,
                  input: {
                    transferId: `tool-input-${active.id}`,
                    totalBytes: Buffer.byteLength(inputText),
                  },
                });
                await transfer(`tool-input-${active.id}`, inputText);
                if (!(await active.authorization.promise)) throw Error("TOOL_DENIED");
                await emit({
                  type: "sdk-event",
                  lifecycleId: active.lifecycleId,
                  event: { type: "tool_start", callId: active.id, toolName: allowed.name },
                });
                // Authorization and the tool_start receipt can both race accepted cancellation.
                if (canceled || signal.aborted || failure) throw failure ?? Error("CANCELED");
                const result =
                  allowed.execution === "local"
                    ? await options.localTools[allowed.name]!(args, signal)
                    : await active.result.promise;
                if (canceled || signal.aborted || failure) throw failure ?? Error("CANCELED");
                const outputText = encodeToolOutput(result);
                if (
                  Buffer.byteLength(inputText) + Buffer.byteLength(outputText) >
                  PI_WORKER_MAX_TOOL_BYTES
                )
                  throw Error("TOOL_FAILURE");
                if (allowed.execution === "local") {
                  await emit({
                    type: "tool-result",
                    callId: active.id,
                    output: {
                      transferId: `tool-output-${active.id}`,
                      totalBytes: Buffer.byteLength(outputText),
                    },
                  });
                  await transfer(`tool-output-${active.id}`, outputText);
                  protocol.takeTransfer(`tool-output-${active.id}`);
                }
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: result.kind === "text" ? result.text : JSON.stringify(result.value),
                    },
                  ],
                  details: {},
                };
              } catch (error) {
                recordFailure(error);
                throw error;
              }
            },
          });
        });
        const selectedModel = runtime.getModel(bootstrap.model.provider, bootstrap.model.modelId);
        if (!selectedModel) throw Error("UNAVAILABLE");
        ({ session } = await createAgentSession({
          cwd: actualCwd,
          agentDir: options.sessionDirectory,
          modelRuntime: runtime,
          model: selectedModel,
          sessionManager: manager,
          settingsManager: makePiWorkerSettings(keepRecentTokens),
          resourceLoader,
          tools: bootstrap.allowedTools.map((allowed) => allowed.name),
          customTools,
          thinkingLevel: "off",
        }));
        const activeMessages = new Map<string, string>();
        unsubscribe = session.subscribe((event) => {
          // Capture all correlation fields while the native callback still owns this event.
          if (canceled || terminal || failure) return;
          try {
            if (event.type === "agent_start" || event.type === "compaction_start") {
              nativeIdle = false;
              lifecycleId++;
              void emit({ type: event.type, lifecycleId });
            } else if (
              event.type === "agent_end" ||
              event.type === "agent_settled" ||
              event.type === "compaction_end"
            ) {
              if (event.type === "agent_settled" || event.type === "compaction_end")
                nativeIdle = true;
              void emit({ type: event.type, lifecycleId });
            } else if (event.type === "message_start" || event.type === "message_end") {
              const role = event.message.role === "toolResult" ? "tool" : event.message.role;
              if (role !== "user" && role !== "assistant" && role !== "tool") return;
              if (event.type === "message_start")
                activeMessages.set(role, `message-${++messageId}`);
              const entryId = activeMessages.get(role);
              if (!entryId) throw Error("SDK_EVENT_ORDER");
              void emit({
                type: "sdk-event",
                lifecycleId,
                event: { type: event.type, entryId, role },
              });
              if (event.type === "message_end") {
                activeMessages.delete(role);
                if (event.message.role === "assistant") {
                  const stopReason = event.message.stopReason;
                  lastAssistantStop = stopReason;
                  if (
                    stopReason !== "stop" &&
                    stopReason !== "toolUse" &&
                    stopReason !== "error" &&
                    stopReason !== "aborted"
                  )
                    throw Error("SDK_FAILURE");
                  void emit({
                    type: "sdk-event",
                    lifecycleId,
                    event: { type: "assistant_result", stopReason },
                  });
                  if (stopReason === "error" || stopReason === "aborted")
                    throw Error("SDK_FAILURE");
                }
              }
            } else if (event.type === "message_update") {
              const delta = event.assistantMessageEvent;
              if (delta.type === "text_delta" || delta.type === "thinking_delta")
                for (const text of splitPiWorkerText(delta.delta))
                  void emit({ type: "sdk-event", lifecycleId, event: { type: delta.type, text } });
            } else if (event.type === "tool_execution_start") {
              if (nativeTools.has(event.toolCallId)) throw Error("NATIVE_TOOL_ID_REUSE");
              nativeTools.set(event.toolCallId, { name: event.toolName, lifecycleId });
            } else if (event.type === "tool_execution_end") {
              if (!tool || tool.nativeId !== event.toolCallId) throw Error("SDK_TOOL_ORDER");
              const captured = tool;
              void emit({
                type: "sdk-event",
                lifecycleId: captured.lifecycleId,
                event: {
                  type: "tool_end",
                  callId: captured.id,
                  toolName: captured.name,
                  isError: event.isError,
                },
              });
              tool = undefined;
            }
          } catch (error) {
            recordFailure(error);
          }
        });
        sessionReady.resolve(session);
        await controlTask;
        if (canceled) throw Error("CANCELED");
        if (options.operation.operationKind === "initialize") {
          // The SDK flushes fresh files only once a conversation exists. The briefing is a
          // real supplied user message; initialization never submits it for inference.
          if (!bootstrap.native)
            manager.appendMessage({
              role: "user",
              content: [{ type: "text", text: context.text }],
              timestamp: Effect.runSync(Clock.currentTimeMillis),
            });
          await session.waitForIdle();
          if (!session.isIdle || canceled) throw Error("CANCELED");
          await emit({ type: "initialized", native: await persist() });
        } else if (options.operation.operationKind === "prompt") {
          const prompt = protocol.takeTransfer(bootstrap.prompt!.transferId);
          if (prompt.purpose !== "prompt") throw Error("INVALID_INPUT");
          await session.prompt(prompt.text, { expandPromptTemplates: false });
          await session.waitForIdle();
          await controlTask;
          await modelBridge.drain();
          await writes;
          if (!session.isIdle || canceled || failure) throw failure ?? Error("CANCELED");
          if (lastAssistantStop !== "stop") throw Error("SDK_FAILURE");
          unsubscribe();
          unsubscribe = undefined;
          const native = await persist();
          if (canceled || failure) throw failure ?? Error("CANCELED");
          await emit({ type: "native", lifecycleId, native });
          await emit({ type: "operation_settled", lifecycleId, outcome: "success" });
          if (!protocol.canFinishSuccessfully) throw Error("SDK_FAILURE");
          await emit({ type: "done" });
        } else {
          await session.compact();
          await session.waitForIdle();
          await controlTask;
          await modelBridge.drain();
          await writes;
          if (!session.isIdle || canceled || failure) throw failure ?? Error("CANCELED");
          unsubscribe();
          unsubscribe = undefined;
          const native = await persist();
          if (canceled || failure) throw failure ?? Error("CANCELED");
          await emit({ type: "compacted", lifecycleId, native });
          await emit({ type: "operation_settled", lifecycleId, outcome: "success" });
          if (!protocol.canFinishSuccessfully) throw Error("SDK_FAILURE");
          await emit({ type: "done" });
        }
        terminal = true;
      } catch (error) {
        sessionReady.reject(error);
        await controlTask.catch(() => {});
        const cause = failure ?? error;
        const code = canceled
          ? "CANCELED"
          : cause instanceof Error &&
              [
                "PERSISTENCE_FAILURE",
                "INVALID_INPUT",
                "UNAVAILABLE",
                "TOOL_DENIED",
                "TOOL_FAILURE",
              ].includes(cause.message)
            ? cause.message
            : "SDK_FAILURE";
        if (!terminal) {
          try {
            await emit({ type: "worker-failure", code });
          } catch {}
          terminal = true;
        }
        throw error;
      }
      await writes;
      if (failure) throw failure;
    },
    abort,
    async dispose() {
      unsubscribe?.();
      await session?.abort();
      session?.dispose();
      await writes.catch(() => {});
      await fileRuntime.dispose();
    },
  };
}

/** Split projection deltas at codepoint boundaries without changing any accepted text. */
export function splitPiWorkerText(text: string) {
  if (/[\uD800-\uDFFF]/u.test(text) || Buffer.byteLength(text) > PI_WORKER_MAX_EVENT_BYTES)
    throw Error("INVALID_TEXT");
  // Reserve room for the longest protocol identity and numeric correlation fields.
  const wireLimit = PI_WORKER_MAX_FRAME_BYTES - 1024;
  if (
    Buffer.byteLength(text) <= PI_WORKER_MAX_CHUNK_BYTES &&
    Buffer.byteLength(JSON.stringify(text)) <= wireLimit
  )
    return text.length === 0 ? [] : [text];
  const parts: string[] = [];
  let part = "";
  let bytes = 0;
  let wireBytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    const wireSize = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes + size > PI_WORKER_MAX_CHUNK_BYTES || wireBytes + wireSize > wireLimit) {
      parts.push(part);
      part = "";
      bytes = 0;
      wireBytes = 0;
    }
    part += character;
    bytes += size;
    wireBytes += wireSize;
  }
  if (part) parts.push(part);
  return parts;
}

/** SDK fetch streams end only when parent accounting ends, with one consumed chunk per ACK. */
export function makePiWorkerModelBridge(options: {
  emit: (message: PiWorkerFrame["message"]) => Promise<void>;
  lifecycleId: () => number;
}) {
  type Pending = {
    id: number;
    headers: ReturnType<typeof Promise.withResolvers<Response>>;
    completion: ReturnType<typeof Promise.withResolvers<void>>;
    controller: ReadableStreamDefaultController<Uint8Array>;
    chunk: { bytes: Uint8Array; sequence: number } | undefined;
    pulling: boolean;
    ended: boolean;
    failed: boolean;
    readerClosed: boolean;
    completed: boolean;
    writes: Promise<void>;
  };
  let active: Pending | undefined;
  let requestId = 0;
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    if (active && !active.failed) {
      active.failed = true;
      active.headers.reject(error);
      active.controller.error(error);
      active.completion.reject(error);
    }
  };
  const pump = (pending: Pending) => {
    if (pending.failed || pending.completed) return;
    if (pending.chunk && pending.pulling) {
      const chunk = pending.chunk;
      pending.chunk = undefined;
      pending.pulling = false;
      pending.controller.enqueue(chunk.bytes);
      pending.writes = pending.writes.then(() =>
        options.emit({
          type: "ack",
          requestId: pending.id,
          chunkSequence: chunk.sequence,
        }),
      );
      pending.writes.catch((error: unknown) =>
        fail(error instanceof Error ? error : Error("IPC_FAILURE")),
      );
    }
    if (pending.ended && !pending.chunk) {
      pending.writes.then(
        () => {
          if (pending.failed) return;
          if (pending.completed) return;
          if (!pending.readerClosed) pending.controller.close();
          pending.completed = true;
          pending.completion.resolve();
        },
        () => {},
      );
    }
  };
  return {
    async fetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
      const capturedLifecycleId = options.lifecycleId();
      if (active) await active.completion.promise;
      if (failure) throw failure;
      if (
        String(url) !== "https://t3-worker.invalid/v1/chat/completions" ||
        init?.method !== "POST" ||
        typeof init.body !== "string" ||
        Buffer.byteLength(init.body) > PI_WORKER_MAX_REQUEST_BYTES
      )
        throw Error("INVALID_MODEL_REQUEST");
      if (init.signal?.aborted) throw Error("CANCELED");
      const headers = Promise.withResolvers<Response>();
      const completion = Promise.withResolvers<void>();
      headers.promise.catch(() => {});
      completion.promise.catch(() => {});
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const pending: Pending = {
        id: ++requestId,
        headers,
        completion,
        get controller() {
          return controller;
        },
        chunk: undefined,
        pulling: false,
        ended: false,
        failed: false,
        readerClosed: false,
        completed: false,
        writes: Promise.resolve(),
      };
      const stream = new ReadableStream<Uint8Array>(
        {
          start(value) {
            controller = value;
          },
          pull() {
            pending.pulling = true;
            pump(pending);
          },
          // OpenAI's parser cancels its reader on [DONE]. That is not parent accounting.
          cancel() {
            pending.readerClosed = true;
            if (pending.chunk) fail(Error("UNCONSUMED_MODEL_CHUNK"));
          },
        },
        { highWaterMark: 0 },
      );
      active = pending;
      // The body exists before the parent can synchronously send headers through emit.
      pending.headers.promise.then(
        () => {},
        () => stream.cancel().catch(() => {}),
      );
      const aborted = () => {
        if (!pending.completed && active === pending) fail(Error("CANCELED"));
      };
      init.signal?.addEventListener("abort", aborted, { once: true });
      completion.promise
        .finally(() => init.signal?.removeEventListener("abort", aborted))
        .catch(() => {});
      try {
        await options.emit({
          type: "request",
          requestId: pending.id,
          lifecycleId: capturedLifecycleId,
          body: init.body,
        });
      } catch (error) {
        fail(error instanceof Error ? error : Error("IPC_FAILURE"));
      }
      // Keep Response construction here; headers acceptance resolves this deferred separately.
      return headers.promise.then(
        () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      );
    },
    accept(message: PiParentFrame["message"], sequence: number) {
      if (!["headers", "chunk", "end", "error"].includes(message.type)) return;
      if (
        !("requestId" in message) ||
        !active ||
        message.requestId !== active.id ||
        active.ended ||
        active.failed
      )
        throw Error("UNEXPECTED_MODEL_RESPONSE");
      switch (message.type) {
        case "headers":
          active.headers.resolve(new Response(null));
          break;
        case "chunk":
          if (active.readerClosed) throw Error("UNCONSUMED_MODEL_CHUNK");
          if (active.chunk) throw Error("CHUNK_ACK_REQUIRED");
          active.chunk = { bytes: Buffer.from(message.data, "base64"), sequence };
          pump(active);
          break;
        case "end":
          active.ended = true;
          pump(active);
          break;
        case "error":
          fail(Error(message.code));
          break;
      }
    },
    async drain() {
      if (active) await active.completion.promise;
      if (failure) throw failure;
    },
    abort() {
      fail(Error("CANCELED"));
    },
  };
}
