import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import {
  PiManagedRuntimeError,
  type PiManagedRuntimeInstance,
} from "../provider/pi/PiManagedRuntime.ts";
import type {
  PiProductionRuntimeAssets,
  PiProductionRuntimeHooks,
} from "../provider/pi/PiProductionRuntime.ts";

const denied = () =>
  new PiManagedRuntimeError({ code: "denied", detail: "Pi instance ownership changed" });

/** Root borrows the driver's actual scoped instance; this service grants no task authority. */
export const makeProjectTeamPiRuntime = Effect.fn("makeProjectTeamPiRuntime")(function* () {
  const instances = yield* Effect.sync(
    () =>
      new Map<
        ProviderInstanceId,
        { readonly runtime: PiManagedRuntimeInstance; readonly assets: PiProductionRuntimeAssets }
      >(),
  );
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
        }),
        () =>
          Effect.sync(() => {
            if (instances.get(instanceId) === entry) instances.delete(instanceId);
          }),
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
  return { publishAssets, withInstance };
});

export class ProjectTeamPiRuntime extends Context.Service<
  ProjectTeamPiRuntime,
  Effect.Success<ReturnType<typeof makeProjectTeamPiRuntime>>
>()("t3/projectWork/ProjectTeamPiRuntime") {}
