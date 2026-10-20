import type { CompactCallerHandlers, CompactCallerRequest } from "./ProjectTeamCompactCaller.ts";
import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import {
  PiManagedRuntimeError,
  type PiManagedRuntimeInstance,
  type PiManagedOperationRequest,
} from "../provider/pi/PiManagedRuntime.ts";
import type {
  PiProductionRuntimeAssets,
  PiProductionRuntimeHooks,
} from "../provider/pi/PiProductionRuntime.ts";

const denied = () =>
  new PiManagedRuntimeError({ code: "denied", detail: "Pi instance ownership changed" });

/** Root borrows the driver's actual scoped instance; this service grants no task authority. */
export const makeProjectTeamPiRuntime = Effect.fn("makeProjectTeamPiRuntime")(function* () {
  // Wakes are disposable hints; startup discovery reads the durable dispatch journal.
  const changes = yield* PubSub.sliding<ProviderInstanceId>(128);
  const subscribeChanges = PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription));
  const instances = yield* Effect.sync(
    () =>
      new Map<
        ProviderInstanceId,
        { readonly runtime: PiManagedRuntimeInstance; readonly assets: PiProductionRuntimeAssets }
      >(),
  );
  type Resolver = NonNullable<PiProductionRuntimeHooks["resolveOperationId"]>;
  let resolver: { readonly resolve: Resolver } | undefined;
  const installOperationResolver = (resolve: Resolver) =>
    Effect.acquireRelease(
      Effect.suspend(() => {
        if (resolver !== undefined) return Effect.fail(denied());
        const owned = Object.freeze({ resolve });
        resolver = owned;
        return Effect.succeed(owned);
      }),
      (owned) =>
        Effect.sync(() => {
          if (resolver === owned) resolver = undefined;
        }),
    ).pipe(Effect.asVoid);
  let compactionHandlers: CompactCallerHandlers | undefined;
  const installCompactionHandlers = (callbacks: CompactCallerHandlers) =>
    Effect.acquireRelease(
      Effect.suspend(() => {
        if (compactionHandlers !== undefined) return Effect.fail(denied());
        const owned = Object.freeze({ ...callbacks });
        compactionHandlers = owned;
        return Effect.succeed(owned);
      }),
      (owned) =>
        Effect.sync(() => {
          if (compactionHandlers === owned) compactionHandlers = undefined;
        }),
    ).pipe(Effect.asVoid);
  // Reservation waits must never borrow runtime assets: the adapter may still be
  // draining the predecessor or replacing this instance while the caller is idle.
  const callCompaction = <A>(
    instanceId: ProviderInstanceId,
    request: CompactCallerRequest,
    select: (
      handlers: CompactCallerHandlers,
    ) => (
      instanceId: ProviderInstanceId,
      request: CompactCallerRequest,
    ) => Effect.Effect<A, PiManagedRuntimeError>,
  ) =>
    Effect.suspend(() => {
      const owned = compactionHandlers;
      if (!owned) return Effect.fail(denied());
      return select(owned)(instanceId, request).pipe(
        Effect.tap(() =>
          Effect.suspend(() =>
            compactionHandlers === owned ? Effect.void : Effect.fail(denied()),
          ),
        ),
      );
    });
  const compaction: CompactCallerHandlers = {
    reserveCompaction: (instanceId, request) =>
      callCompaction(instanceId, request, (handlers) => handlers.reserveCompaction),
    assertCompactionReady: (instanceId, request) =>
      callCompaction(instanceId, request, (handlers) => handlers.assertCompactionReady),
    abandonCompaction: (instanceId, request) =>
      callCompaction(instanceId, request, (handlers) => handlers.abandonCompaction),
  };
  const publishAssets: NonNullable<PiProductionRuntimeHooks["publishAssets"]> = (
    instanceId,
    assets,
    runtime,
  ) =>
    Effect.suspend(() => {
      const entry = Object.freeze({ runtime, assets });
      return Effect.acquireRelease(
        Effect.sync(() => {
          instances.set(instanceId, entry);
          return entry;
        }).pipe(Effect.tap(() => PubSub.publish(changes, instanceId))),
        () =>
          Effect.sync(() => {
            if (instances.get(instanceId) === entry) instances.delete(instanceId);
          }).pipe(Effect.andThen(PubSub.publish(changes, instanceId))),
      ).pipe(Effect.asVoid);
    });
  const withInstance = <A, E, R>(
    instanceId: ProviderInstanceId,
    run: (instance: {
      readonly runtime: PiManagedRuntimeInstance;
      readonly assets: PiProductionRuntimeAssets;
      readonly assertCurrent: Effect.Effect<void, PiManagedRuntimeError>;
    }) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | PiManagedRuntimeError, R> =>
    Effect.suspend(() => {
      const entry = instances.get(instanceId);
      if (!entry) return Effect.fail(denied());
      const assertCurrent = Effect.suspend(() =>
        instances.get(instanceId) === entry ? Effect.void : Effect.fail(denied()),
      );
      return entry.assets.borrow(
        assertCurrent.pipe(
          Effect.andThen(Effect.suspend(() => run(Object.freeze({ ...entry, assertCurrent })))),
          Effect.tap(() => assertCurrent),
        ),
      );
    });
  const resolveOperationId: Resolver = (instanceId, request: PiManagedOperationRequest) =>
    withInstance(instanceId, () =>
      Effect.suspend(() => {
        const owned = resolver;
        if (owned === undefined) return Effect.succeed(undefined);
        return owned
          .resolve(instanceId, request)
          .pipe(
            Effect.tap(() =>
              Effect.suspend(() => (resolver === owned ? Effect.void : Effect.fail(denied()))),
            ),
          );
      }),
    );
  return {
    installCompactionHandlers,
    ...compaction,
    publishAssets,
    withInstance,
    installOperationResolver,
    resolveOperationId,
    subscribeChanges,
  };
});

export class ProjectTeamPiRuntime extends Context.Service<
  ProjectTeamPiRuntime,
  Effect.Success<ReturnType<typeof makeProjectTeamPiRuntime>>
>()("t3/projectWork/ProjectTeamPiRuntime") {}
