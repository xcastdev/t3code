// @effect-diagnostics nodeBuiltinImport:off
import { readOmpEvalEnvelope, makeOmpEvalEnvelope } from "@t3tools/shared/ompEval";
import * as NodeUtil from "node:util";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import type { OmpRpcConnection, OmpRpcError } from "./rpc.ts";
import type { ControlEnvelope } from "./controlChannel.ts";
import * as Exit from "effect/Exit";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import {
  ProviderDriverKind,
  PlanId,
  type ProviderInstanceId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ExecutionNode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import * as Ids from "@t3tools/provider-core/server/IdAllocator";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import {
  ProviderSecretInputs,
  type ProviderSecretInputReceiver,
} from "@t3tools/provider-core/server/ProviderSecretInputs";
import {
  freezeInstructionSnapshot,
  sameInstructionSnapshot,
} from "@t3tools/provider-core/server/instructionSnapshot";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import { OmpSettings } from "../settings.ts";
import { makeOmpProviderSession, type OmpSessionOptions } from "./session.ts";
import { OmpTurnController, type NativeRecord } from "./turnController.ts";
import { OmpCapabilities } from "./capabilities.ts";
import { discoverOmp, applyOmpSelection, decodeOmpCommands } from "./status.ts";
import { assertAllowedPrompt, type OmpCommand } from "./commands.ts";
import { OmpToolItems, nativeObject, nativeText } from "./toolItems.ts";
import { ownedOmpSessionDirectory, ompTokenUsage } from "./usage.ts";
import { OmpHistory, historyMessages, nativeMessageBaseKey } from "./history.ts";
import { ompQuestions, ompAnswer } from "./questions.ts";
import { type AuthorizedMcpTools, connectAuthorizedMcpTools, OmpToolBridge } from "./toolBridge.ts";
import { buildOmpInstructions } from "./instructions.ts";
export const OMP_DRIVER = ProviderDriverKind.make("omp");
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const ref = (nativeId: string) => ({ driver: OMP_DRIVER, nativeId, strength: "strong" as const });
// A catalog edit only bumps catalogRevision; calls to T3's own endpoint keep their authority.
const sameT3Authority = (
  a: McpProviderSessionConfig | undefined,
  b: McpProviderSessionConfig | undefined,
) => {
  if (!a || !b) return false;
  const { catalogRevision: _a, ...left } = a;
  const { catalogRevision: _b, ...right } = b;
  return NodeUtil.isDeepStrictEqual(left, right);
};
const protocol = (detail: string, cause?: unknown) =>
  new Adapter.ProviderAdapterProtocolError({
    driver: OMP_DRIVER,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
export interface OmpAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly settings: OmpSettings;
  readonly environment: NodeJS.ProcessEnv;
}
interface OmpSessionConnection extends OmpRpcConnection {
  readonly controls: Queue.Queue<ControlEnvelope, OmpRpcError>;
  readonly sendControl: (frame: ControlEnvelope) => Effect.Effect<void, OmpRpcError>;
  readonly providerSession: string;
  readonly policyEpoch: string;
}
export type OmpSessionFactory = (
  options: OmpSessionOptions,
) => Effect.Effect<
  OmpSessionConnection,
  Effect.Error<ReturnType<typeof makeOmpProviderSession>>,
  Effect.Services<ReturnType<typeof makeOmpProviderSession>>
>;
export const makeOmpAdapterV2 = Effect.fn("OmpAdapter.make")(function* (
  options: OmpAdapterOptions,
  connect: OmpSessionFactory = makeOmpProviderSession,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const host = yield* ProviderHost;
  const ids = yield* Ids.IdAllocatorV2;
  const catalogs = yield* McpProviderSessions;
  const secretInputs = yield* ProviderSecretInputs;
  const root = ownedOmpSessionDirectory(host.paths.stateDir, options.instanceId);
  yield* Effect.tryPromise({
    try: () => NodeFSP.mkdir(root, { recursive: true, mode: 0o700 }),
    catch: (cause) => protocol("Cannot create owned OMP storage", cause),
  });
  const ownedPath = Effect.fn("OmpAdapter.ownedPath")(function* (path: string) {
    const real = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(path),
      catch: (cause) => protocol("Owned OMP session is unavailable", cause),
    });
    const base = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(root),
      catch: (cause) => protocol("Owned OMP storage is unavailable", cause),
    });
    if (!real.startsWith(base + NodePath.sep))
      return yield* protocol("OMP continuation is outside driver-owned storage");
    return real;
  });
  return {
    instanceId: options.instanceId,
    driver: OMP_DRIVER,
    getCapabilities: () => Effect.succeed(OmpCapabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: Effect.fn("OmpAdapter.openSession")(function* (
      input: Adapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const scope = yield* Effect.scope;
      const context = yield* Effect.context<never>();
      const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseWith(context)(effect);
      const events = yield* Queue.bounded<
        Adapter.ProviderAdapterV2Event,
        Adapter.ProviderAdapterV2Error
      >(1024);
      const semantic: NativeRecord[] = [];
      const lock = yield* Semaphore.make(1);
      const emit = (event: Adapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);
      const instructions = input.instructionSnapshot
        ? freezeInstructionSnapshot(input.instructionSnapshot)
        : undefined;
      const append = [
        buildOmpInstructions({ model: input.modelSelection.model }),
        instructions?.roleInstructions,
      ]
        .filter(Boolean)
        .join("\n\n");
      const cwd = input.runtimePolicy.cwd ?? host.paths.cwd;
      const nativeInitial = input.initialNativeThreadId;
      if (
        input.resumeFromSession &&
        (input.resumeFromSession.driver !== OMP_DRIVER ||
          input.resumeFromSession.providerInstanceId !== options.instanceId)
      )
        return yield* protocol("OMP resume ownership differs");
      const sessionFile = nativeInitial ? yield* ownedPath(nativeInitial) : undefined;
      const initialConfig = {
        cwd,
        mode: input.runtimePolicy.runtimeMode,
        environment: options.instanceId,
        project: cwd,
        instructions: append,
        sessionDir: root,
        ...(sessionFile ? { sessionFile } : {}),
      };
      const launchOptions: OmpSessionOptions = {
        binaryPath: options.settings.binaryPath,
        launchArgs: options.settings.launchArgs,
        env: options.environment,
        cacheDir: host.paths.providerStatusCacheDir,
        config: initialConfig,
      };
      let connection = yield* connect(launchOptions).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((cause) => protocol("Guarded OMP startup failed", cause)),
      );
      const request = (record: NativeRecord) =>
        connection
          .request(record)
          .pipe(Effect.mapError((cause) => protocol("OMP request failed", cause)));
      const send = (record: NativeRecord) =>
        connection
          .send(record)
          .pipe(Effect.mapError((cause) => protocol("OMP write failed", cause)));
      const controller = new OmpTurnController(
        (r) => run(send(r)),
        (r) => semantic.push(r),
        (r) => run(connection.request(r, 5000)),
      );
      let discovery = yield* discoverOmp(connection).pipe(
        Effect.mapError((cause) => protocol("OMP required discovery failed", cause)),
      );
      let commands: readonly OmpCommand[] = discovery.nativeCommands;
      const rawState = yield* request({ type: "get_state" });
      if (
        !nativeObject(rawState) ||
        typeof rawState.sessionFile !== "string" ||
        (append &&
          (!Array.isArray(rawState.systemPrompt) || !rawState.systemPrompt.includes(append)))
      )
        return yield* protocol("OMP native system context or persistence acknowledgement missing");
      const nativeFile = rawState.sessionFile;
      if (!NodePath.resolve(nativeFile).startsWith(NodePath.resolve(root) + NodePath.sep))
        return yield* protocol("Native OMP storage escaped owned directory");
      yield* request({ type: "set_ask_dialog", enabled: true });
      const createdAt = yield* DateTime.now;
      let sessionEntity = {
        id: input.providerSessionId,
        driver: OMP_DRIVER,
        providerInstanceId: options.instanceId,
        status: "ready" as "ready" | "running" | "error" | "stopped",
        cwd,
        model: input.modelSelection.model,
        capabilities: OmpCapabilities,
        createdAt,
        updatedAt: createdAt,
        lastError: null as string | null,
      };
      let thread: OrchestrationV2ProviderThread | undefined;
      let active:
        | {
            input: Adapter.ProviderAdapterV2TurnInput;
            turn: OrchestrationV2ProviderTurn;
            promptId: string;
            ordinal: number;
            messageOrdinal: number;
            messageId: string;
            blocks: Map<string, string>;
          }
        | undefined;
      const turns: OrchestrationV2ProviderTurn[] = [];
      const unfinishedTools = new Map<string, OrchestrationV2TurnItem>();
      // The orchestrator owns durable delivery; retain consumed notices across guarded restarts.
      const consumedContinuations = new Set<string>();
      const messages = new Map<string, OrchestrationV2ConversationMessage>();
      const messageCounts = new Map<string, number>();
      const runtimeRequests = new Map<
        string,
        {
          record: NativeRecord;
          request: OrchestrationV2RuntimeRequest;
          control?: Extract<ControlEnvelope, { type: "approval_answer" }>;
          item: OrchestrationV2TurnItem;
        }
      >();
      const requestNodes = new Map<string, OrchestrationV2ExecutionNode>();
      const expirations = new Map<string, Effect.Effect<void>>();
      const publishRequest = Effect.fn("OmpAdapter.publishRequest")(function* (
        request: OrchestrationV2RuntimeRequest,
        item: OrchestrationV2TurnItem,
      ) {
        const node: OrchestrationV2ExecutionNode = {
          id: request.nodeId,
          threadId: input.threadId,
          runId: item.runId,
          parentNodeId: active?.input.rootNodeId ?? null,
          rootNodeId: active?.input.rootNodeId ?? request.nodeId,
          kind: request.kind === "user_input" ? "user_input_request" : "approval_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: item.providerThreadId ?? null,
          providerTurnId: item.providerTurnId,
          nativeItemRef: request.nativeRequestRef,
          runtimeRequestId: request.id,
          checkpointScopeId: null,
          startedAt: request.createdAt,
          completedAt: null,
        };
        requestNodes.set(request.id, node);
        yield* emit({ type: "node.updated", driver: OMP_DRIVER, node });
      });
      const closeRequest = Effect.fn("OmpAdapter.closeRequest")(function* (
        id: string,
        status: "resolved" | "cancelled" | "expired",
      ) {
        const pending = runtimeRequests.get(id);
        if (!pending) return;
        runtimeRequests.delete(id);
        const stop = expirations.get(id);
        expirations.delete(id);
        if (stop) yield* stop;
        const now = yield* DateTime.now;
        const node = requestNodes.get(id);
        requestNodes.delete(id);
        yield* emit({
          type: "runtime_request.updated",
          driver: OMP_DRIVER,
          threadId: input.threadId,
          runtimeRequest: { ...pending.request, status, resolvedAt: now },
        });
        if (node)
          yield* emit({
            type: "node.updated",
            driver: OMP_DRIVER,
            node: {
              ...node,
              status: status === "resolved" ? "completed" : "cancelled",
              completedAt: now,
            },
          });
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_DRIVER,
          turnItem: {
            ...pending.item,
            status: status === "resolved" ? "completed" : "cancelled",
            completedAt: now,
            updatedAt: now,
          },
        });
      });
      const installExpiry = Effect.fn("OmpAdapter.installExpiry")(function* (
        record: NativeRecord,
        request: OrchestrationV2RuntimeRequest,
      ) {
        if (
          typeof record.timeout !== "number" ||
          !Number.isFinite(record.timeout) ||
          record.timeout <= 0
        )
          return;
        const fiber = yield* Effect.sleep(Duration.millis(Math.min(record.timeout, 86400000))).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const pending = runtimeRequests.get(request.id);
              if (!pending) return;
              expirations.delete(request.id);
              yield* send({
                type: "extension_ui_response",
                id: record.id,
                cancelled: true,
                timedOut: true,
              });
              yield* closeRequest(request.id, "expired");
            }).pipe(lock.withPermits(1)),
          ),
          Effect.ignore,
          Effect.forkIn(scope),
        );
        expirations.set(request.id, Fiber.interrupt(fiber).pipe(Effect.asVoid));
      });
      // Masked native prompts. Their answers go straight to the live prompt and are never kept.
      const secretPrompts = new Map<
        string,
        {
          record: NativeRecord;
          item: Extract<OrchestrationV2TurnItem, { type: "secret_request" }>;
          receiver: ProviderSecretInputReceiver;
          stopExpiry?: Effect.Effect<void>;
        }
      >();
      const closeSecret = Effect.fn("OmpAdapter.closeSecret")(function* (
        id: string,
        secretStatus: "saved" | "declined" | "cancelled",
        reply?: NativeRecord,
      ) {
        const pending = secretPrompts.get(id);
        if (!pending) return false;
        secretPrompts.delete(id);
        yield* secretInputs.unregister(pending.receiver);
        if (pending.stopExpiry) yield* pending.stopExpiry;
        const sent = reply === undefined ? true : Exit.isSuccess(yield* Effect.exit(send(reply)));
        const now = yield* DateTime.now;
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_DRIVER,
          turnItem: {
            ...pending.item,
            secretStatus: sent ? secretStatus : "cancelled",
            status: sent && secretStatus === "saved" ? "completed" : "cancelled",
            completedAt: now,
            updatedAt: now,
          },
        });
        return sent;
      });
      const cancelSecrets = Effect.fn("OmpAdapter.cancelSecrets")(function* (
        notifyNative: boolean,
      ) {
        for (const [id, pending] of secretPrompts)
          yield* closeSecret(
            id,
            "cancelled",
            notifyNative
              ? { type: "extension_ui_response", id: pending.record.id, cancelled: true }
              : undefined,
          );
      });
      yield* Scope.addFinalizer(
        scope,
        Effect.forEach(secretPrompts.values(), (pending) =>
          secretInputs.unregister(pending.receiver),
        ),
      );
      let tools = new OmpToolItems();
      const history = new OmpHistory();
      let generation = 0;
      let transportFailed = false;
      let nextPrompt = 0;
      let nextNotice = 0;
      const updateSession = Effect.fn("OmpAdapter.updateSession")(function* (
        status: typeof sessionEntity.status,
        lastError: string | null = null,
      ) {
        sessionEntity = { ...sessionEntity, status, lastError, updatedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_session.updated",
          driver: OMP_DRIVER,
          providerSession: sessionEntity,
        });
      });
      const baseItem = Effect.fn("OmpAdapter.baseItem")(function* (nativeId: string) {
        const now = yield* DateTime.now;
        return {
          id: ids.derive.turnItemFromProviderItem({
            driver: OMP_DRIVER,
            nativeItemId: `${nativeFile}:${nativeId}`,
          }),
          threadId: input.threadId,
          runId: active?.input.runId ?? null,
          nodeId: active?.input.rootNodeId ?? null,
          providerThreadId: thread?.id ?? null,
          providerTurnId: active?.turn.id ?? null,
          nativeItemRef: ref(nativeId),
          parentItemId: null,
          ordinal: active ? active.ordinal++ : 0,
          status: "running" as const,
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        };
      });
      const projectionBases = new Map<string, Effect.Success<ReturnType<typeof baseItem>>>();
      const itemBase = Effect.fn("OmpAdapter.itemBase")(function* (id: string) {
        const old = projectionBases.get(id);
        if (old) return old;
        const base = yield* baseItem(id);
        projectionBases.set(id, base);
        return base;
      });
      const flushMessage = Effect.fn("OmpAdapter.flushMessage")(function* (complete: boolean) {
        const turn = active;
        if (!turn) return;
        const text = [...turn.blocks]
          .filter(([key]) => key.startsWith("text:"))
          .map(([, v]) => v)
          .join("");
        const reasoning = [...turn.blocks]
          .filter(([key]) => key.startsWith("thinking:"))
          .map(([, v]) => v)
          .join("");
        const now = yield* DateTime.now;
        const id = turn.messageId || `${turn.promptId}:message:${turn.messageOrdinal}`;
        const base = yield* itemBase(id);
        if (text) {
          const messageId = ids.derive.messageFromProviderItem({
            driver: OMP_DRIVER,
            nativeItemId: `${nativeFile}:${id}`,
          });
          const message: OrchestrationV2ConversationMessage = {
            id: messageId,
            threadId: input.threadId,
            runId: turn.input.runId,
            nodeId: turn.input.rootNodeId,
            role: "assistant",
            text,
            attachments: [],
            streaming: !complete,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: base.startedAt ?? now,
            updatedAt: now,
          };
          messages.set(id, message);
          yield* emit({ type: "message.updated", driver: OMP_DRIVER, message });
          yield* emit({
            type: "turn_item.updated",
            driver: OMP_DRIVER,
            turnItem: {
              ...base,
              type: "assistant_message",
              messageId,
              text,
              streaming: !complete,
              status: complete ? "completed" : "running",
              updatedAt: now,
              completedAt: complete ? now : null,
            },
          });
        }
        if (reasoning) {
          const reasoningBase = yield* itemBase(id + ":reasoning");
          yield* emit({
            type: "turn_item.updated",
            driver: OMP_DRIVER,
            turnItem: {
              ...reasoningBase,
              type: "reasoning",
              text: reasoning,
              streaming: !complete,
              status: complete ? "completed" : "running",
              updatedAt: now,
              completedAt: complete ? now : null,
            },
          });
        }
      });
      const drain = Effect.fn("OmpAdapter.drain")(function* (enrich = true) {
        for (const record of semantic.splice(0)) {
          const turn = active;
          if (
            !turn ||
            (record.id !== undefined && record.type === "terminal" && record.id !== turn.promptId)
          )
            continue;
          if (record.type === "terminal") {
            yield* flushMessage(true);
            const now = yield* DateTime.now;
            const failed = record.status === "error";
            const interrupted = record.status === "aborted";
            for (const item of unfinishedTools.values()) {
              const preview =
                item.type === "dynamic_tool" ? readOmpEvalEnvelope(item.output) : undefined;
              const output =
                preview && item.type === "dynamic_tool" && nativeObject(item.output)
                  ? {
                      ...item.output,
                      t3OmpEval: makeOmpEvalEnvelope({
                        ...preview,
                        revision: preview.revision + 1,
                        status: interrupted ? "cancelled" : "failed",
                      }),
                    }
                  : undefined;
              yield* emit({
                type: "turn_item.updated",
                driver: OMP_DRIVER,
                turnItem:
                  item.type === "dynamic_tool"
                    ? {
                        ...item,
                        status: interrupted ? "interrupted" : "failed",
                        updatedAt: now,
                        completedAt: now,
                        ...(output ? { output } : {}),
                      }
                    : {
                        ...item,
                        status: interrupted ? "interrupted" : "failed",
                        updatedAt: now,
                        completedAt: now,
                      },
              });
            }
            unfinishedTools.clear();
            for (const id of runtimeRequests.keys()) yield* closeRequest(id, "cancelled");
            yield* cancelSecrets(false);
            if (enrich)
              yield* Effect.tryPromise({
                try: () => history.refresh((r) => run(connection.request(r, 5000))),
                catch: (cause) => protocol("OMP terminal history capture failed", cause),
              }).pipe(Effect.ignore);
            const tokenUsage = enrich
              ? yield* connection.request({ type: "get_state" }, 5000).pipe(
                  Effect.flatMap((state) =>
                    connection
                      .request({ type: "get_session_stats" }, 5000)
                      .pipe(
                        Effect.map((stats) => ompTokenUsage(state, stats, DateTime.formatIso(now))),
                      ),
                  ),
                  Effect.orElseSucceed(() => undefined),
                )
              : undefined;
            const finalTurn = {
              ...(tokenUsage ? { tokenUsage } : {}),
              ...turn.turn,
              nativeTurnRef: history.leafId ? ref(history.leafId) : null,
              status: failed
                ? ("failed" as const)
                : interrupted
                  ? ("interrupted" as const)
                  : ("completed" as const),
              completedAt: now,
            };
            turns.push(finalTurn);
            yield* emit({
              type: "provider_turn.updated",
              driver: OMP_DRIVER,
              threadId: input.threadId,
              providerTurn: finalTurn,
            });
            yield* emit(
              failed
                ? {
                    type: "turn.terminal",
                    driver: OMP_DRIVER,
                    providerThreadId: turn.turn.providerThreadId,
                    providerTurnId: turn.turn.id,
                    runOrdinal: turn.input.runOrdinal,
                    status: "failed",
                    failure: makeProviderFailure({
                      message: typeof record.error === "string" ? record.error : "OMP turn failed",
                    }),
                    failureItemOrdinal: turn.ordinal++,
                    threadDisposition: "broken",
                  }
                : {
                    type: "turn.terminal",
                    driver: OMP_DRIVER,
                    providerThreadId: turn.turn.providerThreadId,
                    providerTurnId: turn.turn.id,
                    runOrdinal: turn.input.runOrdinal,
                    status: interrupted ? "interrupted" : "completed",
                    failure: null,
                    threadDisposition: "reusable",
                  },
            );
            active = undefined;
            yield* updateSession(failed ? "error" : "ready");
            continue;
          }
          if (record.type === "todo_auto_clear" || record.type === "todo_reminder")
            yield* projectTodos();
          if (record.type === "command_output" && typeof record.text === "string") {
            const base = yield* baseItem(`${turn.promptId}:command-output:${nextNotice++}`);
            const now = yield* DateTime.now;
            yield* emit({
              type: "turn_item.updated",
              driver: OMP_DRIVER,
              turnItem: {
                ...base,
                type: "dynamic_tool",
                toolName: "omp_command_output",
                title: "OMP command output",
                input: {},
                output: record.text,
                status: "completed",
                completedAt: now,
              },
            });
          }
          if (
            [
              "auto_compaction_start",
              "manual_compaction_start",
              "auto_compaction_end",
              "manual_compaction_end",
            ].includes(record.type)
          ) {
            const manual = record.type.startsWith("manual");
            const key = turn.promptId + (manual ? ":manual-compaction" : ":auto-compaction");
            const base = yield* itemBase(key);
            const complete = record.type.endsWith("_end");
            const now = yield* DateTime.now;
            const result = nativeObject(record.result) ? record.result : {};
            yield* emit({
              type: "turn_item.updated",
              driver: OMP_DRIVER,
              turnItem: {
                ...base,
                type: "compaction",
                driver: OMP_DRIVER,
                title: "Context compaction",
                status: complete
                  ? record.aborted === true
                    ? "cancelled"
                    : record.errorMessage && !record.skipped
                      ? "failed"
                      : "completed"
                  : "running",
                updatedAt: now,
                completedAt: complete ? now : null,
                ...(typeof result.summary === "string" ? { summary: result.summary } : {}),
                ...(typeof result.tokensBefore === "number" && result.tokensBefore >= 0
                  ? { beforeTokenCount: Math.trunc(result.tokensBefore) }
                  : {}),
              },
            });
          }
          if (record.type === "auto_retry_start" || record.type === "auto_retry_end") {
            const attempt =
              typeof record.attempt === "number" &&
              Number.isSafeInteger(record.attempt) &&
              record.attempt > 0
                ? record.attempt
                : 1;
            const base = yield* itemBase(`${turn.promptId}:retry:${attempt}`);
            const now = yield* DateTime.now;
            yield* emit({
              type: "turn_item.updated",
              driver: OMP_DRIVER,
              turnItem: {
                ...base,
                type: "error",
                title: "Native retry",
                status:
                  record.type === "auto_retry_start"
                    ? "running"
                    : record.success
                      ? "completed"
                      : "failed",
                updatedAt: now,
                completedAt: record.type === "auto_retry_end" ? now : null,
                failure: makeProviderFailure({
                  message: "OMP is retrying the model request",
                  retryable: true,
                }),
                retry: {
                  attempt,
                  maxAttempts:
                    typeof record.maxAttempts === "number" &&
                    Number.isInteger(record.maxAttempts) &&
                    record.maxAttempts > 0
                      ? record.maxAttempts
                      : null,
                  retryDelayMs:
                    typeof record.delayMs === "number" && record.delayMs >= 0
                      ? record.delayMs
                      : null,
                },
              },
            });
          }
          if (record.type === "message_start") {
            yield* flushMessage(true);
            turn.blocks.clear();
            turn.messageOrdinal++;
            const key = nativeMessageBaseKey(record.message);
            if (key) {
              const count = messageCounts.get(key) ?? 0;
              messageCounts.set(key, count + 1);
              turn.messageId = `${key}:${count}`;
            } else turn.messageId = "";
          }
          if (record.type === "message_update" && nativeObject(record.assistantMessageEvent)) {
            const delta = record.assistantMessageEvent;
            const type = delta.type;
            const index = typeof delta.contentIndex === "number" ? delta.contentIndex : 0;
            if (
              (type === "text_delta" || type === "thinking_delta") &&
              typeof delta.delta === "string"
            ) {
              const key = `${type === "text_delta" ? "text" : "thinking"}:${index}`;
              turn.blocks.set(key, (turn.blocks.get(key) ?? "") + delta.delta);
              yield* flushMessage(false);
            }
          }
          if (
            record.type === "message_end" &&
            nativeObject(record.message) &&
            record.message.role === "assistant"
          ) {
            const content = record.message.content;
            if (Array.isArray(content)) {
              turn.blocks.clear();
              for (const [index, block] of content.entries())
                if (nativeObject(block)) {
                  if (block.type === "text" && typeof block.text === "string")
                    turn.blocks.set(`text:${index}`, block.text);
                  if (block.type === "thinking" && typeof block.thinking === "string")
                    turn.blocks.set(`thinking:${index}`, block.thinking);
                }
            }
            yield* flushMessage(true);
          }
          if (
            ["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(
              record.type,
            )
          ) {
            const item = tools.update(record);
            if (item) {
              const base = yield* itemBase(`${turn.promptId}:tool:${item.id}`);
              const now = yield* DateTime.now;
              const status = item.complete ? (item.failed ? "failed" : "completed") : "running";
              const finalBase = {
                ...base,
                title: item.name,
                ...(item.toolSurface ? { toolSurface: item.toolSurface } : {}),
                status,
                updatedAt: now,
                completedAt: item.complete ? now : null,
              } as const;
              const projected: OrchestrationV2TurnItem =
                item.kind === "command_execution"
                  ? {
                      ...finalBase,
                      type: "command_execution",
                      input:
                        nativeObject(item.input) && typeof item.input.command === "string"
                          ? item.input.command
                          : "",
                      output: nativeText(item.output),
                      ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
                    }
                  : item.kind === "file_change" && item.fileName
                    ? {
                        ...finalBase,
                        type: "file_change",
                        fileName: item.fileName,
                        ...(item.changes ? { changes: item.changes } : {}),
                        ...(item.oldStr !== undefined ? { oldStr: item.oldStr } : {}),
                        ...(item.newStr !== undefined ? { newStr: item.newStr } : {}),
                        ...(item.diffStr !== undefined ? { diffStr: item.diffStr } : {}),
                      }
                    : item.kind === "web_search"
                      ? {
                          ...finalBase,
                          type: "web_search",
                          ...(item.patterns ? { patterns: item.patterns } : {}),
                          ...(item.webResults ? { results: item.webResults } : {}),
                        }
                      : item.kind === "file_search"
                        ? {
                            ...finalBase,
                            type: "file_search",
                            ...(item.pattern ? { pattern: item.pattern } : {}),
                            ...(item.results ? { results: item.results } : {}),
                          }
                        : {
                            ...finalBase,
                            type: "dynamic_tool",
                            toolName: item.name,
                            input: item.input,
                            output: item.output,
                          };
              if (item.complete) unfinishedTools.delete(item.id);
              else unfinishedTools.set(item.id, projected);
              yield* emit({ type: "turn_item.updated", driver: OMP_DRIVER, turnItem: projected });
              if (
                item.complete &&
                (item.name === "todo_write" || item.name === "todo" || item.name === "eval")
              )
                yield* projectTodos();
            }
          }
        }
      });
      let lastTodos: string | undefined;
      const todoPlanId = PlanId.make(
        `plan:${ids.derive.turnItemFromProviderItem({ driver: OMP_DRIVER, nativeItemId: nativeFile + ":todos" })}`,
      );
      const projectTodos = Effect.fn("OmpAdapter.todos")(function* () {
        if (!thread) return;
        const state = yield* request({ type: "get_state" });
        if (!nativeObject(state) || !Array.isArray(state.todoPhases)) return;
        const phases = state.todoPhases;
        const signature = yield* encodeJson(phases).pipe(
          Effect.mapError((cause) => protocol("Invalid native todo state", cause)),
        );
        if (signature === lastTodos) return;
        if (!phases.length && lastTodos === undefined) {
          lastTodos = signature;
          return;
        }
        lastTodos = signature;
        const steps = phases.flatMap((p, phase) =>
          nativeObject(p) && Array.isArray(p.tasks)
            ? p.tasks.flatMap((task, index) =>
                nativeObject(task) && typeof task.content === "string"
                  ? [
                      {
                        id: `${phase}:${index}`,
                        text:
                          task.status === "blocked"
                            ? `[blocked${typeof task.blocker === "string" ? ": " + task.blocker : ""}] ${task.content}`
                            : task.status === "abandoned"
                              ? `[abandoned] ${task.content}`
                              : task.content,
                        status:
                          task.status === "completed" || task.status === "abandoned"
                            ? ("completed" as const)
                            : task.status === "in_progress"
                              ? ("running" as const)
                              : ("pending" as const),
                      },
                    ]
                  : [],
              )
            : [],
        );
        const base = yield* itemBase("todos");
        const now = yield* DateTime.now;
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_DRIVER,
          turnItem: {
            ...base,
            type: "todo_list",
            planId: todoPlanId,
            steps,
            updatedAt: now,
            status: "completed",
            completedAt: now,
          },
        });
      });
      const bridge = new OmpToolBridge(
        (r) => run(r.type === "set_host_tools" ? request(r) : send(r)),
        async (name, args, signal, update) => {
          if (!endpoint) throw new Error("MCP authorization absent");
          const captured = installedConfig;
          const client = endpoint;
          const authorized = client.t3ToolNames.has(name)
            ? (latest: McpProviderSessionConfig | undefined) => sameT3Authority(captured, latest)
            : (latest: McpProviderSessionConfig | undefined) =>
                NodeUtil.isDeepStrictEqual(captured, latest);
          const result = await client.callTool(name, args, signal, async (partial) => {
            if (authorized(await run(catalogs.read(input.threadId)))) await update(partial);
          });
          if (!authorized(await run(catalogs.read(input.threadId))))
            throw new Error("MCP catalog authorization changed");
          return result;
        },
      );
      let endpoint: AuthorizedMcpTools | undefined;
      let installedConfig: McpProviderSessionConfig | undefined;
      let catalogGeneration = 0;
      const syncCatalog = Effect.fn("OmpAdapter.syncCatalog")(
        function* () {
          const config = yield* catalogs.read(input.threadId);
          if (NodeUtil.isDeepStrictEqual(config, installedConfig)) return;
          const identity = `${input.providerSessionId}:${++catalogGeneration}`;
          const keep =
            endpoint && sameT3Authority(installedConfig, config) ? endpoint.t3ToolNames : undefined;
          yield* Effect.tryPromise({
            try: () => bridge.replace([], "", keep),
            catch: (cause) => protocol("Cannot revoke old OMP catalog", cause),
          });
          endpoint = undefined;
          if (config) {
            if (
              config.providerInstanceId !== options.instanceId ||
              config.threadId !== input.threadId
            )
              return yield* protocol("MCP catalog ownership mismatch");
            const authorized = yield* Effect.tryPromise({
              try: (signal) => connectAuthorizedMcpTools(config, signal),
              catch: (cause) => protocol("Authorized MCP discovery failed", cause),
            });
            endpoint = authorized;
            yield* Effect.tryPromise({
              try: () => bridge.replace(authorized.tools, identity, keep),
              catch: (cause) => protocol("OMP native host tool installation failed", cause),
            });
            yield* catalogs.acknowledgeCatalogEndpoint(config);
          }
          installedConfig = config;
        },
        Effect.onError(() => Effect.tryPromise(() => bridge.cancelPending()).pipe(Effect.ignore)),
      );
      if (!catalogs.onChanged)
        return yield* protocol("OMP requires catalog revocation notifications");
      const changes = yield* Queue.unbounded<void>();
      const unsubscribe = yield* catalogs.onChanged((id) =>
        id === input.threadId ? Queue.offer(changes, undefined).pipe(Effect.asVoid) : Effect.void,
      );
      yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe));
      yield* Stream.fromQueue(changes).pipe(
        Stream.runForEach(() => syncCatalog().pipe(lock.withPermits(1))),
        Effect.catch(() => connection.terminate),
        Effect.forkIn(scope),
      );
      yield* syncCatalog();
      /** False when the prompt cannot become a live secret card; the caller cancels it. */
      const openSecret = Effect.fn("OmpAdapter.openSecret")(function* (record: NativeRecord) {
        const turn = active;
        const label = typeof record.title === "string" ? record.title.trim() : "";
        if (
          record.method !== "input" ||
          typeof record.id !== "string" ||
          !record.id ||
          !turn ||
          !thread ||
          turn.input.providerThread.id !== thread.id
        )
          return false;
        const captured = generation;
        const base = yield* baseItem("secret:" + record.id);
        const item: Extract<OrchestrationV2TurnItem, { type: "secret_request" }> = {
          ...base,
          runId: turn.input.runId,
          nodeId: turn.input.rootNodeId,
          providerThreadId: thread.id,
          status: "waiting",
          title: label || "Secret",
          type: "secret_request",
          label: label || "Secret",
          reason: typeof record.message === "string" ? record.message : "",
          ...(typeof record.placeholder === "string" ? { placeholder: record.placeholder } : {}),
          secretStatus: "pending",
        };
        const receiver: ProviderSecretInputReceiver = {
          owner: {
            threadId: input.threadId,
            turnItemId: item.id,
            runId: turn.input.runId,
            runAttemptId: turn.input.attemptId,
            nodeId: turn.input.rootNodeId,
            providerThreadId: thread.id,
            providerSessionId: input.providerSessionId,
          },
          deliver: (answer) =>
            Effect.suspend(() =>
              captured === generation && secretPrompts.get(item.id)?.receiver === receiver
                ? closeSecret(
                    item.id,
                    answer.type === "save" ? "saved" : "declined",
                    answer.type === "save"
                      ? {
                          type: "extension_ui_response",
                          id: record.id,
                          value: Redacted.value(answer.secret),
                        }
                      : { type: "extension_ui_response", id: record.id, cancelled: true },
                  )
                : Effect.succeed(false),
            ).pipe(lock.withPermits(1)),
        };
        secretPrompts.set(item.id, { record, item, receiver });
        yield* secretInputs.register(receiver);
        if (
          typeof record.timeout === "number" &&
          Number.isFinite(record.timeout) &&
          record.timeout > 0
        ) {
          const fiber = yield* Effect.sleep(
            Duration.millis(Math.min(record.timeout, 86400000)),
          ).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                const pending = secretPrompts.get(item.id);
                if (pending?.receiver !== receiver) return Effect.void;
                delete pending.stopExpiry;
                return closeSecret(item.id, "cancelled", {
                  type: "extension_ui_response",
                  id: record.id,
                  cancelled: true,
                  timedOut: true,
                });
              }).pipe(lock.withPermits(1)),
            ),
            Effect.ignore,
            Effect.forkIn(scope),
          );
          const pending = secretPrompts.get(item.id);
          if (pending) pending.stopExpiry = Fiber.interrupt(fiber).pipe(Effect.asVoid);
        }
        yield* emit({ type: "turn_item.updated", driver: OMP_DRIVER, turnItem: item });
        return true;
      });
      const handle = Effect.fn("OmpAdapter.handle")(function* (record: NativeRecord) {
        if (record.type === "available_commands_update" && Array.isArray(record.commands)) {
          commands = (yield* decodeOmpCommands(record).pipe(
            Effect.mapError((cause) => protocol("Native command update is incompatible", cause)),
          )).commands;
          return;
        }
        if (record.type === "host_tool_call" || record.type === "host_tool_cancel") {
          if (record.type === "host_tool_call" && !active) {
            yield* send({
              type: "host_tool_result",
              id: record.id,
              isError: true,
              result: { content: [{ type: "text", text: "No owned T3 turn" }] },
            });
            return;
          }
          yield* syncCatalog();
          yield* Effect.tryPromise({
            try: () => bridge.handle(record),
            catch: (cause) => protocol("OMP tool bridge failed", cause),
          }).pipe(Effect.forkIn(scope));
          return;
        }
        if (record.type === "extension_ui_request") {
          if (record.method === "cancel" && typeof record.targetId === "string") {
            for (const [id, pending] of runtimeRequests)
              if (pending.record.id === record.targetId) {
                yield* closeRequest(id, "cancelled");
              }
            for (const [id, pending] of secretPrompts)
              if (pending.record.id === record.targetId) yield* closeSecret(id, "cancelled");
            return;
          }
          if (
            [
              "notify",
              "setStatus",
              "setWidget",
              "setTitle",
              "set_editor_text",
              "open_url",
            ].includes(String(record.method))
          ) {
            const message =
              typeof record.message === "string"
                ? record.message
                : typeof record.statusText === "string"
                  ? record.statusText
                  : typeof record.url === "string"
                    ? record.url
                    : typeof record.title === "string"
                      ? record.title
                      : typeof record.text === "string"
                        ? record.text
                        : Array.isArray(record.widgetLines)
                          ? record.widgetLines
                              .filter((v): v is string => typeof v === "string")
                              .join("\n")
                          : "";
            if (message) {
              const base = yield* baseItem("notice:" + record.id);
              const now = yield* DateTime.now;
              yield* emit({
                type: "turn_item.updated",
                driver: OMP_DRIVER,
                turnItem: {
                  ...base,
                  type: "system_notice",
                  message,
                  status: "completed",
                  completedAt: now,
                },
              });
            }
            return;
          }
          if (record.secret === true && (yield* openSecret(record))) return;
          const decoded = yield* Effect.try({
            try: () => ompQuestions(record),
            catch: (cause) => protocol("Unsupported native dialog was cancelled", cause),
          }).pipe(Effect.exit);
          if (Exit.isFailure(decoded)) {
            yield* send({ type: "extension_ui_response", id: record.id, cancelled: true });
            const base = yield* baseItem("unsupported-ui:" + record.id);
            const now = yield* DateTime.now;
            yield* emit({
              type: "turn_item.updated",
              driver: OMP_DRIVER,
              turnItem: {
                ...base,
                type: "system_notice",
                status: "completed",
                completedAt: now,
                message:
                  record.secret === true
                    ? "Native secret input was cancelled: only a single masked text prompt during a turn is supported."
                    : "Unsupported native dialog was cancelled.",
              },
            });
            return;
          }
          const questions = decoded.value;
          const requestId = yield* ids.allocate
            .runtimeRequest({
              driver: OMP_DRIVER,
              nativeRequestId: String(record.id),
              ...(active ? { providerTurnId: active.turn.id } : {}),
            })
            .pipe(Effect.mapError((cause) => protocol("OMP UI identity allocation failed", cause)));
          const now = yield* DateTime.now;
          const nodeId = ids.derive.approvalNode({ requestId });
          const pending: OrchestrationV2RuntimeRequest = {
            id: requestId,
            nodeId,
            providerTurnId: active?.turn.id ?? null,
            nativeRequestRef: ref(String(record.id)),
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "live", providerSessionId: input.providerSessionId },
            createdAt: now,
            resolvedAt: null,
          };
          const base = yield* baseItem("request:" + record.id);
          const item: OrchestrationV2TurnItem = {
            ...base,
            id: ids.derive.approvalTurnItem({ requestId }),
            nodeId,
            type: "user_input_request",
            status: "waiting",
            requestId,
            questions,
          };
          runtimeRequests.set(requestId, { record, request: pending, item });
          yield* publishRequest(pending, item);
          yield* installExpiry(record, pending);
          yield* emit({
            type: "runtime_request.updated",
            driver: OMP_DRIVER,
            threadId: input.threadId,
            runtimeRequest: pending,
          });
          yield* emit({ type: "turn_item.updated", driver: OMP_DRIVER, turnItem: item });
          return;
        }
        if (record.type === "notice") {
          const base = yield* baseItem(`notice:${generation}:${nextNotice++}`);
          const now = yield* DateTime.now;
          yield* emit({
            type: "turn_item.updated",
            driver: OMP_DRIVER,
            turnItem: {
              ...base,
              type: "system_notice",
              status: "completed",
              completedAt: now,
              message:
                record.level === "error"
                  ? "OMP reported a native runtime error"
                  : typeof record.message === "string"
                    ? record.message
                    : "OMP native notice",
            },
          });
          if (
            record.level === "error" &&
            typeof record.source === "string" &&
            /persist|storage/i.test(record.source)
          ) {
            controller.fail("OMP could not persist the conversation");
            yield* drain();
            yield* connection.terminate;
          }
          return;
        }
        if (record.type === "agent_start" && !active)
          return yield* protocol("OMP started work without an owned T3 turn");
        yield* Effect.promise(() => controller.handle(record));
        yield* drain();
      });
      const attachConnection = Effect.fn("OmpAdapter.attachConnection")(function* (
        current: typeof connection,
        captured: number,
      ) {
        yield* Stream.fromQueue(current.events).pipe(
          Stream.runForEach((r) =>
            Effect.suspend(() => (captured === generation ? handle(r) : Effect.void)).pipe(
              lock.withPermits(1),
            ),
          ),
          Effect.catch((cause) =>
            Effect.gen(function* () {
              if (captured !== generation) return;
              transportFailed = true;
              controller.fail("OMP transport or runtime failed");
              yield* drain(false).pipe(
                Effect.ensuring(
                  Effect.gen(function* () {
                    for (const id of runtimeRequests.keys()) yield* closeRequest(id, "cancelled");
                    yield* cancelSecrets(false);
                    active = undefined;
                    yield* updateSession("error");
                    yield* Queue.fail(events, protocol("OMP event stream failed", cause));
                  }),
                ),
                Effect.ensuring(current.terminate),
              );
            }).pipe(lock.withPermits(1)),
          ),
          Effect.forkIn(scope),
        );
        yield* Stream.fromQueue(current.controls).pipe(
          Stream.runForEach((control) =>
            Effect.gen(function* () {
              if (captured !== generation) return;
              if (control.type !== "approval_request") return;
              const tool = control.payload.origin.tool;
              // Matches Pi: T3's read-only tools run without a prompt in every permission mode.
              if (tool !== undefined && endpoint?.readOnlyT3ToolNames.has(tool))
                return yield* current.sendControl({
                  v: 1,
                  type: "approval_answer",
                  providerSession: control.providerSession,
                  epoch: control.epoch,
                  id: control.id,
                  answer: "once",
                });
              const requestId = yield* ids.allocate
                .runtimeRequest({
                  driver: OMP_DRIVER,
                  nativeRequestId: control.id,
                  ...(active ? { providerTurnId: active.turn.id } : {}),
                })
                .pipe(
                  Effect.mapError((cause) => protocol("OMP approval allocation failed", cause)),
                );
              const now = yield* DateTime.now;
              const nodeId = ids.derive.approvalNode({ requestId });
              const request: OrchestrationV2RuntimeRequest = {
                id: requestId,
                nodeId,
                providerTurnId: active?.turn.id ?? null,
                nativeRequestRef: ref(control.id),
                kind: "command",
                status: "pending",
                responseCapability: { type: "live", providerSessionId: input.providerSessionId },
                createdAt: now,
                resolvedAt: null,
              };
              const base = yield* baseItem("approval:" + control.id);
              const item: OrchestrationV2TurnItem = {
                ...base,
                id: ids.derive.approvalTurnItem({ requestId }),
                nodeId,
                type: "approval_request",
                status: "waiting",
                requestId,
                requestKind: "command",
                prompt: control.payload.prompt.full,
              };
              runtimeRequests.set(requestId, {
                record: { type: "approval" },
                request,
                control: {
                  v: 1,
                  type: "approval_answer",
                  providerSession: control.providerSession,
                  epoch: control.epoch,
                  id: control.id,
                  answer: "deny",
                },
                item,
              });
              yield* publishRequest(request, item);
              yield* emit({
                type: "runtime_request.updated",
                driver: OMP_DRIVER,
                threadId: input.threadId,
                runtimeRequest: request,
              });
              yield* emit({ type: "turn_item.updated", driver: OMP_DRIVER, turnItem: item });
            }).pipe(lock.withPermits(1)),
          ),
          Effect.ignore,
          Effect.forkIn(scope),
        );
      });
      yield* attachConnection(connection, generation);
      const replaceConnection = Effect.fn("OmpAdapter.replaceConnection")(function* (
        forkEntry?: string | null,
        alreadyStopped = false,
      ) {
        if (!alreadyStopped) {
          yield* Effect.tryPromise({
            try: () => bridge.replace([], ""),
            catch: (cause) => protocol("OMP catalog revocation failed", cause),
          });
          generation++;
          yield* connection.terminate;
        }
        for (const id of runtimeRequests.keys()) yield* closeRequest(id, "cancelled");
        yield* cancelSecrets(false);
        connection = yield* connect({
          ...launchOptions,
          config: {
            ...initialConfig,
            sessionFile: nativeFile,
            ...(forkEntry === undefined ? {} : { forkEntry }),
          },
        }).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError((cause) => protocol("Guarded OMP replacement failed", cause)),
        );
        const state = yield* request({ type: "get_state" });
        if (
          !nativeObject(state) ||
          state.sessionFile !== nativeFile ||
          (append && (!Array.isArray(state.systemPrompt) || !state.systemPrompt.includes(append)))
        )
          return yield* protocol("OMP replacement identity or instructions differ");
        yield* request({ type: "set_ask_dialog", enabled: true });
        installedConfig = undefined;
        yield* syncCatalog();
        yield* attachConnection(connection, generation);
        lastTodos = undefined;
        yield* projectTodos();
        yield* Effect.tryPromise({
          try: () => history.refresh((r) => run(request(r))),
          catch: (cause) => protocol("OMP replacement history failed", cause),
        });
        messageCounts.clear();
        for (const message of historyMessages(history.branch()))
          messageCounts.set(message.baseKey, (messageCounts.get(message.baseKey) ?? 0) + 1);
      });
      yield* Effect.addFinalizer(() =>
        Effect.tryPromise({
          try: () => bridge.close(),
          catch: (cause) => protocol("OMP bridge cleanup failed", cause),
        }).pipe(Effect.ignore),
      );
      const ensure = Effect.fn("OmpAdapter.ensureThread")(function* (
        value: Adapter.ProviderAdapterV2EnsureThreadInput,
      ) {
        if (thread) {
          if (thread.appThreadId !== value.threadId)
            return yield* protocol("OMP runtime has one thread owner");
          return thread;
        }
        if (
          value.existingProviderThread &&
          (value.existingProviderThread.driver !== OMP_DRIVER ||
            value.existingProviderThread.providerInstanceId !== options.instanceId ||
            value.existingProviderThread.appThreadId !== value.threadId ||
            (value.existingProviderThread.nativeThreadRef !== null &&
              value.existingProviderThread.nativeThreadRef.nativeId !== nativeFile))
        )
          return yield* protocol("OMP resume native identity mismatch");
        const now = yield* DateTime.now;
        thread = value.existingProviderThread
          ? {
              ...value.existingProviderThread,
              providerSessionId: input.providerSessionId,
              nativeThreadRef: ref(nativeFile),
              nativeMetadata: {
                ...value.existingProviderThread.nativeMetadata,
                itemIdentityVersion: 2,
              },
              status: "idle",
              updatedAt: now,
            }
          : {
              id: ids.derive.providerThread({
                driver: OMP_DRIVER,
                nativeThreadId: nativeFile,
                providerInstanceId: options.instanceId,
              }),
              driver: OMP_DRIVER,
              providerInstanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: value.threadId,
              ownerNodeId: null,
              nativeThreadRef: ref(nativeFile),
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [],
              contextUsage: null,
              nativeMetadata: { itemIdentityVersion: 2 },
              goal: null,
              createdAt: now,
              updatedAt: now,
            };
        yield* Effect.tryPromise({
          try: () => history.refresh((r) => run(request(r))),
          catch: (cause) => protocol("OMP resume history failed", cause),
        });
        messageCounts.clear();
        for (const message of historyMessages(history.branch()))
          messageCounts.set(message.baseKey, (messageCounts.get(message.baseKey) ?? 0) + 1);
        yield* emit({
          type: "provider_thread.updated",
          driver: OMP_DRIVER,
          providerThread: thread,
        });
        yield* projectTodos();
        return thread;
      });
      const snapshot = Effect.fn("OmpAdapter.snapshot")(function* (
        value: Adapter.ProviderAdapterV2ReadThreadSnapshotInput,
      ) {
        if (value.providerThread.nativeThreadRef?.nativeId !== nativeFile)
          return yield* protocol("OMP snapshot ownership differs");
        yield* Effect.tryPromise({
          try: () => history.refresh((r) => run(request(r))),
          catch: (cause) => protocol("OMP history resync failed", cause),
        });
        yield* projectTodos();
        return {
          providerThread: thread ?? value.providerThread,
          providerTurns: turns,
          messages: historyMessages(history.branch()).map((message) => ({
            id: ids.derive.messageFromProviderItem({
              driver: OMP_DRIVER,
              nativeItemId: `${nativeFile}:${message.key}`,
            }),
            threadId: input.threadId,
            runId: null,
            nodeId: null,
            role: message.role,
            text: message.text,
            attachments: [],
            streaming: false,
            createdBy: message.role === "assistant" ? ("agent" as const) : ("user" as const),
            creationSource: "provider" as const,
            createdAt: DateTime.makeUnsafe(message.timestamp),
            updatedAt: DateTime.makeUnsafe(message.timestamp),
          })),
          runtimeRequests: [...runtimeRequests.values()].map((v) => v.request),
          providerPayload: { entries: history.branch(), leafId: history.leafId },
        };
      });
      const runtime: Adapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: OMP_DRIVER,
        providerSessionId: input.providerSessionId,
        providerSession: sessionEntity,
        events: Stream.fromQueue(events),
        backgroundTasksEndWithProcess: true,
        hasPendingBackgroundWork: Effect.succeed(false),
        getModelContextWindow: (selection) =>
          discovery.models.find(
            (m) =>
              m.id === (selection.model === "default" ? discovery.defaultModel : selection.model),
          )?.contextWindow ?? undefined,
        canReuseContextUsage: (previous, next) => previous.model === next.model,
        instructionRevisionReplaced: true,
        ensureThread: (value) => ensure(value).pipe(lock.withPermits(1)),
        resumeThread: (value) =>
          ensure({
            threadId: value.threadId ?? input.threadId,
            modelSelection: value.modelSelection ?? input.modelSelection,
            runtimePolicy: value.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: value.providerThread,
          }).pipe(lock.withPermits(1)),
        getAppliedInstructions: () => Effect.succeed(instructions),
        terminateSession: Effect.suspend(() =>
          Effect.gen(function* () {
            for (const id of runtimeRequests.keys()) yield* closeRequest(id, "cancelled");
            yield* cancelSecrets(false);
            yield* connection.terminate;
          }),
        ),
        startTurn: Effect.fn("OmpAdapter.startTurn")(
          function* (value) {
            if (transportFailed) return yield* protocol("OMP transport is unavailable");
            if (active) return yield* protocol("Previous OMP turn is active");
            if (!thread || value.providerThread.id !== thread.id)
              return yield* protocol("OMP turn thread mismatch");
            if (
              value.runtimePolicy.runtimeMode !== input.runtimePolicy.runtimeMode ||
              value.runtimePolicy.cwd !== input.runtimePolicy.cwd ||
              !sameInstructionSnapshot(value.instructionSnapshot, instructions)
            )
              return yield* protocol("OMP policy or instructions require a new guarded session");
            const continuation =
              value.message.createdBy === "agent" && value.message.creationSource === "provider"
                ? `${nativeFile}:${value.message.messageId}`
                : undefined;
            const duplicate = continuation !== undefined && consumedContinuations.has(continuation);
            yield* syncCatalog();
            const current = yield* discoverOmp(connection).pipe(
              Effect.mapError((cause) => protocol("OMP inventory changed incompatibly", cause)),
            );
            commands = current.nativeCommands;
            yield* applyOmpSelection(connection, value.modelSelection, {
              ...current,
              defaultModel: discovery.defaultModel,
              defaultThinking: discovery.defaultThinking,
            }).pipe(Effect.mapError((cause) => protocol("OMP model selection failed", cause)));
            const text = yield* providerMessageTextWithAttachmentPaths({
              text: value.message.text,
              attachments: value.message.attachments,
              resolveAttachmentPath: host.resolveAttachmentPath,
            }).pipe(
              Effect.mapError((cause) => protocol("OMP attachment resolution failed", cause)),
            );
            yield* Effect.try({
              try: () => assertAllowedPrompt(text, commands),
              catch: (cause) => protocol("OMP command dispatch is denied", cause),
            });
            const promptId = `${input.providerSessionId}:${generation}:${nextPrompt++}`;
            const now = yield* DateTime.now;
            const turn: OrchestrationV2ProviderTurn = {
              id: ids.derive.providerTurn({ driver: OMP_DRIVER, nativeTurnId: promptId }),
              providerThreadId: thread.id,
              nodeId: value.rootNodeId,
              runAttemptId: value.attemptId,
              nativeTurnRef: ref(promptId),
              ordinal: value.providerTurnOrdinal,
              status: "running",
              startedAt: now,
              completedAt: null,
            };
            tools = new OmpToolItems();
            active = {
              input: value,
              turn,
              promptId,
              ordinal: value.providerTurnOrdinal * 1000,
              messageOrdinal: 0,
              messageId: "",
              blocks: new Map(),
            };
            yield* emit({
              type: "provider_turn.updated",
              driver: OMP_DRIVER,
              threadId: value.threadId,
              providerTurn: turn,
            });
            yield* updateSession("running");
            if (duplicate) {
              semantic.push({ type: "terminal", id: promptId, status: "completed" });
              yield* drain();
              return;
            }
            if (continuation) consumedContinuations.add(continuation);
            yield* Effect.tryPromise({
              try: () => controller.start(promptId, text, commands),
              catch: (cause) => protocol("OMP prompt was not admitted", cause),
            }).pipe(Effect.onExit(() => drain()));
            if (instructions && value.onInstructionsApplied)
              yield* value.onInstructionsApplied(instructions);
          },
          (effect) => effect.pipe(lock.withPermits(1)),
        ),
        steerTurn: (value) =>
          Effect.suspend(() => {
            if (
              !active ||
              value.providerTurnId !== active.turn.id ||
              value.providerThread.id !== active.turn.providerThreadId
            )
              return protocol("OMP steering owner is stale");
            const key =
              value.message.createdBy === "agent" && value.message.creationSource === "provider"
                ? `${nativeFile}:${value.message.messageId}`
                : undefined;
            if (key && consumedContinuations.has(key)) return Effect.void;
            if (key) consumedContinuations.add(key);
            return Effect.tryPromise({
              try: () => controller.steer(value.message.text, commands),
              catch: (cause) => protocol("OMP steering rejected", cause),
            });
          }).pipe(lock.withPermits(1)),
        interruptTurn: Effect.fn("OmpAdapter.interruptTurn")(
          function* (value) {
            if (!active || value.providerTurnId !== active.turn.id) return;
            for (const [id, pending] of runtimeRequests) {
              if (pending.control)
                yield* connection
                  .sendControl({ ...pending.control, answer: "deny" })
                  .pipe(
                    Effect.mapError((cause) =>
                      protocol("OMP Stop approval cancellation failed", cause),
                    ),
                  );
              else
                yield* send({
                  type: "extension_ui_response",
                  id: pending.record.id,
                  cancelled: true,
                });
              yield* closeRequest(id, "cancelled");
            }
            yield* cancelSecrets(true);
            yield* Effect.tryPromise({
              try: () => bridge.cancelPending(),
              catch: (cause) => protocol("OMP Stop host cancellation failed", cause),
            });
            const stopped = yield* Effect.tryPromise({
              try: () => controller.stop(),
              catch: (cause) => protocol("OMP stop failed", cause),
            }).pipe(Effect.exit);
            if (Exit.isFailure(stopped)) {
              transportFailed = true;
              controller.fail("Native Stop failed");
              yield* drain(false).pipe(
                Effect.ensuring(
                  Effect.gen(function* () {
                    active = undefined;
                    yield* updateSession("error");
                    yield* Queue.fail(events, protocol("OMP Stop transport failed", stopped.cause));
                  }),
                ),
                Effect.ensuring(connection.terminate),
              );
              return yield* Effect.failCause(stopped.cause);
            }
            yield* drain();
            yield* replaceConnection();
          },
          (effect) => effect.pipe(lock.withPermits(1)),
        ),
        respondToRuntimeRequest: Effect.fn("OmpAdapter.respondToRuntimeRequest")(
          function* (value) {
            const pending = runtimeRequests.get(value.requestId);
            if (!pending) return yield* protocol("OMP runtime request expired");
            if (pending.control)
              yield* connection
                .sendControl({
                  ...pending.control,
                  answer:
                    value.decision === "accept" || value.decision === "acceptForSession"
                      ? "once"
                      : "deny",
                })
                .pipe(Effect.mapError((cause) => protocol("OMP approval rejected", cause)));
            else {
              const answer = yield* Effect.try({
                try: () => ompAnswer(pending.record, value.answers),
                catch: (cause) => protocol("Invalid OMP dialog answer", cause),
              });
              yield* send(answer);
            }
            yield* closeRequest(value.requestId, "resolved");
          },
          (effect) => effect.pipe(lock.withPermits(1)),
        ),
        readThreadSnapshot: (value) => snapshot(value).pipe(lock.withPermits(1)),
        rollbackThread: Effect.fn("OmpAdapter.rollbackThread")(
          function* (value) {
            if (active) return yield* protocol("Cannot roll back an active OMP turn");
            if (value.providerThread.nativeThreadRef?.nativeId !== nativeFile)
              return yield* protocol("OMP rollback ownership differs");
            let entry = value.providerThread.forkedFrom
              ? (value.providerThread.nativeMetadata?.forkHeadMessageId ??
                value.providerThread.nativeConversationHeadRef?.nativeId ??
                null)
              : null;
            if (value.target.type === "provider_turn") {
              const targetTurn = value.target.providerTurn;
              entry = value.target.providerTurn.nativeTurnRef?.nativeId ?? null;
              if (!entry || !value.providerThreadTurns.some((t) => t.id === targetTurn.id))
                return yield* protocol("OMP rollback boundary is unavailable");
            }
            yield* replaceConnection(entry);
            return yield* snapshot({ providerThread: value.providerThread });
          },
          (effect) => effect.pipe(lock.withPermits(1)),
        ),
        forkThread: Effect.fn("OmpAdapter.forkThread")(
          function* (value) {
            if (active) return yield* protocol("Cannot fork an active OMP turn");
            if (value.sourceProviderThread.nativeThreadRef?.nativeId !== nativeFile)
              return yield* protocol("OMP fork ownership differs");
            const target = value.providerTurnId
              ? (value.sourceProviderTurns ?? []).find(
                  (t) =>
                    t.id === value.providerTurnId &&
                    t.providerThreadId === value.sourceProviderThread.id,
                )
              : undefined;
            if (value.providerTurnId && !target)
              return yield* protocol("OMP fork turn boundary is unavailable");
            yield* Effect.tryPromise({
              try: () => history.refresh((r) => run(request(r))),
              catch: (cause) => protocol("OMP fork history capture failed", cause),
            });
            const entry = target ? (target.nativeTurnRef?.nativeId ?? null) : history.leafId;
            const targetCwd = value.runtimePolicy?.cwd ?? cwd;
            yield* Effect.tryPromise({
              try: () => bridge.replace([], ""),
              catch: (cause) => protocol("OMP fork catalog revocation failed", cause),
            });
            generation++;
            yield* connection.terminate;
            const forkResult = yield* Effect.scoped(
              Effect.gen(function* () {
                const fork = yield* connect({
                  ...launchOptions,
                  config: {
                    cwd: targetCwd,
                    mode: initialConfig.mode,
                    environment: initialConfig.environment,
                    project: targetCwd,
                    instructions: append,
                    sessionDir: root,
                    forkSource: yield* ownedPath(nativeFile),
                    forkEntry: entry,
                  },
                }).pipe(
                  Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                  Effect.mapError((cause) => protocol("Native guarded fork failed", cause)),
                );
                const state = yield* fork
                  .request({ type: "get_state" })
                  .pipe(
                    Effect.mapError((cause) =>
                      protocol("Native fork acknowledgement failed", cause),
                    ),
                  );
                if (
                  !nativeObject(state) ||
                  typeof state.sessionFile !== "string" ||
                  state.sessionFile === nativeFile
                )
                  return yield* protocol("Native fork identity invalid");
                return state.sessionFile;
              }),
            ).pipe(Effect.exit);
            yield* replaceConnection(undefined, true);
            if (Exit.isFailure(forkResult)) return yield* Effect.failCause(forkResult.cause);
            const forked = forkResult.value;
            const now = yield* DateTime.now;
            return {
              ...value.sourceProviderThread,
              id: ids.derive.providerThread({
                driver: OMP_DRIVER,
                nativeThreadId: forked,
                providerInstanceId: options.instanceId,
              }),
              providerSessionId: null,
              appThreadId: value.targetThreadId,
              ownerNodeId: value.ownerNodeId ?? null,
              nativeThreadRef: ref(forked),
              nativeConversationHeadRef: entry ? ref(entry) : null,
              nativeMetadata: {
                ...value.sourceProviderThread.nativeMetadata,
                forkHeadMessageId: entry ?? undefined,
              },
              status: "not_loaded" as const,
              forkedFrom: {
                providerThreadId: value.sourceProviderThread.id,
                ...(target ? { providerTurnId: target.id } : {}),
              },
              createdAt: now,
              updatedAt: now,
            };
          },
          (effect) => effect.pipe(lock.withPermits(1)),
        ),
      };
      return runtime;
    }),
  } satisfies Adapter.ProviderAdapterV2["Service"];
});
