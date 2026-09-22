// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";
import type * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ManagedSkillContent, ManagedSkillKey } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ManagedSkillRepository from "./ManagedSkillRepository.ts";
import * as SkillCatalogIndex from "./SkillCatalogIndex.ts";
import * as SkillWatchService from "./SkillWatchService.ts";

type NativeWatch = (
  filename: NodeFS.PathLike,
  options: NodeFS.WatchOptionsWithStringEncoding | BufferEncoding | null,
  listener: NodeFS.WatchListener<string>,
) => NodeFS.FSWatcher;

const nativeWatchInterceptor = vi.hoisted(() => ({
  factory: undefined as NativeWatch | undefined,
}));
const refSetInterceptor = vi.hoisted(() => ({
  armed: false,
  fired: false,
  interrupt: undefined as (() => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: (...args: Parameters<NativeWatch>) =>
      nativeWatchInterceptor.factory === undefined
        ? actual.watch(...args)
        : nativeWatchInterceptor.factory(...args),
  };
});

vi.mock("effect/Ref", async (importOriginal) => {
  const actual = await importOriginal<typeof import("effect/Ref")>();
  return {
    ...actual,
    set: <A>(ref: Ref.Ref<A>, value: A) =>
      actual.set(ref, value).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (refSetInterceptor.armed && value instanceof Map && value.size === 0) {
              refSetInterceptor.armed = false;
              refSetInterceptor.fired = true;
              refSetInterceptor.interrupt?.();
            }
          }),
        ),
      ),
  };
});

afterEach(() => {
  nativeWatchInterceptor.factory = undefined;
  refSetInterceptor.armed = false;
  refSetInterceptor.fired = false;
  refSetInterceptor.interrupt = undefined;
});

const content = (key: string, body: string): ManagedSkillContent => ({
  key: key as ManagedSkillKey,
  name: `Skill ${key}`,
  body,
});

const BaseLayer = ManagedSkillRepository.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-skill-watch-" })),
  Layer.provideMerge(NodeServices.layer),
);

describe("SkillWatchService", () => {
  it.layer(Layer.merge(BaseLayer, TestClock.layer()))("watch lifecycle", (it) => {
    for (const boundary of ["setup", "reconciliation"] as const) {
      it.effect(
        `closes the global child scope when construction is interrupted during ${boundary}`,
        () =>
          Effect.gen(function* () {
            const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
            const setupEntered = yield* Deferred.make<void>();
            const setupGate = yield* Deferred.make<void>();
            const reconciliationEntered = yield* Deferred.make<void>();
            const reconciliationGate = yield* Deferred.make<void>();
            let scans = 0;
            let opened = 0;
            let closed = 0;
            const controlled = ManagedSkillRepository.ManagedSkillRepository.of({
              ...repository,
              listGlobal: () =>
                Effect.gen(function* () {
                  scans += 1;
                  if (boundary === "reconciliation" && scans === 2) {
                    yield* Deferred.succeed(reconciliationEntered, undefined).pipe(Effect.ignore);
                    yield* Deferred.await(reconciliationGate);
                  }
                  return yield* repository.listGlobal();
                }),
            });
            const scope = yield* Scope.make();
            const index = yield* SkillCatalogIndex.make.pipe(
              Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
            );
            const construction = yield* SkillWatchService.makeWith({
              acquireWatch: () =>
                Effect.gen(function* () {
                  opened += 1;
                  yield* Effect.addFinalizer(() => Effect.sync(() => void (closed += 1)));
                  yield* Deferred.succeed(setupEntered, undefined).pipe(Effect.ignore);
                  if (boundary === "setup") yield* Deferred.await(setupGate);
                  return { events: Stream.never };
                }),
            }).pipe(
              Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
              Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
              Effect.provideService(Scope.Scope, scope),
              Effect.forkChild,
            );
            yield* Deferred.await(boundary === "setup" ? setupEntered : reconciliationEntered);
            yield* Fiber.interrupt(construction);
            yield* Scope.close(scope, Exit.void);
            assert.equal(opened, 1);
            assert.equal(closed, 1);
          }),
      );
    }

    it.effect("closes the actual native handle when interruption wins the acquisition return", () =>
      Effect.gen(function* () {
        let opened = 0;
        let closed = 0;
        let interrupt: (() => void) | undefined;
        nativeWatchInterceptor.factory = () => {
          opened += 1;
          const watcher = new NodeEvents.EventEmitter() as NodeFS.FSWatcher;
          watcher.close = () => {
            closed += 1;
            watcher.emit("close");
          };
          interrupt?.();
          return watcher;
        };
        const scope = yield* Scope.make();
        const acquisition = yield* Effect.withFiber((fiber) => {
          interrupt = () => fiber.interruptUnsafe();
          return SkillWatchService.acquireNativeWatch("/tmp/t3-native-return");
        }).pipe(Effect.provideService(Scope.Scope, scope), Effect.forkChild);
        const exit = yield* Fiber.await(acquisition);
        yield* Scope.close(scope, Exit.void);
        assert.isTrue(Exit.isFailure(exit));
        assert.equal(opened, 1);
        assert.equal(closed, 1);
      }),
    );

    it.effect("buffers synchronous native callbacks and maps a null filename to the root", () =>
      Effect.gen(function* () {
        let closed = 0;
        nativeWatchInterceptor.factory = (...args) => {
          const callback = args[2] as unknown as (event: string, filename: string | null) => void;
          const watcher = new NodeEvents.EventEmitter() as NodeFS.FSWatcher;
          watcher.close = () => {
            closed += 1;
            watcher.emit("close");
          };
          callback("change", "skills/a");
          callback("rename", null);
          return watcher;
        };
        const scope = yield* Scope.make();
        const acquired = yield* SkillWatchService.acquireNativeWatch("/tmp/t3-native-buffer").pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        const received = yield* acquired.events.pipe(Stream.take(2), Stream.runCollect);
        assert.deepEqual(Array.from(received), [{ path: "skills/a" }, { path: "" }]);
        yield* Scope.close(scope, Exit.void);
        assert.equal(closed, 1);
      }),
    );

    it.effect("returns exact platform metadata when native registration throws", () =>
      Effect.gen(function* () {
        const cause = new Error("registration failed");
        nativeWatchInterceptor.factory = () => {
          throw cause;
        };
        const scope = yield* Scope.make();
        const error = yield* SkillWatchService.acquireNativeWatch("/tmp/t3-native-throw").pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.flip,
        );
        assert.equal(error._tag, "PlatformError");
        assert.instanceOf(error.reason, PlatformError.SystemError);
        assert.equal(error.reason._tag, "Unknown");
        assert.equal(error.reason.module, "FileSystem");
        assert.equal(error.reason.method, "watch");
        assert.equal(error.reason.pathOrDescriptor, "/tmp/t3-native-throw");
        assert.equal(error.cause, cause);
        yield* Scope.close(scope, Exit.void);
      }),
    );

    for (const mode of ["error", "close"] as const) {
      it.effect(`terminates on asynchronous native ${mode} with idempotent close`, () =>
        Effect.gen(function* () {
          let watcher: NodeFS.FSWatcher | undefined;
          let closeCalls = 0;
          nativeWatchInterceptor.factory = () => {
            watcher = new NodeEvents.EventEmitter() as NodeFS.FSWatcher;
            watcher.close = () => {
              closeCalls += 1;
              watcher!.emit("close");
            };
            return watcher;
          };
          const scope = yield* Scope.make();
          const acquired = yield* SkillWatchService.acquireNativeWatch(
            `/tmp/t3-native-${mode}`,
          ).pipe(Effect.provideService(Scope.Scope, scope));
          const consumer = yield* acquired.events.pipe(Stream.runDrain, Effect.forkChild);
          if (mode === "error") watcher!.emit("error", new Error("watch failed"));
          else watcher!.emit("close");
          const exit = yield* Fiber.await(consumer);
          assert.equal(Exit.isFailure(exit), mode === "error");
          yield* Scope.close(scope, Exit.void);
          assert.equal(closeCalls, mode === "error" ? 1 : 0);
        }),
      );
    }

    it.effect("owns cleanup before an interrupted final-release commit can return", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-release-project-" });
        const scope = yield* Scope.make();
        const index = yield* SkillCatalogIndex.make;
        let projectClosed = 0;
        const watches = yield* SkillWatchService.makeWith({
          acquireWatch: (root) =>
            Effect.gen(function* () {
              if (root === projectRoot)
                yield* Effect.addFinalizer(() => Effect.sync(() => void (projectClosed += 1)));
              return { events: Stream.never };
            }),
        }).pipe(
          Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
          Effect.provideService(Scope.Scope, scope),
        );
        yield* watches.acquireProject(projectRoot);
        refSetInterceptor.armed = true;
        const release = yield* Effect.withFiber((fiber) => {
          refSetInterceptor.interrupt = () => fiber.interruptUnsafe();
          return watches.releaseProject(projectRoot);
        }).pipe(Effect.forkChild);
        const releaseExit = yield* Fiber.await(release);
        assert.isTrue(refSetInterceptor.fired);
        assert.isTrue(Exit.isFailure(releaseExit));
        assert.equal(projectClosed, 1);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(index.getProject(projectRoot))));
        yield* Scope.close(scope, Exit.void);
        assert.equal(projectClosed, 1);
      }),
    );

    it.effect(
      "finds a global mutation made after index construction by mandatory reconciliation",
      () =>
        Effect.gen(function* () {
          const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
          const scope = yield* Scope.make();
          const index = yield* SkillCatalogIndex.make;
          yield* repository.createGlobal({
            expectedRevision: 0,
            content: content("late-global", "late"),
          });
          yield* SkillWatchService.makeWith({
            acquireWatch: () => Effect.succeed({ events: Stream.never }),
          }).pipe(
            Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
            Effect.provideService(Scope.Scope, scope),
          );
          assert.deepEqual(
            (yield* index.getGlobal).entries.map((entry) => entry.key),
            ["late-global"],
          );
          yield* Scope.close(scope, Exit.void);
        }),
    );

    it.effect(
      "finds a project mutation after the captured first scan by final reconciliation",
      () =>
        Effect.gen(function* () {
          const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
          const fs = yield* FileSystem.FileSystem;
          const projectRoot = yield* fs.makeTempDirectoryScoped({
            prefix: "t3-project-reconcile-",
          });
          const firstScanCaptured = yield* Deferred.make<void>();
          const releaseFirstScan = yield* Deferred.make<void>();
          let first = true;
          const controlled = ManagedSkillRepository.ManagedSkillRepository.of({
            ...repository,
            listProject: (root) =>
              Effect.gen(function* () {
                const captured = yield* repository.listProject(root);
                if (first) {
                  first = false;
                  yield* Deferred.succeed(firstScanCaptured, undefined).pipe(Effect.ignore);
                  yield* Deferred.await(releaseFirstScan);
                }
                return captured;
              }),
          });
          const scope = yield* Scope.make();
          const index = yield* SkillCatalogIndex.make.pipe(
            Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
          );
          const watches = yield* SkillWatchService.makeWith({
            acquireWatch: () => Effect.succeed({ events: Stream.never }),
          }).pipe(
            Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
            Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
            Effect.provideService(Scope.Scope, scope),
          );
          const acquisition = yield* watches.acquireProject(projectRoot).pipe(Effect.forkChild);
          yield* Deferred.await(firstScanCaptured);
          yield* repository.setProjectOverride({
            projectRoot,
            key: "late-project" as ManagedSkillKey,
            content: { name: "Late project", body: "late" },
          });
          yield* Deferred.succeed(releaseFirstScan, undefined);
          const snapshot = yield* Fiber.join(acquisition);
          assert.deepEqual(
            snapshot.entries.map((entry) => entry.key),
            ["late-project"],
          );
          yield* watches.releaseProject(projectRoot);
          yield* Scope.close(scope, Exit.void);
        }),
    );

    for (const scopeKind of ["global", "project"] as const) {
      it.effect(
        `retains a ${scopeKind} event delivered during stale reconciliation after delayed readiness`,
        () =>
          Effect.gen(function* () {
            const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
            const fs = yield* FileSystem.FileSystem;
            const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ready-project-" });
            const registrationEntered = yield* Deferred.make<void>();
            const allowRegistration = yield* Deferred.make<void>();
            const reconciliationEntered = yield* Deferred.make<void>();
            const allowReconciliation = yield* Deferred.make<void>();
            const refreshComplete = yield* Deferred.make<void>();
            const events = yield* Queue.unbounded<{ readonly path: string }>();
            const inFlightProjectScans = yield* Ref.make(0);
            const maxInFlightProjectScans = yield* Ref.make(0);
            const invalidations =
              yield* PubSub.unbounded<ManagedSkillRepository.ManagedSkillRepositoryInvalidation>();
            let globalScans = 0;
            let projectScans = 0;
            const controlled = ManagedSkillRepository.ManagedSkillRepository.of({
              ...repository,
              subscribeInvalidations: PubSub.subscribe(invalidations),
              listGlobal: () =>
                Effect.gen(function* () {
                  globalScans += 1;
                  const captured = yield* repository.listGlobal();
                  if (scopeKind === "global" && globalScans === 2) {
                    yield* Deferred.succeed(reconciliationEntered, undefined).pipe(Effect.ignore);
                    yield* Deferred.await(allowReconciliation);
                  }
                  return captured;
                }),
              listProject: (root) =>
                Effect.gen(function* () {
                  const active = yield* Ref.updateAndGet(
                    inFlightProjectScans,
                    (value) => value + 1,
                  );
                  yield* Ref.update(maxInFlightProjectScans, (value) => Math.max(value, active));
                  projectScans += 1;
                  return yield* Effect.gen(function* () {
                    const captured = yield* repository.listProject(root);
                    if (scopeKind === "project" && projectScans === 2) {
                      yield* Deferred.succeed(reconciliationEntered, undefined).pipe(Effect.ignore);
                      yield* Deferred.await(allowReconciliation);
                    }
                    return captured;
                  }).pipe(Effect.ensuring(Ref.update(inFlightProjectScans, (value) => value - 1)));
                }),
            });
            const scope = yield* Scope.make();
            const index = yield* SkillCatalogIndex.make.pipe(
              Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
            );
            const makeService = SkillWatchService.makeWith({
              acquireWatch: (root) =>
                Effect.gen(function* () {
                  const isTarget =
                    scopeKind === "global" ? root !== projectRoot : root === projectRoot;
                  if (isTarget) {
                    yield* Deferred.succeed(registrationEntered, undefined).pipe(Effect.ignore);
                    yield* Deferred.await(allowRegistration);
                    return { events: Stream.fromQueue(events) };
                  }
                  return { events: Stream.never };
                }),
              onRefreshComplete: () =>
                Deferred.succeed(refreshComplete, undefined).pipe(Effect.ignore),
            }).pipe(
              Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
              Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
              Effect.provideService(Scope.Scope, scope),
            );
            const construction =
              scopeKind === "global" ? yield* makeService.pipe(Effect.forkChild) : undefined;
            const immediate = scopeKind === "project" ? yield* makeService : undefined;
            const acquisition =
              immediate === undefined
                ? undefined
                : yield* immediate.acquireProject(projectRoot).pipe(Effect.forkChild);
            yield* Deferred.await(registrationEntered);
            assert.equal(scopeKind === "global" ? globalScans : projectScans, 1);
            yield* Deferred.succeed(allowRegistration, undefined);
            yield* Deferred.await(reconciliationEntered);
            if (scopeKind === "global") {
              yield* repository.createGlobal({
                expectedRevision: 0,
                content: content("ready-global", "late"),
              });
            } else {
              yield* repository.setProjectOverride({
                projectRoot,
                key: "ready-project" as ManagedSkillKey,
                content: { name: "Ready project", body: "late" },
              });
            }
            yield* Queue.offer(events, { path: scopeKind === "global" ? "skills" : ".t3code" });
            yield* Deferred.succeed(allowReconciliation, undefined);
            const watches =
              construction === undefined ? immediate! : yield* Fiber.join(construction);
            if (acquisition !== undefined) yield* Fiber.join(acquisition);
            yield* TestClock.adjust(Duration.millis(100));
            yield* Deferred.await(refreshComplete);
            const keys =
              scopeKind === "global"
                ? (yield* index.getGlobal).entries.map((entry) => entry.key)
                : (yield* index.getProject(projectRoot)).entries.map((entry) => entry.key);
            assert.include(keys, scopeKind === "global" ? "ready-global" : "ready-project");
            if (scopeKind === "project") assert.equal(yield* Ref.get(maxInFlightProjectScans), 1);
            if (scopeKind === "project") yield* watches.releaseProject(projectRoot);
            yield* Scope.close(scope, Exit.void);
          }),
      );
    }

    it.effect("rolls back a failed project registration and retries with one lease", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-register-" });
        const scope = yield* Scope.make();
        const index = yield* SkillCatalogIndex.make;
        let fail = true;
        let opened = 0;
        let closed = 0;
        nativeWatchInterceptor.factory = () => {
          if (fail) throw new Error("registration failed");
          opened += 1;
          const watcher = new NodeEvents.EventEmitter() as NodeFS.FSWatcher;
          watcher.close = () => {
            closed += 1;
            watcher.emit("close");
          };
          return watcher;
        };
        const watches = yield* SkillWatchService.makeWith({
          acquireWatch: (root) =>
            root === projectRoot
              ? SkillWatchService.acquireNativeWatch(root)
              : Effect.succeed({ events: Stream.never }),
        }).pipe(
          Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
          Effect.provideService(Scope.Scope, scope),
        );
        assert.isTrue(Exit.isFailure(yield* Effect.exit(watches.acquireProject(projectRoot))));
        assert.isTrue(Exit.isFailure(yield* Effect.exit(index.getProject(projectRoot))));
        fail = false;
        yield* watches.acquireProject(projectRoot);
        assert.equal(opened, 1);
        yield* watches.releaseProject(projectRoot);
        assert.equal(closed, 1);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(index.getProject(projectRoot))));
        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("rolls back interruption after the private index lease is claimed", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-project-private-lease-",
        });
        const leaseClaimed = yield* Deferred.make<void>();
        const leaseClaimGate = yield* Deferred.make<void>();
        const scope = yield* Scope.make();
        const index = yield* SkillCatalogIndex.make;
        let blockLeaseClaim = true;
        let interruptTransaction: (() => void) | undefined;
        let opened = 0;
        let closed = 0;
        let released = 0;
        const watches = yield* SkillWatchService.makeWith({
          acquireWatch: (root) =>
            Effect.gen(function* () {
              if (root === projectRoot) {
                opened += 1;
                yield* Effect.addFinalizer(() => Effect.sync(() => void (closed += 1)));
              }
              return { events: Stream.never };
            }),
          onLeaseClaimed: Effect.suspend(() =>
            blockLeaseClaim
              ? Effect.withFiber((fiber) =>
                  Effect.gen(function* () {
                    interruptTransaction = () => fiber.interruptUnsafe();
                    yield* Deferred.succeed(leaseClaimed, undefined).pipe(Effect.ignore);
                    yield* Deferred.await(leaseClaimGate);
                  }),
                )
              : Effect.void,
          ),
          onLeaseRelease: Effect.sync(() => void (released += 1)),
        }).pipe(
          Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
          Effect.provideService(Scope.Scope, scope),
        );

        const interrupted = yield* watches.acquireProject(projectRoot).pipe(Effect.forkChild);
        yield* Deferred.await(leaseClaimed);
        assert.equal(opened, 0);
        interruptTransaction?.();
        yield* Deferred.succeed(leaseClaimGate, undefined);
        assert.isTrue(Exit.isFailure(yield* Fiber.await(interrupted)));
        assert.isTrue(Exit.isFailure(yield* Effect.exit(index.getProject(projectRoot))));
        assert.equal(opened, 0);
        assert.equal(closed, 0);
        assert.equal(released, 0);

        blockLeaseClaim = false;
        yield* watches.acquireProject(projectRoot);
        assert.equal(opened, 1);
        yield* watches.releaseProject(projectRoot);
        assert.equal(closed, 1);
        assert.equal(released, 1);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(index.getProject(projectRoot))));
        yield* Scope.close(scope, Exit.void);
        assert.equal(opened, 1);
        assert.equal(closed, 1);
        assert.equal(released, 1);
      }),
    );

    it.effect("rolls back interrupted project watcher setup and permits a clean retry", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-setup-" });
        const setupEntered = yield* Deferred.make<void>();
        const setupGate = yield* Deferred.make<void>();
        const scope = yield* Scope.make();
        const index = yield* SkillCatalogIndex.make;
        let block = true;
        let opened = 0;
        let closed = 0;
        let released = 0;
        const watches = yield* SkillWatchService.makeWith({
          acquireWatch: (root) =>
            Effect.gen(function* () {
              if (root === projectRoot) {
                opened += 1;
                yield* Effect.addFinalizer(() => Effect.sync(() => void (closed += 1)));
                if (block) {
                  yield* Deferred.succeed(setupEntered, undefined).pipe(Effect.ignore);
                  yield* Deferred.await(setupGate);
                }
              }
              return { events: Stream.never };
            }),
          onLeaseRelease: Effect.sync(() => void (released += 1)),
        }).pipe(
          Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
          Effect.provideService(Scope.Scope, scope),
        );
        const interrupted = yield* watches.acquireProject(projectRoot).pipe(Effect.forkChild);
        yield* Deferred.await(setupEntered);
        yield* Fiber.interrupt(interrupted);
        assert.equal(closed, 1);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(index.getProject(projectRoot))));
        block = false;
        yield* watches.acquireProject(projectRoot);
        assert.equal(opened, 2);
        yield* watches.releaseProject(projectRoot);
        assert.equal(closed, 2);
        assert.equal(released, 1);
        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("rolls back interruption during published project reconciliation", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-published-" });
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        let scans = 0;
        let block = true;
        const controlled = ManagedSkillRepository.ManagedSkillRepository.of({
          ...repository,
          listProject: (root) =>
            Effect.gen(function* () {
              scans += 1;
              if (block && scans === 2) {
                yield* Deferred.succeed(entered, undefined).pipe(Effect.ignore);
                yield* Deferred.await(gate);
              }
              return yield* repository.listProject(root);
            }),
        });
        const scope = yield* Scope.make();
        const index = yield* SkillCatalogIndex.make.pipe(
          Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
        );
        let closed = 0;
        let released = 0;
        const watches = yield* SkillWatchService.makeWith({
          acquireWatch: (root) =>
            Effect.gen(function* () {
              if (root === projectRoot)
                yield* Effect.addFinalizer(() => Effect.sync(() => void (closed += 1)));
              return { events: Stream.never };
            }),
          onLeaseRelease: Effect.sync(() => void (released += 1)),
        }).pipe(
          Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
          Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
          Effect.provideService(Scope.Scope, scope),
        );
        const interrupted = yield* watches.acquireProject(projectRoot).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(interrupted);
        assert.equal(closed, 1);
        assert.equal(released, 1);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(index.getProject(projectRoot))));
        block = false;
        yield* watches.acquireProject(projectRoot);
        yield* watches.releaseProject(projectRoot);
        assert.equal(closed, 2);
        assert.equal(released, 2);
        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("rolls back a successful transaction interrupted before race acceptance", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-race-handoff-" });
        const loserEntered = yield* Deferred.make<void>();
        const loserGate = yield* Deferred.make<void>();
        const scope = yield* Scope.make();
        const index = yield* SkillCatalogIndex.make;
        let closed = 0;
        let released = 0;
        let blockLoser = true;
        const watches = yield* SkillWatchService.makeWith({
          acquireWatch: (root) =>
            Effect.gen(function* () {
              if (root === projectRoot)
                yield* Effect.addFinalizer(() => Effect.sync(() => void (closed += 1)));
              return { events: Stream.never };
            }),
          onCancelLoserInterrupted: () =>
            blockLoser
              ? Deferred.succeed(loserEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(loserGate)),
                )
              : Effect.void,
          onLeaseRelease: Effect.sync(() => void (released += 1)),
        }).pipe(
          Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
          Effect.provideService(Scope.Scope, scope),
        );
        const acquisition = yield* watches.acquireProject(projectRoot).pipe(Effect.forkChild);
        yield* Deferred.await(loserEntered);
        acquisition.interruptUnsafe();
        yield* Deferred.succeed(loserGate, undefined);
        assert.isTrue(Exit.isFailure(yield* Fiber.await(acquisition)));
        assert.equal(closed, 1);
        assert.equal(released, 1);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(index.getProject(projectRoot))));
        blockLoser = false;
        yield* watches.acquireProject(projectRoot);
        yield* watches.releaseProject(projectRoot);
        assert.equal(closed, 2);
        assert.equal(released, 2);
        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("keeps a concurrent accepted reference when its creator rolls back", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-creator-rollback-" });
        const creatorLoser = yield* Deferred.make<void>();
        const creatorGate = yield* Deferred.make<void>();
        const scope = yield* Scope.make();
        const index = yield* SkillCatalogIndex.make;
        let firstTicket: number | undefined;
        let opened = 0;
        let closed = 0;
        let released = 0;
        const watches = yield* SkillWatchService.makeWith({
          acquireWatch: (root) =>
            Effect.gen(function* () {
              if (root === projectRoot) {
                opened += 1;
                yield* Effect.addFinalizer(() => Effect.sync(() => void (closed += 1)));
              }
              return { events: Stream.never };
            }),
          onCancelLoserInterrupted: (ticketId) => {
            if (firstTicket === undefined) firstTicket = ticketId;
            return ticketId === firstTicket
              ? Deferred.succeed(creatorLoser, undefined).pipe(
                  Effect.andThen(Deferred.await(creatorGate)),
                )
              : Effect.void;
          },
          onLeaseRelease: Effect.sync(() => void (released += 1)),
        }).pipe(
          Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
          Effect.provideService(Scope.Scope, scope),
        );
        const acquire = watches.acquireProject(projectRoot);
        const creator = yield* acquire.pipe(Effect.forkChild);
        yield* Deferred.await(creatorLoser);
        yield* acquire;
        creator.interruptUnsafe();
        yield* Deferred.succeed(creatorGate, undefined);
        assert.isTrue(Exit.isFailure(yield* Fiber.await(creator)));
        assert.equal(opened, 1);
        assert.equal(closed, 0);
        assert.equal(released, 0);
        assert.isTrue(Exit.isSuccess(yield* Effect.exit(index.getProject(projectRoot))));
        yield* watches.releaseProject(projectRoot);
        assert.equal(closed, 1);
        assert.equal(released, 1);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(index.getProject(projectRoot))));
        yield* Scope.close(scope, Exit.void);
        assert.equal(opened, 1);
        assert.equal(closed, 1);
        assert.equal(released, 1);
      }),
    );

    it.effect("owns final cleanup after the post-claim hook receives interruption", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-post-claim-" });
        const claimEntered = yield* Deferred.make<void>();
        const claimGate = yield* Deferred.make<void>();
        const scope = yield* Scope.make();
        const index = yield* SkillCatalogIndex.make;
        let closed = 0;
        let released = 0;
        const watches = yield* SkillWatchService.makeWith({
          acquireWatch: (root) =>
            Effect.gen(function* () {
              if (root === projectRoot)
                yield* Effect.addFinalizer(() => Effect.sync(() => void (closed += 1)));
              return { events: Stream.never };
            }),
          onCleanupClaimedBeforePermitReturn: Deferred.succeed(claimEntered, undefined).pipe(
            Effect.andThen(Deferred.await(claimGate)),
          ),
          onLeaseRelease: Effect.sync(() => void (released += 1)),
        }).pipe(
          Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
          Effect.provideService(Scope.Scope, scope),
        );
        yield* watches.acquireProject(projectRoot);
        const release = yield* watches.releaseProject(projectRoot).pipe(Effect.forkChild);
        yield* Deferred.await(claimEntered);
        release.interruptUnsafe();
        yield* Deferred.succeed(claimGate, undefined);
        assert.isTrue(Exit.isFailure(yield* Fiber.await(release)));
        assert.equal(closed, 1);
        assert.equal(released, 1);
        yield* Scope.close(scope, Exit.void);
        assert.equal(closed, 1);
        assert.equal(released, 1);
      }),
    );

    it.effect("cleans an existing pending reference after the accepted caller releases", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-existing-pending-" });
        const loserEntered = yield* Deferred.make<void>();
        const loserGate = yield* Deferred.make<void>();
        const scope = yield* Scope.make();
        const index = yield* SkillCatalogIndex.make;
        let block = false;
        let closed = 0;
        let released = 0;
        const watches = yield* SkillWatchService.makeWith({
          acquireWatch: (root) =>
            Effect.gen(function* () {
              if (root === projectRoot)
                yield* Effect.addFinalizer(() => Effect.sync(() => void (closed += 1)));
              return { events: Stream.never };
            }),
          onCancelLoserInterrupted: () =>
            block
              ? Deferred.succeed(loserEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(loserGate)),
                )
              : Effect.void,
          onLeaseRelease: Effect.sync(() => void (released += 1)),
        }).pipe(
          Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
          Effect.provideService(Scope.Scope, scope),
        );
        yield* watches.acquireProject(projectRoot);
        block = true;
        const pending = yield* watches.acquireProject(projectRoot).pipe(Effect.forkChild);
        yield* Deferred.await(loserEntered);
        yield* watches.releaseProject(projectRoot);
        assert.equal(closed, 0);
        pending.interruptUnsafe();
        yield* Deferred.succeed(loserGate, undefined);
        assert.isTrue(Exit.isFailure(yield* Fiber.await(pending)));
        assert.equal(closed, 1);
        assert.equal(released, 1);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(index.getProject(projectRoot))));
        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("keeps an active-project waiter interruptible behind another project scan", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const fs = yield* FileSystem.FileSystem;
        const rootA = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-wait-a-" });
        const rootB = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-wait-b-" });
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const controlled = ManagedSkillRepository.ManagedSkillRepository.of({
          ...repository,
          listProject: (root) =>
            root === rootA
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.andThen(repository.listProject(root)),
                )
              : repository.listProject(root),
        });
        const scope = yield* Scope.make();
        const index = yield* SkillCatalogIndex.make.pipe(
          Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
        );
        const watches = yield* SkillWatchService.makeWith({
          acquireWatch: () => Effect.succeed({ events: Stream.never }),
        }).pipe(
          Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
          Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
          Effect.provideService(Scope.Scope, scope),
        );
        yield* watches.acquireProject(rootB);
        const blockedA = yield* watches.acquireProject(rootA).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const waiterB = yield* watches.acquireProject(rootB).pipe(Effect.forkChild);
        yield* Fiber.interrupt(waiterB);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(blockedA);
        yield* watches.releaseProject(rootA);
        yield* watches.releaseProject(rootB);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(index.getProject(rootB))));
        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("shutdown closes one shared watcher and rejects later acquisition", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-shared-shutdown-" });
        const scope = yield* Scope.make();
        const index = yield* SkillCatalogIndex.make;
        let projectOpened = 0;
        let projectClosed = 0;
        let released = 0;
        const watches = yield* SkillWatchService.makeWith({
          acquireWatch: (root) =>
            Effect.gen(function* () {
              if (root === projectRoot) {
                projectOpened += 1;
                yield* Effect.addFinalizer(() => Effect.sync(() => void (projectClosed += 1)));
              }
              return { events: Stream.never };
            }),
          onLeaseRelease: Effect.sync(() => void (released += 1)),
        }).pipe(
          Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
          Effect.provideService(Scope.Scope, scope),
        );
        yield* watches.acquireProject(projectRoot);
        yield* watches.acquireProject(projectRoot);
        assert.equal(projectOpened, 1);
        yield* Scope.close(scope, Exit.void);
        assert.equal(projectClosed, 1);
        assert.equal(released, 1);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(watches.acquireProject(projectRoot))));
        assert.equal(projectOpened, 1);
      }),
    );

    for (const boundary of ["setup", "reconciliation"] as const) {
      it.effect(`shutdown cancels project acquisition blocked in ${boundary}`, () =>
        Effect.gen(function* () {
          const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
          const fs = yield* FileSystem.FileSystem;
          const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-shutdown-acquire-" });
          const entered = yield* Deferred.make<void>();
          const gate = yield* Deferred.make<void>();
          let scans = 0;
          const controlled = ManagedSkillRepository.ManagedSkillRepository.of({
            ...repository,
            listProject: (root) =>
              Effect.gen(function* () {
                scans += 1;
                if (boundary === "reconciliation" && scans === 2) {
                  yield* Deferred.succeed(entered, undefined).pipe(Effect.ignore);
                  yield* Deferred.await(gate);
                }
                return yield* repository.listProject(root);
              }),
          });
          const scope = yield* Scope.make();
          const index = yield* SkillCatalogIndex.make.pipe(
            Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
          );
          let closed = 0;
          let released = 0;
          const watches = yield* SkillWatchService.makeWith({
            acquireWatch: (root) =>
              Effect.gen(function* () {
                if (root === projectRoot) {
                  yield* Effect.addFinalizer(() => Effect.sync(() => void (closed += 1)));
                  if (boundary === "setup") {
                    yield* Deferred.succeed(entered, undefined).pipe(Effect.ignore);
                    yield* Deferred.await(gate);
                  }
                }
                return { events: Stream.never };
              }),
            onLeaseRelease: Effect.sync(() => void (released += 1)),
          }).pipe(
            Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
            Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
            Effect.provideService(Scope.Scope, scope),
          );
          const acquisition = yield* watches.acquireProject(projectRoot).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* Scope.close(scope, Exit.void);
          assert.isTrue(Exit.isFailure(yield* Fiber.await(acquisition)));
          assert.equal(closed, 1);
          assert.equal(released, boundary === "setup" ? 0 : 1);
          assert.isTrue(Exit.isFailure(yield* Effect.exit(index.getProject(projectRoot))));
        }),
      );
    }

    it.effect("shutdown joins cleanup already claimed by final release", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cleanup-join-" });
        const closeStarted = yield* Deferred.make<void>();
        const closeGate = yield* Deferred.make<void>();
        const shutdownWaiting = yield* Deferred.make<void>();
        const scope = yield* Scope.make();
        const index = yield* SkillCatalogIndex.make;
        let closed = 0;
        let released = 0;
        const watches = yield* SkillWatchService.makeWith({
          acquireWatch: (root) =>
            Effect.gen(function* () {
              if (root === projectRoot)
                yield* Effect.addFinalizer(() =>
                  Deferred.succeed(closeStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(closeGate)),
                    Effect.andThen(Effect.sync(() => void (closed += 1))),
                  ),
                );
              return { events: Stream.never };
            }),
          onLeaseRelease: Effect.sync(() => void (released += 1)),
          onShutdownAwaitingCleanup: Deferred.succeed(shutdownWaiting, undefined).pipe(
            Effect.ignore,
          ),
        }).pipe(
          Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
          Effect.provideService(Scope.Scope, scope),
        );
        yield* watches.acquireProject(projectRoot);
        const release = yield* watches.releaseProject(projectRoot).pipe(Effect.forkChild);
        yield* Deferred.await(closeStarted);
        release.interruptUnsafe();
        const shutdown = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
        yield* Deferred.await(shutdownWaiting);
        yield* Deferred.succeed(closeGate, undefined);
        assert.isTrue(Exit.isFailure(yield* Fiber.await(release)));
        yield* Fiber.join(shutdown);
        assert.equal(closed, 1);
        assert.equal(released, 1);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(index.getProject(projectRoot))));
      }),
    );

    it.effect("releases the lease even when the project scope finalizer defects", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-close-defect-" });
        const scope = yield* Scope.make();
        const index = yield* SkillCatalogIndex.make;
        let released = 0;
        const watches = yield* SkillWatchService.makeWith({
          acquireWatch: (root) =>
            Effect.gen(function* () {
              if (root === projectRoot)
                yield* Effect.addFinalizer(() => Effect.die("close defect"));
              return { events: Stream.never };
            }),
          onLeaseRelease: Effect.sync(() => void (released += 1)),
        }).pipe(
          Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
          Effect.provideService(Scope.Scope, scope),
        );
        yield* watches.acquireProject(projectRoot);
        yield* watches.releaseProject(projectRoot);
        assert.equal(released, 1);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(index.getProject(projectRoot))));
        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("shutdown interrupts an active project refresh without a later notification", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-active-refresh-" });
        const refreshEntered = yield* Deferred.make<void>();
        const refreshGate = yield* Deferred.make<void>();
        let scans = 0;
        const controlled = ManagedSkillRepository.ManagedSkillRepository.of({
          ...repository,
          listProject: (root) =>
            Effect.gen(function* () {
              scans += 1;
              if (scans === 3) {
                yield* Deferred.succeed(refreshEntered, undefined).pipe(Effect.ignore);
                yield* Deferred.await(refreshGate);
              }
              return yield* repository.listProject(root);
            }),
        });
        const scope = yield* Scope.make();
        const index = yield* SkillCatalogIndex.make.pipe(
          Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
        );
        const subscription = yield* index.subscribe;
        let closed = 0;
        let released = 0;
        const watches = yield* SkillWatchService.makeWith({
          acquireWatch: (root) =>
            Effect.gen(function* () {
              if (root === projectRoot)
                yield* Effect.addFinalizer(() => Effect.sync(() => void (closed += 1)));
              return { events: Stream.never };
            }),
          onLeaseRelease: Effect.sync(() => void (released += 1)),
        }).pipe(
          Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
          Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
          Effect.provideService(Scope.Scope, scope),
        );
        yield* watches.acquireProject(projectRoot);
        yield* PubSub.takeUpTo(subscription, 10);
        yield* watches.invalidateProject(projectRoot);
        const clock = yield* TestClock.adjust(Duration.millis(100)).pipe(Effect.forkChild);
        yield* Deferred.await(refreshEntered);
        yield* Scope.close(scope, Exit.void);
        yield* Fiber.join(clock);
        assert.equal(closed, 1);
        assert.equal(released, 1);
        yield* TestClock.adjust(Duration.seconds(1));
        assert.deepEqual(yield* PubSub.takeUpTo(subscription, 10), []);
      }),
    );

    it.effect("reusing acquire and release effects keeps execution-local ownership", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-reused-service-" });
        const scope = yield* Scope.make();
        const index = yield* SkillCatalogIndex.make;
        let closed = 0;
        let released = 0;
        const watches = yield* SkillWatchService.makeWith({
          acquireWatch: (root) =>
            Effect.gen(function* () {
              if (root === projectRoot)
                yield* Effect.addFinalizer(() => Effect.sync(() => void (closed += 1)));
              return { events: Stream.never };
            }),
          onLeaseRelease: Effect.sync(() => void (released += 1)),
        }).pipe(
          Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
          Effect.provideService(Scope.Scope, scope),
        );
        const acquire = watches.acquireProject(projectRoot);
        yield* Effect.all([acquire, acquire], { concurrency: "unbounded" });
        const release = watches.releaseProject(projectRoot);
        yield* Effect.all([release, release], { concurrency: "unbounded" });
        assert.equal(closed, 1);
        assert.equal(released, 1);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(index.getProject(projectRoot))));
        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("debounces explicit repository invalidation and shares project watches", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-watch-project-" });
        const events = yield* PubSub.unbounded<{ readonly root: string; readonly path: string }>();
        const opened: string[] = [];
        const closed = yield* Ref.make<ReadonlyArray<string>>([]);
        const completed = yield* Queue.unbounded<string>();
        const scope = yield* Scope.make();
        const index = yield* SkillCatalogIndex.make;
        const watches = yield* SkillWatchService.makeWith({
          acquireWatch: (root) =>
            Effect.gen(function* () {
              opened.push(root);
              yield* Effect.addFinalizer(() => Ref.update(closed, (roots) => [...roots, root]));
              return {
                events: Stream.fromPubSub(events).pipe(
                  Stream.filter((event) => event.root === root),
                ),
              };
            }),
          onRefreshComplete: (root) => Queue.offer(completed, root).pipe(Effect.asVoid),
        }).pipe(
          Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
          Effect.provideService(Scope.Scope, scope),
        );
        const subscription = yield* index.subscribe;

        yield* watches.acquireProject(projectRoot);
        yield* watches.acquireProject(projectRoot);
        assert.equal(opened.length, 2);
        yield* PubSub.takeUpTo(subscription, 10);

        yield* repository.createGlobal({
          expectedRevision: 0,
          content: content("watched", "one"),
        });
        yield* TestClock.adjust(Duration.millis(100));
        yield* Queue.take(completed);
        assert.deepEqual((yield* PubSub.take(subscription)).changedKeys, ["watched"]);

        yield* watches.releaseProject(projectRoot);
        assert.equal((yield* Ref.get(closed)).length, 0);
        yield* watches.releaseProject(projectRoot);
        assert.equal((yield* Ref.get(closed)).length, 1);

        yield* Scope.close(scope, Exit.void);
        assert.equal((yield* Ref.get(closed)).length, 2);
      }),
    );

    it.effect(
      "coalesces bursts and guarantees one trailing refresh for an event during refresh",
      () =>
        Effect.gen(function* () {
          const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
          const scans = yield* Ref.make(0);
          const inFlight = yield* Ref.make(0);
          const maxInFlight = yield* Ref.make(0);
          const block = yield* Ref.make(false);
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const completed = yield* Queue.unbounded<void>();
          const idle = yield* Queue.unbounded<void>();
          const controlled = ManagedSkillRepository.ManagedSkillRepository.of({
            ...repository,
            listGlobal: () =>
              Effect.gen(function* () {
                const active = yield* Ref.updateAndGet(inFlight, (value) => value + 1);
                yield* Ref.update(maxInFlight, (value) => Math.max(value, active));
                yield* Ref.update(scans, (value) => value + 1);
                return yield* Effect.gen(function* () {
                  if (yield* Ref.get(block)) {
                    yield* Deferred.succeed(started, undefined).pipe(Effect.ignore);
                    yield* Deferred.await(release);
                  }
                  return yield* repository.listGlobal();
                }).pipe(Effect.ensuring(Ref.update(inFlight, (value) => value - 1)));
              }),
          });
          const scope = yield* Scope.make();
          const index = yield* SkillCatalogIndex.make.pipe(
            Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
          );
          const watches = yield* SkillWatchService.makeWith({
            acquireWatch: () => Effect.succeed({ events: Stream.never }),
            onRefreshComplete: () => Queue.offer(completed, undefined).pipe(Effect.asVoid),
            onCoordinatorIdle: () => Queue.offer(idle, undefined).pipe(Effect.asVoid),
          }).pipe(
            Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
            Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
            Effect.provideService(Scope.Scope, scope),
          );
          const initialScans = yield* Ref.get(scans);

          yield* watches.invalidateGlobal;
          yield* watches.invalidateGlobal;
          yield* watches.invalidateGlobal;
          yield* Effect.yieldNow;
          yield* TestClock.adjust(Duration.millis(100));
          yield* Queue.take(completed);
          yield* Queue.take(idle);
          assert.equal(yield* Ref.get(scans), initialScans + 1);

          yield* Ref.set(block, true);
          yield* watches.invalidateGlobal;
          yield* Effect.yieldNow;
          yield* Effect.gen(function* () {
            yield* Deferred.await(started);
            yield* watches.invalidateGlobal;
            yield* watches.invalidateGlobal;
            yield* Ref.set(block, false);
            yield* Deferred.succeed(release, undefined);
          }).pipe(Effect.forkChild);
          yield* TestClock.adjust(Duration.millis(100));
          yield* Queue.take(completed);
          yield* Queue.take(completed);
          yield* Queue.take(idle);
          assert.equal(yield* Ref.get(scans), initialScans + 3);
          assert.equal(yield* Ref.get(maxInFlight), 1);
          yield* TestClock.adjust(Duration.seconds(1));
          assert.equal(yield* Ref.get(scans), initialScans + 3);

          const beforeShutdown = yield* Ref.get(scans);
          yield* watches.invalidateGlobal;
          yield* Scope.close(scope, Exit.void);
          yield* TestClock.adjust(Duration.seconds(1));
          assert.equal(yield* Ref.get(scans), beforeShutdown);
        }),
    );

    it.effect("restarts the debounce deadline after each queued invalidation", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const scans = yield* Ref.make(0);
        const controlled = ManagedSkillRepository.ManagedSkillRepository.of({
          ...repository,
          listGlobal: () =>
            Ref.update(scans, (value) => value + 1).pipe(Effect.andThen(repository.listGlobal())),
        });
        const completed = yield* Queue.unbounded<void>();
        const scope = yield* Scope.make();
        const index = yield* SkillCatalogIndex.make.pipe(
          Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
        );
        const watches = yield* SkillWatchService.makeWith({
          acquireWatch: () => Effect.succeed({ events: Stream.never }),
          onRefreshComplete: () => Queue.offer(completed, undefined).pipe(Effect.asVoid),
        }).pipe(
          Effect.provideService(ManagedSkillRepository.ManagedSkillRepository, controlled),
          Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
          Effect.provideService(Scope.Scope, scope),
        );
        const initialScans = yield* Ref.get(scans);

        yield* watches.invalidateGlobal;
        yield* TestClock.adjust(Duration.millis(50));
        yield* watches.invalidateGlobal;
        yield* TestClock.adjust(Duration.millis(50));
        assert.equal(yield* Ref.get(scans), initialScans);
        yield* TestClock.adjust(Duration.millis(50));
        yield* Queue.take(completed);
        assert.equal(yield* Ref.get(scans), initialScans + 1);
        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("reconstructs after whole skills directories and project trees are replaced", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-branch-project-" });
        yield* repository.createGlobal({
          expectedRevision: 0,
          content: content("recreated", "global"),
        });
        yield* repository.setProjectOverride({
          projectRoot,
          key: "branch-skill" as ManagedSkillKey,
          content: { name: "Branch skill", body: "project" },
        });

        const events = yield* PubSub.unbounded<{ readonly root: string; readonly path: string }>();
        const completed = yield* Queue.unbounded<string>();
        const scope = yield* Scope.make();
        const index = yield* SkillCatalogIndex.make;
        const watches = yield* SkillWatchService.makeWith({
          acquireWatch: (root) =>
            Effect.succeed({
              events: Stream.fromPubSub(events).pipe(Stream.filter((event) => event.root === root)),
            }),
          onRefreshComplete: (root) => Queue.offer(completed, root).pipe(Effect.asVoid),
        }).pipe(
          Effect.provideService(SkillCatalogIndex.SkillCatalogIndex, index),
          Effect.provideService(Scope.Scope, scope),
        );
        yield* watches.acquireProject(projectRoot);

        const backupRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-backup-" });
        const globalBackup = path.join(backupRoot, "global-package");
        const projectBackup = path.join(backupRoot, "project-tree");
        yield* fs.copy(path.join(config.managedSkillsDir, "recreated"), globalBackup);
        yield* fs.copy(path.join(projectRoot, ".t3code"), projectBackup);

        const globalWatchRoot = path.dirname(config.managedSkillsDir);
        yield* fs.remove(config.managedSkillsDir, { recursive: true });
        yield* PubSub.publish(events, { root: globalWatchRoot, path: "skills" });
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(100));
        yield* Queue.take(completed);
        assert.notInclude(
          (yield* index.getGlobal).entries.map((entry) => entry.key),
          "recreated",
        );

        yield* fs.makeDirectory(config.managedSkillsDir, { recursive: true });
        yield* fs.copy(globalBackup, path.join(config.managedSkillsDir, "recreated"));
        yield* PubSub.publish(events, { root: globalWatchRoot, path: "skills/recreated" });
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(100));
        yield* Queue.take(completed);
        assert.include(
          (yield* index.getGlobal).entries.map((entry) => entry.key),
          "recreated",
        );

        yield* fs.remove(path.join(projectRoot, ".t3code"), { recursive: true });
        yield* PubSub.publish(events, { root: projectRoot, path: ".t3code" });
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(100));
        yield* Queue.take(completed);
        assert.deepEqual((yield* index.getProject(projectRoot)).entries, []);

        yield* fs.copy(projectBackup, path.join(projectRoot, ".t3code"));
        yield* PubSub.publish(events, { root: projectRoot, path: ".t3code/skills" });
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(100));
        yield* Queue.take(completed);
        assert.deepEqual(
          (yield* index.getProject(projectRoot)).entries.map((entry) => entry.key),
          ["branch-skill"],
        );

        yield* Scope.close(scope, Exit.void);
      }),
    );
  });
});
