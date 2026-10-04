import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import {
  PiManagedRuntimeError,
  type PiManagedOperationRequest,
  type PiManagedRuntimeInstance,
} from "../provider/pi/PiManagedRuntime.ts";
import type { PiProductionRuntimeAssets } from "../provider/pi/PiProductionRuntime.ts";
import { makeProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";

const instanceId = ProviderInstanceId.make("pi_registry");
const request: PiManagedOperationRequest = {
  kind: "initialize",
  threadId: ThreadId.make("registry-thread"),
};
const unused = () => Effect.die("Controlled registry fixture cannot execute Pi operations");
const makeRuntime = () =>
  ({
    inspect: unused(),
    prepareOperation: unused,
    readSession: unused,
    readThread: unused,
    requestStop: unused,
    stopAll: unused(),
    authorizeSkills: unused,
    discoverNativeSkills: unused,
  }) satisfies PiManagedRuntimeInstance;

// Count loans with real Effect finalizers; these assets have no native files or process lifetime.
const makeAssets = () => {
  let acquired = 0;
  let released = 0;
  let active = 0;
  const assets: PiProductionRuntimeAssets = {
    runtimeFiles: [],
    revalidate: Effect.void,
    borrow: (operation) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          acquired++;
          active++;
        }),
        () => operation,
        () =>
          Effect.sync(() => {
            released++;
            active--;
          }),
      ),
  };
  return { assets, loans: () => ({ acquired, released, active }) };
};
const ownedScope = Effect.gen(function* () {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  return scope;
});
const fixture = Effect.gen(function* () {
  const registry = yield* makeProjectTeamPiRuntime();
  const driverScope = yield* ownedScope;
  const runtime = makeRuntime();
  const assets = makeAssets();
  yield* registry
    .publishAssets(instanceId, assets.assets, runtime)
    .pipe(Effect.provideService(Scope.Scope, driverScope));
  return { registry, driverScope, runtime, ...assets };
});
const barrier = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const wait = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
  return { entered, release, wait };
});
const expectDenied = Effect.fn("registryTest.expectDenied")(function* <A, E, R>(
  operation: Effect.Effect<A, E, R>,
) {
  const result = yield* Effect.result(operation);
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    expect(result.failure).toBeInstanceOf(PiManagedRuntimeError);
    if (result.failure instanceof PiManagedRuntimeError) expect(result.failure.code).toBe("denied");
  }
});

it.effect("rejects a second resolver without displacing the first or its lifetime", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { registry, loans } = yield* fixture;
      const firstScope = yield* ownedScope;
      const rejectedScope = yield* ownedScope;
      const replacementScope = yield* ownedScope;
      yield* registry
        .installOperationResolver(() => Effect.succeed("first-operation"))
        .pipe(Effect.provideService(Scope.Scope, firstScope));
      yield* expectDenied(
        registry
          .installOperationResolver(() => Effect.succeed("rejected-operation"))
          .pipe(Effect.provideService(Scope.Scope, rejectedScope)),
      );
      yield* Scope.close(rejectedScope, Exit.void);
      expect(yield* registry.resolveOperationId(instanceId, request)).toBe("first-operation");
      yield* Scope.close(firstScope, Exit.void);
      expect(yield* registry.resolveOperationId(instanceId, request)).toBeUndefined();
      yield* registry
        .installOperationResolver(() => Effect.succeed("replacement-operation"))
        .pipe(Effect.provideService(Scope.Scope, replacementScope));
      expect(yield* registry.resolveOperationId(instanceId, request)).toBe("replacement-operation");
      expect(loans()).toEqual({ acquired: 3, released: 3, active: 0 });
    }),
  ),
);

it.effect(
  "denies a retained lookup after its resolver scope closes and a new resolver installs",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, loans } = yield* fixture;
        const firstScope = yield* ownedScope;
        const secondScope = yield* ownedScope;
        const paused = yield* barrier;
        yield* registry
          .installOperationResolver(() => paused.wait.pipe(Effect.as("old-operation")))
          .pipe(Effect.provideService(Scope.Scope, firstScope));
        const pending = yield* registry
          .resolveOperationId(instanceId, request)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(paused.entered);
        expect(loans()).toEqual({ acquired: 1, released: 0, active: 1 });
        yield* Scope.close(firstScope, Exit.void);
        yield* registry
          .installOperationResolver(() => Effect.succeed("new-operation"))
          .pipe(Effect.provideService(Scope.Scope, secondScope));
        yield* Deferred.succeed(paused.release, undefined);
        yield* expectDenied(Fiber.join(pending));
        expect(yield* registry.resolveOperationId(instanceId, request)).toBe("new-operation");
        expect(loans()).toEqual({ acquired: 2, released: 2, active: 0 });
      }),
    ),
);

it.effect(
  "denies the old lookup when the same resolver callback is installed in a newer scope",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, loans } = yield* fixture;
        const firstScope = yield* ownedScope;
        const secondScope = yield* ownedScope;
        const paused = yield* barrier;
        const resolve = () => paused.wait.pipe(Effect.as("retained-operation"));
        yield* registry
          .installOperationResolver(resolve)
          .pipe(Effect.provideService(Scope.Scope, firstScope));
        const pending = yield* registry
          .resolveOperationId(instanceId, request)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(paused.entered);
        yield* Scope.close(firstScope, Exit.void);
        yield* registry
          .installOperationResolver(resolve)
          .pipe(Effect.provideService(Scope.Scope, secondScope));
        yield* Deferred.succeed(paused.release, undefined);
        yield* expectDenied(Fiber.join(pending));
        expect(yield* registry.resolveOperationId(instanceId, request)).toBe("retained-operation");
        expect(loans()).toEqual({ acquired: 2, released: 2, active: 0 });
      }),
    ),
);

it.effect("denies an in-flight lookup when its resolver closes without replacement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { registry, loans } = yield* fixture;
      const resolverScope = yield* ownedScope;
      const paused = yield* barrier;
      yield* registry
        .installOperationResolver(() => paused.wait.pipe(Effect.as("old-operation")))
        .pipe(Effect.provideService(Scope.Scope, resolverScope));
      const pending = yield* registry
        .resolveOperationId(instanceId, request)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(paused.entered);
      yield* Scope.close(resolverScope, Exit.void);
      yield* Deferred.succeed(paused.release, undefined);
      yield* expectDenied(Fiber.join(pending));
      expect(yield* registry.resolveOperationId(instanceId, request)).toBeUndefined();
      expect(loans()).toEqual({ acquired: 2, released: 2, active: 0 });
    }),
  ),
);

it.effect(
  "denies the old lookup after replacement and preserves the newer published instance",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = yield* fixture;
        const resolverScope = yield* ownedScope;
        const nextScope = yield* ownedScope;
        const nextRuntime = makeRuntime();
        const nextAssets = makeAssets();
        const paused = yield* barrier;
        yield* first.registry
          .installOperationResolver(() => paused.wait.pipe(Effect.as("retained-operation")))
          .pipe(Effect.provideService(Scope.Scope, resolverScope));
        const pending = yield* first.registry
          .resolveOperationId(instanceId, request)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(paused.entered);
        yield* first.registry
          .publishAssets(instanceId, nextAssets.assets, nextRuntime)
          .pipe(Effect.provideService(Scope.Scope, nextScope));
        yield* Scope.close(first.driverScope, Exit.void);
        yield* first.registry.withInstance(instanceId, ({ runtime }) =>
          Effect.sync(() => {
            expect(runtime).toBe(nextRuntime);
            expect(first.loans().active).toBe(1);
            expect(nextAssets.loans().active).toBe(1);
          }),
        );
        yield* Deferred.succeed(paused.release, undefined);
        yield* expectDenied(Fiber.join(pending));
        expect(yield* first.registry.resolveOperationId(instanceId, request)).toBe(
          "retained-operation",
        );
        expect(first.loans()).toEqual({ acquired: 1, released: 1, active: 0 });
        expect(nextAssets.loans()).toEqual({ acquired: 2, released: 2, active: 0 });
        yield* Scope.close(nextScope, Exit.void);
        yield* expectDenied(first.registry.resolveOperationId(instanceId, request));
      }),
    ),
);

it.effect("denies a lookup completing after its published driver scope closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { registry, driverScope, loans } = yield* fixture;
      const resolverScope = yield* ownedScope;
      const paused = yield* barrier;
      yield* registry
        .installOperationResolver(() => paused.wait.pipe(Effect.as("retained-operation")))
        .pipe(Effect.provideService(Scope.Scope, resolverScope));
      const pending = yield* registry
        .resolveOperationId(instanceId, request)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(paused.entered);
      yield* Scope.close(driverScope, Exit.void);
      yield* Deferred.succeed(paused.release, undefined);
      yield* expectDenied(Fiber.join(pending));
      expect(loans()).toEqual({ acquired: 1, released: 1, active: 0 });
    }),
  ),
);

it.effect("rejects missing and closed instances before invoking read callbacks", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { registry, driverScope, loans } = yield* fixture;
      let reads = 0;
      const read = () => Effect.sync(() => reads++);
      yield* expectDenied(registry.withInstance(ProviderInstanceId.make("missing"), read));
      yield* Scope.close(driverScope, Exit.void);
      yield* expectDenied(registry.withInstance(instanceId, read));
      yield* expectDenied(registry.resolveOperationId(instanceId, request));
      expect(reads).toBe(0);
      expect(loans()).toEqual({ acquired: 0, released: 0, active: 0 });
    }),
  ),
);

it.effect("returns undefined for ordinary Pi while borrowing the current registered assets", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const current = yield* fixture;
      expect(yield* current.registry.resolveOperationId(instanceId, request)).toBeUndefined();
      expect(current.loans()).toEqual({ acquired: 1, released: 1, active: 0 });
      yield* current.registry.withInstance(instanceId, ({ runtime, assets, assertCurrent }) =>
        assertCurrent.pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(runtime).toBe(current.runtime);
              expect(assets).toBe(current.assets);
              expect(current.loans()).toEqual({ acquired: 2, released: 1, active: 1 });
            }),
          ),
        ),
      );
      expect(current.loans()).toEqual({ acquired: 2, released: 2, active: 0 });
    }),
  ),
);

it.effect("preserves resolver and read callback failures while releasing each borrow", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { registry, loans } = yield* fixture;
      const resolverScope = yield* ownedScope;
      const failure = new PiManagedRuntimeError({ code: "unavailable", detail: "fixture failure" });
      yield* registry
        .installOperationResolver(() => Effect.fail(failure))
        .pipe(Effect.provideService(Scope.Scope, resolverScope));
      const resolved = yield* registry.resolveOperationId(instanceId, request).pipe(Effect.result);
      const read = yield* registry
        .withInstance(instanceId, () => Effect.fail(failure))
        .pipe(Effect.result);
      expect(resolved._tag).toBe("Failure");
      expect(read._tag).toBe("Failure");
      if (resolved._tag === "Failure") expect(resolved.failure).toBe(failure);
      if (read._tag === "Failure") expect(read.failure).toBe(failure);
      expect(loans()).toEqual({ acquired: 2, released: 2, active: 0 });
    }),
  ),
);

it.effect("releases an active callback borrow when its caller scope closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { registry, loans } = yield* fixture;
      const callerScope = yield* ownedScope;
      const entered = yield* Deferred.make<void>();
      const pending = yield* registry
        .withInstance(instanceId, () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkScoped, Effect.provideService(Scope.Scope, callerScope));
      yield* Deferred.await(entered);
      expect(loans()).toEqual({ acquired: 1, released: 0, active: 1 });
      yield* Scope.close(callerScope, Exit.void);
      const exit = yield* Fiber.await(pending);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(loans()).toEqual({ acquired: 1, released: 1, active: 0 });
      expect(yield* registry.resolveOperationId(instanceId, request)).toBeUndefined();
    }),
  ),
);

it.effect(
  "releases a cancelled lookup borrow without removing its published owner or resolver",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, loans } = yield* fixture;
        const resolverScope = yield* ownedScope;
        const paused = yield* barrier;
        yield* registry
          .installOperationResolver(() => paused.wait.pipe(Effect.as("retained-operation")))
          .pipe(Effect.provideService(Scope.Scope, resolverScope));
        const pending = yield* registry
          .resolveOperationId(instanceId, request)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(paused.entered);
        expect(loans()).toEqual({ acquired: 1, released: 0, active: 1 });
        yield* Fiber.interrupt(pending);
        const exit = yield* Fiber.await(pending);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(loans()).toEqual({ acquired: 1, released: 1, active: 0 });
        yield* Deferred.succeed(paused.release, undefined);
        expect(yield* registry.resolveOperationId(instanceId, request)).toBe("retained-operation");
        expect(loans()).toEqual({ acquired: 2, released: 2, active: 0 });
      }),
    ),
);
