import type {
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ProviderRuntimeTurnCompletedEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

export interface ProjectTeamTurnPublication {
  readonly sequence: bigint;
  readonly event: ProviderRuntimeEvent;
}

export interface ProjectTeamTurnIdentity {
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  /** The original retained assignment operation ID, as a TurnId. */
  readonly turnId: TurnId;
}

export class ProjectTeamTurnObserverError extends Schema.TaggedError<ProjectTeamTurnObserverError>()(
  "ProjectTeamTurnObserverError",
  {
    code: Schema.Literals([
      "invalid-capacity",
      "invalid-sequence",
      "duplicate",
      "capacity",
      "stopped",
    ]),
  },
) {}

export interface ProjectTeamTurnObserverStopReceipt {
  readonly consumer: Exit.Exit<void, ProjectTeamTurnObserverError>;
  readonly observations: readonly Exit.Exit<unknown, unknown>[];
  readonly subscription: Exit.Exit<void>;
}

interface Pending {
  readonly identity: ProjectTeamTurnIdentity;
  readonly afterSequence: bigint;
  readonly completed: Deferred.Deferred<
    ProviderRuntimeTurnCompletedEvent,
    ProjectTeamTurnObserverError
  >;
  readonly join: Deferred.Deferred<Effect.Effect<Exit.Exit<unknown, unknown>>>;
  cancel?: () => void;
}

/** Observe actual terminal publications; Root must read the original retained receipt afterward. */
export function makeProjectTeamTurnObserver<RootError, RootServices>(options: {
  readonly subscribe: Effect.Effect<
    PubSub.Subscription<ProjectTeamTurnPublication>,
    RootError,
    RootServices | Scope.Scope
  >;
  readonly currentPublicationSequence: () => bigint;
  readonly maximumPending: number;
}) {
  const { subscribe, currentPublicationSequence, maximumPending } = options;
  return makeObserver(subscribe, currentPublicationSequence, maximumPending);
}

const makeObserver = Effect.fn("makeProjectTeamTurnObserver")(function* <RootError, RootServices>(
  subscribe: Effect.Effect<
    PubSub.Subscription<ProjectTeamTurnPublication>,
    RootError,
    RootServices | Scope.Scope
  >,
  currentPublicationSequence: () => bigint,
  maximumPending: number,
) {
  if (!Number.isInteger(maximumPending) || maximumPending < 1 || maximumPending > 128) {
    return yield* new ProjectTeamTurnObserverError({ code: "invalid-capacity" });
  }
  const rootContext = Context.omit(Scope.Scope)(
    yield* Effect.context<RootServices | Scope.Scope>(),
  );
  const rootScope = yield* Effect.scope;
  const subscriptionScope = yield* Scope.fork(rootScope);
  const subscription = yield* subscribe.pipe(
    Effect.interruptible,
    Effect.provideService(Scope.Scope, subscriptionScope),
    Effect.onExit((exit) =>
      Exit.isFailure(exit) ? Scope.close(subscriptionScope, exit) : Effect.void,
    ),
  );
  const pending = new Map<string, Pending>();
  let closed: Cause.Cause<ProjectTeamTurnObserverError> | undefined;
  let lastSequence = -1n;
  let stopping: Deferred.Deferred<ProjectTeamTurnObserverStopReceipt> | undefined;
  let stopObserved = false;

  const close = (cause: Cause.Cause<ProjectTeamTurnObserverError>) => {
    closed ??= cause;
    const owned = [...pending.values()];
    for (const entry of owned) {
      Deferred.doneUnsafe(entry.completed, Effect.failCause(closed));
      entry.cancel?.();
    }
  };
  const consume = Effect.forever(
    Effect.gen(function* () {
      const publication = yield* PubSub.take(subscription);
      yield* Effect.suspend(() => {
        const { sequence, event } = publication;
        if (typeof sequence !== "bigint" || sequence < 0n || sequence <= lastSequence) {
          return Effect.fail(new ProjectTeamTurnObserverError({ code: "invalid-sequence" }));
        }
        lastSequence = sequence;
        if (event.type !== "turn.completed" || closed !== undefined) return Effect.void;
        for (const entry of pending.values()) {
          if (
            sequence > entry.afterSequence &&
            event.providerInstanceId === entry.identity.providerInstanceId &&
            event.threadId === entry.identity.threadId &&
            event.turnId === entry.identity.turnId
          ) {
            Deferred.doneUnsafe(
              entry.completed,
              Effect.succeed(
                Object.freeze({
                  ...event,
                  payload: Object.freeze({ ...event.payload }),
                }),
              ),
            );
            break;
          }
        }
        return Effect.void;
      });
    }),
  ).pipe(
    Effect.onExit((exit) => Scope.close(subscriptionScope, exit)),
    Effect.onExit((exit) =>
      Effect.sync(() => {
        close(
          Exit.isFailure(exit)
            ? exit.cause
            : Cause.fail(new ProjectTeamTurnObserverError({ code: "stopped" })),
        );
      }),
    ),
  );
  const consumer = yield* Effect.forkIn(consume, rootScope);

  const joinStop = Effect.uninterruptible(
    Effect.suspend(() => {
      if (stopping !== undefined) return Deferred.await(stopping);
      // Allocate and publish the shared stop waiter without an intervening Effect yield.
      const result = (stopping = Deferred.makeUnsafe<ProjectTeamTurnObserverStopReceipt>());
      const owned = [...pending.values()];
      close(Cause.fail(new ProjectTeamTurnObserverError({ code: "stopped" })));
      return Effect.gen(function* () {
        const observations = yield* Effect.forEach(
          owned,
          (entry) => Deferred.await(entry.join).pipe(Effect.flatMap((join) => join)),
          { concurrency: "unbounded" },
        );
        yield* Fiber.interrupt(consumer);
        const consumerExit = yield* Fiber.await(consumer);
        const subscriptionExit = yield* Effect.exit(Scope.close(subscriptionScope, Exit.void));
        const receipt = Object.freeze({
          consumer: consumerExit,
          observations: Object.freeze(observations),
          subscription: subscriptionExit,
        });
        yield* Deferred.succeed(result, receipt);
        return receipt;
      });
    }),
  );
  const stop = joinStop.pipe(
    // Keep the drain protected, then check pending cancellation before acknowledging delivery.
    Effect.flatMap((receipt) =>
      Effect.interruptible(
        Effect.sync(() => {
          stopObserved = true;
          return receipt;
        }),
      ),
    ),
  );
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() =>
      joinStop.pipe(
        Effect.flatMap((receipt) => {
          if (stopObserved) return Effect.void;
          const reasons = [receipt.consumer, receipt.subscription, ...receipt.observations].flatMap(
            (exit) =>
              Exit.isFailure(exit)
                ? exit.cause.reasons.filter((reason) => !Cause.isInterruptReason(reason))
                : [],
          );
          return reasons.length === 0 ? Effect.void : Effect.die(Cause.fromReasons(reasons));
        }),
      ),
    ),
  );

  const withObservation = <A, E, R>(
    identity: ProjectTeamTurnIdentity,
    send: Effect.Effect<A, E, R>,
  ): Effect.Effect<
    {
      readonly sent: A;
      readonly event: ProviderRuntimeTurnCompletedEvent;
    },
    E | ProjectTeamTurnObserverError,
    R | Scope.Scope
  > => {
    const ownedIdentity = Object.freeze({
      providerInstanceId: identity.providerInstanceId,
      threadId: identity.threadId,
      turnId: identity.turnId,
    });
    const key = JSON.stringify([
      ownedIdentity.providerInstanceId,
      ownedIdentity.threadId,
      ownedIdentity.turnId,
    ]);
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const callerScope = yield* Effect.scope;
        const entry = yield* Effect.suspend(() => {
          if (closed !== undefined) return Effect.failCause(closed);
          if (pending.has(key))
            return Effect.fail(new ProjectTeamTurnObserverError({ code: "duplicate" }));
          if (pending.size >= maximumPending)
            return Effect.fail(new ProjectTeamTurnObserverError({ code: "capacity" }));
          const afterSequence = currentPublicationSequence();
          if (typeof afterSequence !== "bigint" || afterSequence < 0n) {
            return Effect.fail(new ProjectTeamTurnObserverError({ code: "invalid-sequence" }));
          }
          const registered: Pending = {
            identity: ownedIdentity,
            afterSequence,
            completed: Deferred.makeUnsafe(),
            join: Deferred.makeUnsafe(),
          };
          pending.set(key, registered);
          return Effect.succeed(registered);
        });
        const observationScope = yield* Scope.fork(callerScope);
        const operation = yield* Effect.forkIn(
          restore(
            Effect.gen(function* () {
              yield* Effect.suspend(() =>
                closed === undefined ? Effect.void : Effect.failCause(closed),
              );
              const sent = yield* send.pipe(Effect.provideContext(rootContext));
              const event = yield* Deferred.await(entry.completed);
              return Object.freeze({ sent, event });
            }),
          ),
          observationScope,
        );
        yield* Effect.sync(() => {
          entry.cancel = () => operation.interruptUnsafe();
          Deferred.doneUnsafe(
            entry.join,
            Effect.succeed(Fiber.interrupt(operation).pipe(Effect.andThen(Fiber.await(operation)))),
          );
          if (closed !== undefined) entry.cancel();
        });
        const awaited = yield* restore(Fiber.await(operation)).pipe(Effect.exit);
        yield* Fiber.interrupt(operation);
        const joined = yield* Fiber.await(operation);
        const scopeExit = yield* Effect.exit(Scope.close(observationScope, Exit.void));
        pending.delete(key);
        // Assemble original reason occurrences after joining; finalizer Cause.combine deduplicates them.
        const reasons: Cause.Reason<E | ProjectTeamTurnObserverError>[] = [];
        if (Exit.isFailure(awaited)) reasons.push(...awaited.cause.reasons);
        if (Exit.isFailure(joined)) reasons.push(...joined.cause.reasons);
        if (Exit.isFailure(scopeExit)) reasons.push(...scopeExit.cause.reasons);
        if (closed !== undefined)
          reasons.push(...closed.reasons.filter((reason) => !reasons.includes(reason)));
        if (reasons.length > 0) return yield* Effect.failCause(Cause.fromReasons(reasons));
        if (Exit.isFailure(joined)) return yield* Effect.failCause(joined.cause);
        return joined.value;
      }),
    );
  };
  return Object.freeze({ withObservation, stop });
}, Effect.uninterruptible);
