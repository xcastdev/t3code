import type { ProviderInstanceId, ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { ProviderValidationError } from "./Errors.ts";
import type { ProviderServiceShape } from "./Services/ProviderService.ts";

export interface ProviderTurnPublication {
  readonly sequence: bigint;
  readonly event: ProviderRuntimeEvent;
}

export interface ProviderTurnPublicationSource {
  readonly subscribe: Effect.Effect<
    PubSub.Subscription<ProviderTurnPublication>,
    ProviderValidationError,
    Scope.Scope
  >;
  readonly currentPublicationSequence: () => bigint;
  readonly ended: Effect.Effect<Exit.Exit<void, unknown>>;
  readonly assertCurrent: Effect.Effect<void, ProviderValidationError>;
}

type Acquire = (
  instanceId: ProviderInstanceId,
) => Effect.Effect<ProviderTurnPublicationSource, ProviderValidationError, Scope.Scope>;
const registered = new WeakMap<ProviderServiceShape, Acquire>();
type EventSubscription = Effect.Effect<
  PubSub.Subscription<ProviderRuntimeEvent>,
  never,
  Scope.Scope
>;
const eventSubscriptions = new WeakMap<object, EventSubscription>();

/** Retain the actual adapter's eager event subscription without changing its public shape. */
export const registerProviderTurnEventSubscription = (
  adapter: object,
  subscribe: EventSubscription,
) => {
  eventSubscriptions.set(adapter, subscribe);
};
export const getProviderTurnEventSubscription = (adapter: object) =>
  eventSubscriptions.get(adapter);
const denied = (message: string) =>
  new ProviderValidationError({ operation: "ProviderService.turnPublications", issue: message });

interface PublicationOwner {
  readonly identity: object;
  readonly instanceId: ProviderInstanceId;
  readonly driver: string;
  readonly ended: Deferred.Deferred<Exit.Exit<void, unknown>>;
  exit: Exit.Exit<void, unknown> | undefined;
}

/** Acquire a factory-owned subscription before registering or sending managed work. */
export const acquireProviderTurnPublications = Effect.fn("acquireProviderTurnPublications")(
  function* (service: ProviderServiceShape, instanceId: ProviderInstanceId) {
    const acquire = registered.get(service);
    if (!acquire) return yield* denied("This provider service has no owned publication source");
    return yield* acquire(instanceId);
  },
);

/** Private factory bridge. Publication hints confer no execution or settlement authority. */
export const makeProviderTurnPublications = Effect.fn("makeProviderTurnPublications")(function* () {
  const loans = new Set<{
    readonly source: object;
    readonly publish: (
      event: ProviderRuntimeEvent,
      canonical: Effect.Effect<void>,
    ) => Effect.Effect<void>;
    readonly close: Effect.Effect<void>;
    readonly fail: (exit: Exit.Exit<void, unknown>) => Effect.Effect<void>;
  }>();
  const sources = new WeakMap<object, PublicationOwner>();
  const eventSources = new WeakMap<ProviderRuntimeEvent, object>();
  let factoryActive = true;
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      factoryActive = false;
      for (const loan of Array.from(loans)) yield* loan.close;
    }),
  );
  const bind = (
    service: ProviderServiceShape,
    resolve: (id: ProviderInstanceId) => Effect.Effect<object, ProviderValidationError>,
  ) => {
    const acquire: Acquire = Effect.fn("ProviderService.acquireTurnPublications")(
      function* (instanceId) {
        const adapter = yield* resolve(instanceId);
        const record = sources.get(adapter);
        if (
          !factoryActive ||
          !record ||
          record.instanceId !== instanceId ||
          record.driver !== "piAgent" ||
          record.exit !== undefined
        )
          return yield* denied("The original Pi publication owner is unavailable");
        const bus = yield* PubSub.bounded<ProviderTurnPublication>(128);
        const permit = yield* Semaphore.make(1);
        const ended = yield* Deferred.make<Exit.Exit<void, unknown>>();
        let active = true;
        let sequence = 0n;
        let inFlight: Deferred.Deferred<void> | undefined;
        const assertCurrent = Effect.gen(function* () {
          const current = yield* resolve(instanceId);
          if (
            !factoryActive ||
            !active ||
            record.exit !== undefined ||
            current !== adapter ||
            sources.get(current) !== record
          )
            return yield* denied("The original publication loan has ended");
        });
        const close = Effect.uninterruptible(
          Effect.gen(function* () {
            active = false;
            loans.delete(loan);
            yield* Deferred.succeed(ended, Exit.fail(denied("The publication loan was closed")));
            yield* PubSub.shutdown(bus);
            if (inFlight) yield* Deferred.await(inFlight);
          }),
        );
        const fail = (exit: Exit.Exit<void, unknown>) =>
          Deferred.succeed(ended, exit).pipe(Effect.asVoid);
        const publish = (event: ProviderRuntimeEvent, canonical: Effect.Effect<void>) =>
          permit.withPermit(
            Effect.suspend(() => {
              if (!active || !factoryActive) return canonical;
              const joined = Deferred.makeUnsafe<void>();
              inFlight = joined;
              const publication = { sequence: ++sequence, event };
              const accepted = PubSub.publishUnsafe(bus, publication);
              return canonical.pipe(
                Effect.andThen(
                  accepted
                    ? Effect.void
                    : PubSub.publish(bus, publication).pipe(
                        Effect.catchCause((cause) =>
                          !active && Cause.hasInterruptsOnly(cause)
                            ? Effect.void
                            : Effect.failCause(cause),
                        ),
                        Effect.asVoid,
                      ),
                ),
                Effect.onExit((exit) => (Exit.isFailure(exit) ? fail(exit) : Effect.void)),
                Effect.ensuring(
                  Effect.sync(() => {
                    inFlight = undefined;
                    Deferred.doneUnsafe(joined, Effect.void);
                  }),
                ),
              );
            }),
          );
        const loan = { source: record.identity, publish, close, fail };
        yield* Effect.acquireRelease(
          Effect.suspend(() => {
            if (
              !factoryActive ||
              record.exit !== undefined ||
              loans.size >= 2 ||
              [...loans].some((candidate) => candidate.source === record.identity)
            )
              return Effect.fail(
                denied("Publication ownership is unavailable or already borrowed"),
              );
            loans.add(loan);
            return Effect.succeed(loan);
          }),
          () => close,
        );
        yield* assertCurrent;
        let subscribed = false;
        const subscribe = Effect.suspend(() => {
          if (!active || subscribed)
            return Effect.fail(denied("The owned publication subscription is unavailable"));
          subscribed = true;
          return PubSub.subscribe(bus).pipe(
            Effect.tap(() => Effect.addFinalizer(() => close)),
            Effect.tap(() => assertCurrent),
          );
        });
        return {
          subscribe,
          currentPublicationSequence: () => sequence,
          ended: Effect.raceFirst(Deferred.await(ended), Deferred.await(record.ended)),
          assertCurrent,
        };
      },
    );
    registered.set(service, acquire);
  };
  const source = Effect.fn("ProviderService.registerPublicationOwner")(function* (
    identity: object,
    adapter: object,
    instanceId: ProviderInstanceId,
    driver: string,
  ) {
    const ended = yield* Deferred.make<Exit.Exit<void, unknown>>();
    const record: PublicationOwner = { identity, instanceId, driver, ended, exit: undefined };
    sources.set(adapter, record);
    return (exit: Exit.Exit<void, unknown>) =>
      Effect.gen(function* () {
        record.exit = exit;
        yield* Deferred.succeed(ended, exit);
        for (const loan of Array.from(loans))
          if (loan.source === identity) {
            yield* loan.fail(exit);
            yield* loan.close;
          }
      });
  });
  const remember = (event: ProviderRuntimeEvent, adapter: object) =>
    eventSources.set(event, adapter);
  const inherit = (original: ProviderRuntimeEvent, event: ProviderRuntimeEvent) => {
    const adapter = eventSources.get(original);
    if (adapter) remember(event, adapter);
    return event;
  };
  const publish = (event: ProviderRuntimeEvent, canonical: Effect.Effect<void>) => {
    if (event.type !== "turn.completed" && event.type !== "turn.aborted") return canonical;
    const adapter = eventSources.get(event);
    const loan = [...loans].find((candidate) => candidate.source === adapter);
    return loan ? loan.publish(event, canonical) : canonical;
  };
  return { bind, source, remember, inherit, publish };
});
