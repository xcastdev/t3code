import {
  EventId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type TurnTokenUsage,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeUtil from "node:util";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  PiManagedRuntimeError,
  type PiManagedEventObserver,
  type PiManagedOperationRequest,
  type PiManagedPreparedOperation,
  type PiManagedRuntimeInstance,
} from "../pi/PiManagedRuntime.ts";
import type {
  ProviderAdapterShape,
  ProviderAdapterSessionStartInput,
} from "../Services/ProviderAdapter.ts";
import type { PiSessionTerminal } from "../pi/PiSessionRuntime.ts";

const provider = ProviderDriverKind.make("piAgent");
const invalid = (operation: string, issue: string) =>
  new ProviderAdapterValidationError({ provider, operation, issue });
const requestError = (method: string, error: PiManagedRuntimeError) =>
  new ProviderAdapterRequestError({
    provider,
    method,
    detail: {
      denied: "Pi authorization was denied. Review the current assignment and permissions.",
      conflict: "Pi operation conflicts with current state. Refresh the session before retrying.",
      unavailable: "Pi operation is unavailable. Review its setup and runtime availability.",
      uncertain:
        "Pi operation could not be confirmed. Reconcile the owned session before retrying.",
    }[error.code],
  });

const unavailableUsage: TurnTokenUsage = {
  usageScope: "main_agent",
  usageStatus: "unavailable",
  hasSubagents: false,
};
const count = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const receiptText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const accountingReceipt = Schema.Struct({
  requestId: count.check(Schema.isGreaterThan(0)),
  reservationId: receiptText,
  accountingReceiptId: receiptText,
  routeId: receiptText,
  provider: Schema.Literal("command-code"),
  model: receiptText,
  reportedModel: receiptText,
  usage: Schema.Struct({
    prompt_tokens: count,
    completion_tokens: count,
    total_tokens: count,
    prompt_tokens_details: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          cached_tokens: Schema.optional(count),
          cache_read_input_tokens: Schema.optional(count),
          cache_write_tokens: Schema.optional(count),
          cache_creation_input_tokens: Schema.optional(count),
        }),
      ),
    ),
    completion_tokens_details: Schema.optional(
      Schema.NullOr(Schema.Struct({ reasoning_tokens: Schema.optional(count) })),
    ),
    prompt_cache_hit_tokens: Schema.optional(count),
    prompt_cache_miss_tokens: Schema.optional(count),
    cached_tokens: Schema.optional(count),
  }),
});
const decodeAccountingReceipts = Schema.decodeEffect(Schema.Array(accountingReceipt));
const invalidAccounting = () =>
  requestError(
    "accounting",
    new PiManagedRuntimeError({
      code: "uncertain",
      detail: "Accounting receipts require reconciliation.",
    }),
  );

/** Receipts report tokens only; reservation charges and unknown billing stay in the parent. */
const terminalUsage = Effect.fn("PiAdapter.terminalUsage")(function* (
  terminal: PiSessionTerminal,
): Effect.fn.Return<TurnTokenUsage, ProviderAdapterRequestError> {
  if (terminal.accountingReceipts.length === 0) return unavailableUsage;
  if (terminal.accountingReceipts.length > 1024) return yield* invalidAccounting();
  const receipts = yield* decodeAccountingReceipts(terminal.accountingReceipts).pipe(
    Effect.mapError(invalidAccounting),
  );
  const unique = new Map<string, typeof accountingReceipt.Type>();
  const originals = new Map<string, PiSessionTerminal["accountingReceipts"][number]>();
  const requests = new Set<number>();
  const reservations = new Set<string>();
  let input = 0,
    output = 0,
    cached = 0,
    created = 0,
    reasoning = 0;
  let cachedReports = 0,
    createdReports = 0,
    reasoningReports = 0;
  let route: typeof accountingReceipt.Type | undefined;
  for (const [index, receipt] of receipts.entries()) {
    const previous = unique.get(receipt.accountingReceiptId);
    if (previous) {
      if (
        !NodeUtil.isDeepStrictEqual(previous, receipt) ||
        !NodeUtil.isDeepStrictEqual(
          originals.get(receipt.accountingReceiptId),
          terminal.accountingReceipts[index],
        )
      )
        return yield* invalidAccounting();
      continue;
    }
    if (
      requests.has(receipt.requestId) ||
      reservations.has(receipt.reservationId) ||
      (route && (route.routeId !== receipt.routeId || route.model !== receipt.model))
    )
      return yield* invalidAccounting();
    route = receipt;
    unique.set(receipt.accountingReceiptId, receipt);
    originals.set(receipt.accountingReceiptId, terminal.accountingReceipts[index]!);
    requests.add(receipt.requestId);
    reservations.add(receipt.reservationId);
    const usage = receipt.usage;
    const reads = [
      usage.prompt_tokens_details?.cached_tokens,
      usage.prompt_tokens_details?.cache_read_input_tokens,
      usage.prompt_cache_hit_tokens,
      usage.cached_tokens,
    ].filter((value) => value !== undefined);
    const writes = [
      usage.prompt_tokens_details?.cache_write_tokens,
      usage.prompt_tokens_details?.cache_creation_input_tokens,
    ].filter((value) => value !== undefined);
    const read = reads[0],
      write = writes[0],
      reason = usage.completion_tokens_details?.reasoning_tokens;
    if (
      reads.some((value) => value !== read) ||
      writes.some((value) => value !== write) ||
      usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens ||
      (read ?? 0) + (write ?? 0) > usage.prompt_tokens ||
      (usage.prompt_cache_miss_tokens !== undefined &&
        (usage.prompt_cache_miss_tokens > usage.prompt_tokens ||
          (read !== undefined && read + usage.prompt_cache_miss_tokens !== usage.prompt_tokens))) ||
      (reason ?? 0) > usage.completion_tokens
    )
      return yield* invalidAccounting();
    input += usage.prompt_tokens;
    output += usage.completion_tokens;
    if (read !== undefined) {
      cached += read;
      cachedReports++;
    }
    if (write !== undefined) {
      created += write;
      createdReports++;
    }
    if (reason !== undefined) {
      reasoning += reason;
      reasoningReports++;
    }
    if (![input, output, input + output, cached, created, reasoning].every(Number.isSafeInteger))
      return yield* invalidAccounting();
  }
  const hasPartialDetail = [cachedReports, createdReports, reasoningReports].some(
    (reports) => reports > 0 && reports !== unique.size,
  );
  return {
    usageScope: "main_agent",
    usageStatus: terminal.outcome === "success" && !hasPartialDetail ? "complete" : "partial",
    hasSubagents: false,
    inputTokens: input,
    outputTokens: output,
    ...(cachedReports > 0 ? { cachedInputTokens: cached } : {}),
    ...(createdReports > 0 ? { cacheCreationTokens: created } : {}),
    ...(reasoningReports > 0 ? { reasoningTokens: reasoning } : {}),
  };
});

type ActiveOperation = {
  readonly prepared: Deferred.Deferred<PiManagedPreparedOperation, ProviderAdapterError>;
  readonly result: Deferred.Deferred<ProviderSession, ProviderAdapterError>;
  readonly done: Deferred.Deferred<void>;
  operation?: PiManagedPreparedOperation;
  acceptingEvents: boolean;
  canceled?: boolean;
  tokenUsage: TurnTokenUsage;
};
type SessionContext = {
  readonly threadId: ThreadId;
  session?: ProviderSession;
  active?: ActiveOperation | undefined;
  failure?: ProviderAdapterError;
  closing: boolean;
  lastOperationId?: string;
  stop?: Deferred.Deferred<void, ProviderAdapterError>;
};

/** This adapter owns logical sessions and fibers; the private runtime owns durable intent and execution. */
export const makePiAdapter = Effect.fn("makePiAdapter")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly runtime: PiManagedRuntimeInstance;
}): Effect.fn.Return<ProviderAdapterShape<ProviderAdapterError>, never, Scope.Scope> {
  const { instanceId, runtime } = input;
  const operationScope = yield* Scope.make();
  const events = yield* PubSub.dropping<ProviderRuntimeEvent>(256);
  const sessions = new Map<ThreadId, SessionContext>();
  let shuttingDown = false;

  const emit = Effect.fn("PiAdapter.emit")(function* (event: ProviderRuntimeEvent) {
    if (shuttingDown) return;
    if (!(yield* PubSub.publish(events, event)))
      return yield* requestError(
        "events",
        new PiManagedRuntimeError({
          code: "uncertain",
          detail:
            "Pi event subscriber exceeded the bounded buffer; durable reconciliation is required.",
        }),
      );
  });
  const eventBase = Effect.fn("PiAdapter.eventBase")(function* (
    context: SessionContext,
    active: ActiveOperation,
    suffix: string,
  ) {
    const operation = active.operation;
    return {
      eventId: EventId.make(
        `pi:${instanceId}:${context.threadId}:${operation?.operation.operationId}:${suffix}`,
      ),
      provider,
      providerInstanceId: instanceId,
      threadId: context.threadId,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      ...(operation?.kind === "prompt" ? { turnId: operation.turnId } : {}),
    };
  });
  const observe = (context: SessionContext, active: ActiveOperation): PiManagedEventObserver =>
    Effect.fn("PiAdapter.observe")(function* (event) {
      if (shuttingDown || context.closing || context.active !== active || !active.acceptingEvents)
        return;
      if (!active.operation)
        return yield* new PiManagedRuntimeError({
          code: "uncertain",
          detail: "Pi emitted an event before durable preparation returned.",
        });
      if (
        event.provider !== provider ||
        event.providerInstanceId !== instanceId ||
        event.threadId !== context.threadId ||
        (active.operation?.kind === "prompt" &&
          event.turnId !== undefined &&
          event.turnId !== active.operation.turnId)
      )
        return yield* new PiManagedRuntimeError({
          code: "uncertain",
          detail: "Pi event identity did not match its owned operation.",
        });
      // Worker lifecycle events cannot settle a parent operation or close its logical session.
      if (
        event.type.startsWith("session.") ||
        event.type === "turn.completed" ||
        event.type === "turn.aborted" ||
        event.type === "turn.started"
      )
        return;
      yield* emit(event).pipe(
        Effect.mapError(
          () =>
            new PiManagedRuntimeError({
              code: "uncertain",
              detail: "Pi event subscriber exceeded the bounded buffer.",
            }),
        ),
      );
    });
  const owned = Effect.fn("PiAdapter.owned")(function* (threadId: ThreadId) {
    if (shuttingDown) return yield* new ProviderAdapterSessionClosedError({ provider, threadId });
    const context = sessions.get(threadId);
    if (!context) return yield* new ProviderAdapterSessionNotFoundError({ provider, threadId });
    if (context.closing)
      return yield* new ProviderAdapterSessionClosedError({ provider, threadId });
    if (context.failure) return yield* context.failure;
    return context;
  });
  const validateSession = Effect.fn("PiAdapter.validateSession")(function* (
    session: ProviderSession,
    threadId: ThreadId,
  ) {
    if (
      session.provider !== provider ||
      session.providerInstanceId !== instanceId ||
      session.threadId !== threadId
    )
      return yield* requestError(
        "session",
        new PiManagedRuntimeError({
          code: "uncertain",
          detail: "Committed Pi session identity did not match this adapter.",
        }),
      );
    return session.lastError === undefined
      ? session
      : {
          ...session,
          lastError: requestError(
            "session",
            new PiManagedRuntimeError({ code: "uncertain", detail: "Private session diagnostic." }),
          ).detail,
        };
  });
  const checkHints = Effect.fn("PiAdapter.checkHints")(function* (
    session: ProviderSession,
    hints: ProviderAdapterSessionStartInput,
  ) {
    if (
      session.runtimeMode !== hints.runtimeMode ||
      (hints.cwd !== undefined && hints.cwd !== session.cwd) ||
      (hints.modelSelection !== undefined && hints.modelSelection.model !== session.model) ||
      (hints.resumeCursor !== undefined &&
        !NodeUtil.isDeepStrictEqual(hints.resumeCursor, session.resumeCursor))
    )
      return yield* invalid(
        "startSession",
        "Requested session hints do not match the current committed Pi session.",
      );
  });
  const stopContext = Effect.fn("PiAdapter.stopContext")((context: SessionContext) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (!context.stop) {
          const result = yield* Deferred.make<void, ProviderAdapterError>();
          context.stop = result;
          context.closing = true;
          if (context.active) context.active.acceptingEvents = false;
          const stop = Effect.gen(function* () {
            yield* runtime
              .requestStop(context.threadId)
              .pipe(Effect.mapError((error) => requestError("stopSession", error)));
            if (context.active) yield* Deferred.await(context.active.done);
            if (sessions.get(context.threadId) !== context) return;
            // Retain the ownership fence until the exit has been published.
            yield* emit({
              eventId: EventId.make(
                `pi:${instanceId}:${context.threadId}:${context.lastOperationId}:closed`,
              ),
              provider,
              providerInstanceId: instanceId,
              threadId: context.threadId,
              createdAt: DateTime.formatIso(yield* DateTime.now),
              type: "session.exited",
              payload: {
                reason: "Pi session stopped after durable drain.",
                recoverable: false,
                exitKind: "graceful",
              },
            });
            if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
          }).pipe(
            Effect.tapError((error) =>
              Effect.gen(function* () {
                context.failure = error;
                if (context.session)
                  context.session = {
                    ...context.session,
                    status: "error",
                    lastError: error.detail,
                  };
                if (sessions.get(context.threadId) === context)
                  yield* emit({
                    eventId: EventId.make(
                      `pi:${instanceId}:${context.threadId}:${context.lastOperationId}:stop-error`,
                    ),
                    provider,
                    providerInstanceId: instanceId,
                    threadId: context.threadId,
                    createdAt: DateTime.formatIso(yield* DateTime.now),
                    type: "session.state.changed",
                    payload: { state: "error", reason: error.detail },
                  }).pipe(Effect.ignore);
              }),
            ),
            Effect.onExit((exit) => Deferred.done(result, exit)),
            Effect.ignore,
          );
          yield* Effect.forkIn(stop, operationScope);
        }
        yield* restore(Deferred.await(context.stop));
      }),
    ),
  );

  const launch = Effect.fn("PiAdapter.launch")(function* (
    context: SessionContext,
    request: PiManagedOperationRequest,
    hints?: ProviderAdapterSessionStartInput,
  ) {
    if (context.active)
      return yield* invalid(
        request.kind,
        "Pi already has an initialization or turn in progress for this thread.",
      );
    const active: ActiveOperation = {
      prepared: yield* Deferred.make<PiManagedPreparedOperation, ProviderAdapterError>(),
      result: yield* Deferred.make<ProviderSession, ProviderAdapterError>(),
      done: yield* Deferred.make<void>(),
      acceptingEvents: true,
      tokenUsage: unavailableUsage,
    };
    context.active = active;
    const work = Effect.gen(function* () {
      const prepared = yield* runtime
        .prepareOperation(request, observe(context, active))
        .pipe(Effect.mapError((error) => requestError(request.kind, error)));
      // Capture the returned operation once; controls and completion never consult mutable adapter selection.
      active.operation = {
        ...prepared,
        operation: Object.freeze({ ...prepared.operation }),
        interrupt: yield* Effect.cached(prepared.interrupt),
      };
      context.lastOperationId = active.operation.operation.operationId;
      if (prepared.kind !== request.kind || prepared.operation.operationKind !== request.kind)
        return yield* requestError(
          request.kind,
          new PiManagedRuntimeError({
            code: "uncertain",
            detail: "Prepared Pi operation kind did not match its request.",
          }),
        );
      if (shuttingDown || context.closing) {
        return yield* new ProviderAdapterSessionClosedError({
          provider,
          threadId: context.threadId,
        });
      }
      if (active.operation.kind === "prompt" && context.session)
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: active.operation.turnId,
        };
      yield* Deferred.succeed(active.prepared, active.operation);
      if (active.operation.kind === "prompt")
        yield* emit({
          ...(yield* eventBase(context, active, "started")),
          type: "turn.started",
          payload: {},
        });
      const output = yield* active.operation.run.pipe(
        Effect.mapError((error) => requestError(request.kind, error)),
      );
      active.acceptingEvents = false;
      const session = yield* validateSession(output.session, context.threadId);
      if (
        output.terminal.operation.operationId !== active.operation.operation.operationId ||
        output.terminal.operation.operationKind !== request.kind
      )
        return yield* requestError(
          request.kind,
          new PiManagedRuntimeError({
            code: "uncertain",
            detail: "Durable Pi terminal did not match its operation.",
          }),
        );
      const outcome = output.terminal.outcome;
      active.tokenUsage = yield* terminalUsage(output.terminal);
      if (outcome === "success" && !context.closing && !shuttingDown) {
        if (!output.terminal.ownerCaptured || output.terminal.drain === null)
          return yield* requestError(
            request.kind,
            new PiManagedRuntimeError({
              code: "uncertain",
              detail: "Successful Pi operation lacks captured-owner drain evidence.",
            }),
          );
        if (hints) yield* checkHints(session, hints);
        if (session.status !== "ready")
          return yield* requestError(
            request.kind,
            new PiManagedRuntimeError({
              code: "uncertain",
              detail: "Successful Pi operation did not return a ready committed session.",
            }),
          );
        // Validation can auto-yield; final ownership and publication must share one evaluation.
        yield* Effect.suspend(() => {
          if (shuttingDown || context.closing)
            return Effect.fail(
              new ProviderAdapterSessionClosedError({ provider, threadId: context.threadId }),
            );
          if (context.failure) return Effect.fail(context.failure);
          if (
            sessions.get(context.threadId) !== context ||
            context.active !== active ||
            context.lastOperationId !== output.terminal.operation.operationId
          )
            return Effect.fail(
              requestError(
                request.kind,
                new PiManagedRuntimeError({
                  code: "conflict",
                  detail: "Pi operation no longer owns its session.",
                }),
              ),
            );
          context.session = session;
          return Effect.void;
        });
        if (active.operation.kind === "initialize")
          yield* emit({
            ...(yield* eventBase(context, active, "ready")),
            type: "session.started",
            payload: { resume: session.resumeCursor },
          });
        if (active.operation.kind === "prompt")
          yield* emit({
            ...(yield* eventBase(context, active, "terminal")),
            type: "turn.completed",
            payload: { state: "completed", tokenUsage: active.tokenUsage },
          });
        return session;
      }
      if (outcome === "canceled") {
        if (
          !output.terminal.ownerCaptured ||
          output.terminal.drain === null ||
          session.status !== "ready" ||
          session.activeTurnId !== undefined
        )
          return yield* requestError(
            request.kind,
            new PiManagedRuntimeError({
              code: "uncertain",
              detail: "Canceled terminal is not a settled ready session.",
            }),
          );
        active.canceled = true;
        if (
          !shuttingDown &&
          !context.closing &&
          sessions.get(context.threadId) === context &&
          context.active === active &&
          context.lastOperationId === output.terminal.operation.operationId &&
          context.session &&
          !context.failure
        )
          context.session = session;
        if (active.operation.kind === "prompt")
          yield* emit({
            ...(yield* eventBase(context, active, "terminal")),
            type: "turn.aborted",
            payload: {
              reason: "Pi operation canceled after durable settlement.",
              tokenUsage: active.tokenUsage,
            },
          });
        return yield* requestError(
          request.kind,
          new PiManagedRuntimeError({ code: "conflict", detail: "Pi operation was canceled." }),
        );
      }
      return yield* requestError(
        request.kind,
        new PiManagedRuntimeError({
          code: outcome === "quarantine" ? "uncertain" : "unavailable",
          detail: "Pi durable operation did not succeed.",
        }),
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (
            !(context.closing || shuttingDown || (active.canceled && context.session)) &&
            error._tag !== "ProviderAdapterValidationError"
          ) {
            context.failure = error;
            if (context.session)
              context.session = { ...context.session, status: "error", lastError: error.message };
          }
          if (
            active.operation?.kind === "prompt" &&
            !(context.closing || shuttingDown) &&
            context.failure
          )
            yield* emit({
              ...(yield* eventBase(context, active, "terminal")),
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage: error.message,
                tokenUsage: active.tokenUsage,
              },
            }).pipe(Effect.ignore);
          yield* Deferred.fail(active.prepared, error);
          return yield* error;
        }),
      ),
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          active.acceptingEvents = false;
          if (context.active === active) context.active = undefined;
          if (Exit.isFailure(exit)) yield* Deferred.failCause(active.prepared, exit.cause);
          else
            yield* Deferred.fail(
              active.prepared,
              invalid(request.kind, "Pi preparation did not produce an operation."),
            );
          yield* Deferred.succeed(active.done, undefined);
          yield* Deferred.done(active.result, exit);
        }),
      ),
    );
    yield* Effect.forkIn(work.pipe(Effect.ignore), operationScope);
    return active;
  });

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = Effect.fn(
    "PiAdapter.startSession",
  )((callerHints) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const hints = yield* Effect.try({
          try: () => ({
            ...callerHints,
            ...(callerHints.resumeCursor !== undefined
              ? { resumeCursor: structuredClone(callerHints.resumeCursor) }
              : {}),
            ...(callerHints.modelSelection !== undefined
              ? { modelSelection: structuredClone(callerHints.modelSelection) }
              : {}),
          }),
          catch: () =>
            invalid("startSession", "Pi resume and model hints must be structured data."),
        });
        if (shuttingDown)
          return yield* new ProviderAdapterSessionClosedError({
            provider,
            threadId: hints.threadId,
          });
        if (
          (hints.provider !== undefined && hints.provider !== provider) ||
          (hints.providerInstanceId !== undefined && hints.providerInstanceId !== instanceId) ||
          (hints.modelSelection !== undefined && hints.modelSelection.instanceId !== instanceId)
        )
          return yield* invalid(
            "startSession",
            "Pi instance selection does not match this adapter.",
          );
        if (
          hints.approvalPolicy !== undefined ||
          hints.sandboxMode !== undefined ||
          (hints.modelSelection?.options && Object.keys(hints.modelSelection.options).length > 0) ||
          (hints.projectMcpServers?.length ?? 0) > 0
        )
          return yield* invalid(
            "startSession",
            "Pi does not support caller approval, sandbox, model options or project MCP overrides.",
          );
        const existing = sessions.get(hints.threadId);
        if (existing) {
          const context = yield* owned(hints.threadId);
          if (context.active)
            return yield* invalid(
              "startSession",
              "Pi initialization or turn is already in progress.",
            );
          const previousSession = context.session;
          const previousOperationId = context.lastOperationId;
          const session = yield* runtime.readSession(hints.threadId).pipe(
            Effect.mapError((error) => requestError("readSession", error)),
            Effect.flatMap((session) => validateSession(session, hints.threadId)),
          );
          yield* checkHints(session, hints);
          // Check ownership and publish together: even a synchronous Effect helper can auto-yield.
          return yield* Effect.suspend(() => {
            if (shuttingDown)
              return Effect.fail(
                new ProviderAdapterSessionClosedError({ provider, threadId: hints.threadId }),
              );
            const current = sessions.get(hints.threadId);
            if (!current)
              return Effect.fail(
                new ProviderAdapterSessionNotFoundError({ provider, threadId: hints.threadId }),
              );
            if (current.closing)
              return Effect.fail(
                new ProviderAdapterSessionClosedError({ provider, threadId: hints.threadId }),
              );
            if (current.failure) return Effect.fail(current.failure);
            if (
              current !== context ||
              context.active ||
              context.session !== previousSession ||
              context.lastOperationId !== previousOperationId
            )
              return Effect.fail(
                invalid(
                  "startSession",
                  "Pi session changed while its committed state was being read. Retry with current session hints.",
                ),
              );
            context.session = session;
            return Effect.succeed(session);
          });
        }
        const context: SessionContext = { threadId: hints.threadId, closing: false };
        sessions.set(hints.threadId, context);
        const request = {
          threadId: hints.threadId,
          kind: "initialize" as const,
          runtimeMode: hints.runtimeMode,
          ...(hints.cwd !== undefined ? { cwd: hints.cwd } : {}),
          ...(hints.modelSelection !== undefined
            ? { modelSelection: structuredClone(hints.modelSelection) }
            : {}),
          ...(hints.resumeCursor !== undefined ? { resumeCursor: hints.resumeCursor } : {}),
        };
        const active = yield* launch(context, request, hints);
        return yield* restore(Deferred.await(active.result)).pipe(
          Effect.onInterrupt(() => stopContext(context).pipe(Effect.ignore)),
        );
      }),
    ),
  );
  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = Effect.fn(
    "PiAdapter.sendTurn",
  )((turn) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (
          !turn.input?.trim() ||
          turn.continuation ||
          (turn.attachments?.length ?? 0) > 0 ||
          (turn.interactionMode !== undefined && turn.interactionMode !== "default") ||
          (turn.modelSelection?.options && Object.keys(turn.modelSelection.options).length > 0) ||
          (turn.modelSelection !== undefined && turn.modelSelection.instanceId !== instanceId)
        )
          return yield* invalid(
            "sendTurn",
            "Pi requires explicit text without attachments, continuation, plan mode or model option overrides.",
          );
        const context = yield* owned(turn.threadId);
        if (!context.session)
          return yield* new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: turn.threadId,
          });
        const active = yield* launch(context, {
          threadId: turn.threadId,
          kind: "prompt",
          prompt: turn.input,
          ...(turn.modelSelection !== undefined
            ? { modelSelection: structuredClone(turn.modelSelection) }
            : {}),
        });
        const prepared = yield* restore(Deferred.await(active.prepared)).pipe(
          Effect.onInterrupt(() => stopContext(context).pipe(Effect.ignore)),
        );
        if (prepared.kind !== "prompt")
          return yield* invalid("sendTurn", "Pi did not prepare a prompt turn.");
        return {
          threadId: turn.threadId,
          turnId: prepared.turnId,
          resumeCursor: context.session.resumeCursor,
        };
      }),
    ),
  );
  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = Effect.fn(
    "PiAdapter.interruptTurn",
  )(function* (threadId, turnId) {
    const context = yield* owned(threadId);
    const active = context.active;
    if (
      !active?.operation ||
      active.operation.kind !== "prompt" ||
      (turnId !== undefined && turnId !== active.operation.turnId)
    )
      return yield* invalid("interruptTurn", "Pi has no matching active prompt turn.");
    const receipt = yield* active.operation.interrupt.pipe(
      Effect.mapError((error) => requestError("interruptTurn", error)),
    );
    if (receipt.status !== "received")
      return yield* requestError(
        "interruptTurn",
        new PiManagedRuntimeError({
          code: "uncertain",
          detail: "Pi interrupt receipt is unresolved; it must not be replayed.",
        }),
      );
    yield* Deferred.await(active.done);
    if (context.failure) return yield* context.failure;
  });
  const stopAllWork = Effect.fn("PiAdapter.stopAll")(function* () {
    shuttingDown = true;
    for (const context of sessions.values()) {
      context.closing = true;
      if (context.active) context.active.acceptingEvents = false;
    }
    yield* PubSub.shutdown(events);
    const stop = yield* Effect.exit(
      runtime.stopAll.pipe(
        Effect.mapError((error) => requestError("stopAll", error)),
        Effect.tapError((error) =>
          Effect.sync(() => {
            for (const context of sessions.values()) {
              context.failure = error;
              if (context.session)
                context.session = { ...context.session, status: "error", lastError: error.message };
            }
          }),
        ),
      ),
    );
    yield* Scope.close(operationScope, stop);
    if (Exit.isFailure(stop)) return yield* Effect.failCause(stop.cause);
    sessions.clear();
  });
  const shutdown = yield* Effect.cached(Effect.uninterruptible(stopAllWork()));
  const stopAll = () => shutdown;
  yield* Effect.addFinalizer(() =>
    stopAll().pipe(
      Effect.catch((error) =>
        Effect.logWarning("Pi instance teardown requires durable reconciliation", error.message),
      ),
    ),
  );
  return {
    provider,
    capabilities: {
      sessionModelSwitch: "unsupported",
      supportsConversationRollback: false,
      promptlessTurnContinuation: false,
      activeTurnSteer: false,
      remoteHttpMcp: "unsupported",
      projectMcpProxy: "unsupported",
      managedPreviewMcp: "unsupported",
      sessionMcpCatalog: "unsupported",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest: () =>
      Effect.fail(invalid("respondToRequest", "Pi interactive approval replies are unsupported.")),
    respondToUserInput: () =>
      Effect.fail(
        invalid("respondToUserInput", "Pi interactive user input replies are unsupported."),
      ),
    stopSession: Effect.fn("PiAdapter.stopSession")(function* (threadId) {
      const context = sessions.get(threadId);
      if (!context) return yield* new ProviderAdapterSessionNotFoundError({ provider, threadId });
      yield* stopContext(context);
    }),
    listSessions: () =>
      Effect.sync(() =>
        [...sessions.values()].flatMap((context) => (context.session ? [context.session] : [])),
      ),
    hasSession: (threadId) =>
      Effect.sync(() => !shuttingDown && sessions.get(threadId)?.session !== undefined),
    readThread: (threadId) =>
      runtime
        .readThread(threadId)
        .pipe(Effect.mapError((error) => requestError("readThread", error))),
    rollbackThread: () =>
      Effect.fail(invalid("rollbackThread", "Pi conversation rollback is unsupported.")),
    stopAll,
    streamEvents: Stream.fromPubSub(events),
  };
});
