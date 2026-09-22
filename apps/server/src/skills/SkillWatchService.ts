// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { ManagedSkillRepository } from "./ManagedSkillRepository.ts";
import {
  acquireProjectOwned,
  SkillCatalogIndex,
  SkillCatalogScopeNotAcquired,
  type ProjectLease,
  type SkillCatalogSnapshot,
} from "./SkillCatalogIndex.ts";

interface WatchEventLike {
  readonly path: string;
}
interface AcquiredWatch {
  readonly events: Stream.Stream<WatchEventLike, PlatformError.PlatformError>;
}
export type AcquireWatch = (
  root: string,
) => Effect.Effect<AcquiredWatch, PlatformError.PlatformError, Scope.Scope>;

/** @internal */
export const acquireNativeWatch: AcquireWatch = (root) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<
      WatchEventLike,
      PlatformError.PlatformError | Cause.Done
    >();
    const resource = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          let nativeClosed = false;
          const watcher = NodeFS.watch(
            root,
            { recursive: true, encoding: "utf8" },
            (_event, filename) => {
              Queue.offerUnsafe(queue, { path: filename === null ? "" : filename });
            },
          );
          const closeNativeOnce = Effect.sync(() => {
            if (nativeClosed) return;
            nativeClosed = true;
            watcher.close();
            Queue.endUnsafe(queue);
          });
          watcher.on("error", (cause) =>
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "watch",
                  pathOrDescriptor: root,
                  cause,
                }),
              ),
            ),
          );
          watcher.on("close", () => {
            nativeClosed = true;
            Queue.endUnsafe(queue);
          });
          return { watcher, closeNativeOnce };
        },
        catch: (cause) =>
          PlatformError.systemError({
            _tag: "Unknown",
            module: "FileSystem",
            method: "watch",
            pathOrDescriptor: root,
            cause,
          }),
      }).pipe(Effect.tapError(() => Effect.sync(() => Queue.endUnsafe(queue)))),
      (acquired) => acquired.closeNativeOnce,
    );
    return { events: Stream.fromQueue(queue).pipe(Stream.ensuring(resource.closeNativeOnce)) };
  });

export interface SkillWatchServiceOptions {
  readonly acquireWatch?: AcquireWatch;
  readonly onRefreshComplete?: (root: string) => Effect.Effect<void>;
  readonly onCoordinatorIdle?: (root: string) => Effect.Effect<void>;
  readonly onLeaseClaimed?: Effect.Effect<void>;
  readonly onCancelLoserInterrupted?: (ticketId: number) => Effect.Effect<void>;
  readonly onCleanupClaimedBeforePermitReturn?: Effect.Effect<void>;
  readonly onShutdownAwaitingCleanup?: Effect.Effect<void>;
  readonly onLeaseRelease?: Effect.Effect<void>;
}

type RefreshState =
  | { readonly phase: "idle" }
  | { readonly phase: "queued"; readonly deadlineMillis: number }
  | { readonly phase: "refreshing"; readonly trailing: boolean };
interface ActiveWatch {
  readonly root: string;
  readonly scope: Scope.Closeable;
  readonly invalidations: Queue.Queue<void>;
  readonly refreshState: Ref.Ref<RefreshState>;
  lease?: ProjectLease;
  references: number;
}
type AcquisitionOwnership =
  | { readonly _tag: "None" }
  | { readonly _tag: "Private"; lease?: ProjectLease; watchScope?: Scope.Closeable }
  | { readonly _tag: "ActiveReference"; readonly active: ActiveWatch };
interface AcquisitionTicket {
  readonly id: number;
  readonly cancel: Deferred.Deferred<void>;
  readonly done: Deferred.Deferred<void>;
  ownership: AcquisitionOwnership;
  accepted: boolean;
  finished: boolean;
}
interface CleanupTicket {
  readonly id: number;
  readonly done: Deferred.Deferred<void>;
  readonly active: ActiveWatch;
  readonly runState: Ref.Ref<"pending" | "running" | "done">;
}
interface LifecycleState {
  readonly closed: boolean;
  readonly acquisitions: ReadonlyMap<number, AcquisitionTicket>;
  readonly cleanups: ReadonlyMap<number, CleanupTicket>;
}

export interface SkillWatchServiceService {
  readonly acquireProject: (projectRoot: string) => Effect.Effect<SkillCatalogSnapshot>;
  readonly releaseProject: (projectRoot: string) => Effect.Effect<void>;
  readonly invalidateGlobal: Effect.Effect<void>;
  readonly invalidateProject: (projectRoot: string) => Effect.Effect<void>;
}
export class SkillWatchService extends Context.Service<
  SkillWatchService,
  SkillWatchServiceService
>()("t3/skills/SkillWatchService") {}

const eventTouches = (
  path: Path.Path,
  watchedRoot: string,
  eventPath: string,
  component: string,
) => {
  if (eventPath.length === 0 || eventPath === ".") return true;
  const relative = path.isAbsolute(eventPath) ? path.relative(watchedRoot, eventPath) : eventPath;
  const normalized = relative.split(path.sep).join("/");
  return normalized === component || normalized.startsWith(`${component}/`);
};

export const makeWith = (options: SkillWatchServiceOptions = {}) =>
  Effect.gen(function* () {
    const repository = yield* ManagedSkillRepository;
    const index = yield* SkillCatalogIndex;
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serviceScope = yield* Effect.scope;
    const projectWatches = yield* Ref.make<ReadonlyMap<string, ActiveWatch>>(new Map());
    const projectSemaphore = yield* Semaphore.make(1);
    const lifecycle = yield* Ref.make<LifecycleState>({
      closed: false,
      acquisitions: new Map(),
      cleanups: new Map(),
    });
    let nextTicketId = 0;
    const acquireWatch = options.acquireWatch ?? acquireNativeWatch;
    const canonicalProjectRoot = (root: string) =>
      fs.realPath(root).pipe(Effect.orElseSucceed(() => path.resolve(root)));

    const signal = (active: ActiveWatch) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const offer = yield* Ref.modify(
            active.refreshState,
            (state): readonly [boolean, RefreshState] => {
              if (state.phase === "idle")
                return [true, { phase: "queued", deadlineMillis: now + 100 }];
              if (state.phase === "queued")
                return [false, { phase: "queued", deadlineMillis: now + 100 }];
              return state.trailing
                ? [false, state]
                : [false, { phase: "refreshing", trailing: true }];
            },
          );
          if (offer) yield* Queue.offer(active.invalidations, undefined).pipe(Effect.asVoid);
        }),
      );

    const makeWatch = Effect.fn("SkillWatchService.makeWatch")(function* (
      root: string,
      relevant: (event: WatchEventLike) => boolean,
      refresh: Effect.Effect<unknown, SkillCatalogScopeNotAcquired>,
      claimScope?: (scope: Scope.Closeable) => Effect.Effect<void>,
    ) {
      const scope = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const allocated = yield* Scope.make("sequential");
          yield* claimScope?.(allocated) ?? Effect.void;
          return allocated;
        }),
      );
      const invalidations = yield* Queue.unbounded<void>();
      const refreshState = yield* Ref.make<RefreshState>({ phase: "idle" });
      const active: ActiveWatch = { root, scope, invalidations, refreshState, references: 1 };
      yield* Scope.addFinalizer(scope, Queue.shutdown(invalidations));
      const acquired = yield* acquireWatch(root).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.tapError(Effect.logError),
        Effect.catch(() => Scope.close(scope, Exit.void).pipe(Effect.andThen(Effect.interrupt))),
      );
      yield* acquired.events.pipe(
        Stream.filter(relevant),
        Stream.runForEach(() => signal(active)),
        Effect.ignoreCause({ log: true }),
        Effect.forkIn(scope),
      );
      yield* Effect.gen(function* () {
        yield* Queue.take(invalidations);
        while (true) {
          const state = yield* Ref.get(refreshState);
          if (state.phase !== "queued") break;
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.sleep(Duration.millis(Math.max(0, state.deadlineMillis - now)));
          const begin = yield* Ref.modify(
            refreshState,
            (latest): readonly [boolean, RefreshState] =>
              latest.phase === "queued" && latest.deadlineMillis === state.deadlineMillis
                ? [true, { phase: "refreshing", trailing: false }]
                : [false, latest],
          );
          if (begin) break;
        }
        while ((yield* Ref.get(refreshState)).phase === "refreshing") {
          yield* refresh.pipe(Effect.ignoreCause({ log: true }));
          yield* options.onRefreshComplete?.(root) ?? Effect.void;
          const trailing = yield* Ref.modify(
            refreshState,
            (state): readonly [boolean, RefreshState] =>
              state.phase === "refreshing" && state.trailing
                ? [true, { phase: "refreshing", trailing: false }]
                : [false, { phase: "idle" }],
          );
          if (!trailing) {
            yield* options.onCoordinatorIdle?.(root) ?? Effect.void;
            break;
          }
        }
      }).pipe(Effect.forever, Effect.forkIn(scope));
      return active;
    });

    const registerCleanup = (active: ActiveWatch) =>
      Effect.gen(function* () {
        const cleanup: CleanupTicket = {
          id: ++nextTicketId,
          done: Deferred.makeUnsafe<void>(),
          active,
          runState: yield* Ref.make<"pending" | "running" | "done">("pending"),
        };
        yield* Ref.update(lifecycle, (state) => ({
          ...state,
          cleanups: new Map(state.cleanups).set(cleanup.id, cleanup),
        }));
        return cleanup;
      });
    const runCleanupOnce = (cleanup: CleanupTicket): Effect.Effect<void> =>
      Effect.uninterruptible(
        Ref.modify(cleanup.runState, (state) =>
          state === "pending" ? ([true, "running"] as const) : ([false, state] as const),
        ).pipe(
          Effect.flatMap((run) =>
            run
              ? Effect.gen(function* () {
                  const closeExit = yield* Effect.exit(
                    Scope.close(cleanup.active.scope, Exit.void),
                  );
                  const leaseExit = yield* Effect.exit(
                    cleanup.active.lease?.release ?? Effect.void,
                  );
                  if (cleanup.active.lease !== undefined)
                    yield* options.onLeaseRelease ?? Effect.void;
                  if (Exit.isFailure(closeExit)) yield* Effect.logError(closeExit.cause);
                  if (Exit.isFailure(leaseExit)) yield* Effect.logError(leaseExit.cause);
                  yield* Ref.set(cleanup.runState, "done");
                  yield* Deferred.succeed(cleanup.done, undefined).pipe(Effect.ignore);
                  yield* Ref.update(lifecycle, (state) => {
                    const cleanups = new Map(state.cleanups);
                    cleanups.delete(cleanup.id);
                    return { ...state, cleanups };
                  });
                })
              : Deferred.await(cleanup.done),
          ),
        ),
      );
    const releaseActiveReference = (active: ActiveWatch, claim: (cleanup: CleanupTicket) => void) =>
      Effect.gen(function* () {
        const cleanup = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const current = yield* Ref.get(projectWatches);
            if (current.get(active.root) !== active) return undefined;
            active.references = Math.max(0, active.references - 1);
            if (active.references > 0) return undefined;
            const registered = yield* registerCleanup(active);
            const next = new Map(current);
            next.delete(active.root);
            yield* Ref.set(projectWatches, next);
            yield* Effect.sync(() => claim(registered));
            return registered;
          }),
        );
        if (cleanup !== undefined) yield* options.onCleanupClaimedBeforePermitReturn ?? Effect.void;
      });
    const rollbackTicket = (ticket: AcquisitionTicket) =>
      Effect.suspend(() => {
        const ownership = ticket.ownership;
        ticket.ownership = { _tag: "None" };
        if (ownership._tag === "None") return Effect.void;
        if (ownership._tag === "Private")
          return Effect.uninterruptible(
            Effect.gen(function* () {
              if (ownership.watchScope !== undefined)
                yield* Effect.exit(Scope.close(ownership.watchScope, Exit.void));
              if (ownership.lease !== undefined) yield* Effect.exit(ownership.lease.release);
            }),
          );
        let claimed: CleanupTicket | undefined;
        const runClaimed = Effect.suspend(() =>
          claimed === undefined ? Effect.void : runCleanupOnce(claimed),
        );
        return Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* Effect.exit(
              restore(
                projectSemaphore.withPermits(1)(
                  releaseActiveReference(ownership.active, (cleanup) => {
                    claimed = cleanup;
                  }),
                ),
              ),
            );
            yield* runClaimed;
          }).pipe(Effect.ensuring(runClaimed)),
        );
      });
    const finishTicket = (ticket: AcquisitionTicket) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (ticket.finished) return;
          ticket.finished = true;
          if (!ticket.accepted) yield* rollbackTicket(ticket);
          yield* Ref.update(lifecycle, (state) => {
            const acquisitions = new Map(state.acquisitions);
            acquisitions.delete(ticket.id);
            return { ...state, acquisitions };
          });
          yield* Deferred.succeed(ticket.done, undefined).pipe(Effect.ignore);
        }),
      );

    const runTransaction = (ticket: AcquisitionTicket, projectRoot: string) =>
      Effect.gen(function* () {
        const canonicalRoot = yield* canonicalProjectRoot(projectRoot);
        return yield* projectSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(projectWatches);
            const existing = current.get(canonicalRoot);
            if (existing !== undefined) {
              yield* Effect.uninterruptible(
                Effect.sync(() => {
                  existing.references += 1;
                  ticket.ownership = { _tag: "ActiveReference", active: existing };
                }),
              );
              return yield* index.getProject(canonicalRoot).pipe(Effect.orDie);
            }
            ticket.ownership = { _tag: "Private" };
            yield* acquireProjectOwned(
              index,
              canonicalRoot,
              (lease) => {
                const ownership = ticket.ownership;
                if (ownership._tag === "Private") ownership.lease = lease;
              },
              options.onLeaseClaimed,
            );
            const active = yield* makeWatch(
              canonicalRoot,
              (event) => eventTouches(path, canonicalRoot, event.path, ".t3code"),
              index.refreshProject(canonicalRoot),
              (watchScope) => {
                return Effect.sync(() => {
                  const ownership = ticket.ownership;
                  if (ownership._tag === "Private") ownership.watchScope = watchScope;
                });
              },
            );
            const ownership = ticket.ownership;
            if (ownership._tag !== "Private" || ownership.lease === undefined)
              return yield* Effect.die("Project acquisition lost its private lease");
            active.lease = ownership.lease;
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                yield* Ref.set(projectWatches, new Map(current).set(canonicalRoot, active));
                ticket.ownership = { _tag: "ActiveReference", active };
              }),
            );
            return yield* index.refreshProject(canonicalRoot).pipe(Effect.orDie);
          }),
        );
      });

    const acquireProject = (projectRoot: string) =>
      Effect.suspend(() => {
        let registeredTicket: AcquisitionTicket | undefined;
        return Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const ticket = yield* Ref.modify(lifecycle, (state) => {
              if (state.closed) return [undefined, state] as const;
              const created: AcquisitionTicket = {
                id: ++nextTicketId,
                cancel: Deferred.makeUnsafe<void>(),
                done: Deferred.makeUnsafe<void>(),
                ownership: { _tag: "None" },
                accepted: false,
                finished: false,
              };
              registeredTicket = created;
              return [
                created,
                { ...state, acquisitions: new Map(state.acquisitions).set(created.id, created) },
              ] as const;
            });
            if (ticket === undefined) return yield* Effect.interrupt;
            const cancellation = Deferred.await(ticket.cancel).pipe(
              Effect.flatMap(() => Effect.interrupt),
              Effect.ensuring(options.onCancelLoserInterrupted?.(ticket.id) ?? Effect.void),
            );
            const exit = yield* Effect.exit(
              restore(Effect.raceFirst(runTransaction(ticket, projectRoot), cancellation)),
            );
            if (Exit.isSuccess(exit)) {
              ticket.accepted = true;
              ticket.ownership = { _tag: "None" };
            }
            yield* finishTicket(ticket);
            return yield* exit;
          }).pipe(
            Effect.ensuring(
              Effect.suspend(() =>
                registeredTicket === undefined ? Effect.void : finishTicket(registeredTicket),
              ),
            ),
          ),
        );
      });
    const releaseProject = (projectRoot: string) =>
      Effect.suspend(() => {
        let claimed: CleanupTicket | undefined;
        const runClaimed = Effect.suspend(() =>
          claimed === undefined ? Effect.void : runCleanupOnce(claimed),
        );
        return Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const canonicalRoot = yield* restore(canonicalProjectRoot(projectRoot));
            const claimExit = yield* Effect.exit(
              restore(
                projectSemaphore.withPermits(1)(
                  Effect.flatMap(Ref.get(projectWatches), (watches) => {
                    const active = watches.get(canonicalRoot);
                    return active === undefined
                      ? Effect.void
                      : releaseActiveReference(active, (cleanup) => {
                          claimed = cleanup;
                        });
                  }),
                ),
              ),
            );
            yield* runClaimed;
            return yield* claimExit;
          }).pipe(Effect.ensuring(runClaimed)),
        );
      });

    let globalScope: Scope.Closeable | undefined;
    yield* Effect.addFinalizer(() =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const acquisitions = yield* Ref.modify(
            lifecycle,
            (state) => [[...state.acquisitions.values()], { ...state, closed: true }] as const,
          );
          for (const ticket of acquisitions)
            yield* Deferred.succeed(ticket.cancel, undefined).pipe(Effect.ignore);
          for (const ticket of acquisitions) yield* Deferred.await(ticket.done);
          const cleanups = yield* projectSemaphore.withPermits(1)(
            Effect.gen(function* () {
              const active = [...(yield* Ref.get(projectWatches)).values()];
              yield* Ref.set(projectWatches, new Map());
              for (const item of active) yield* registerCleanup(item);
              return [...(yield* Ref.get(lifecycle)).cleanups.values()];
            }),
          );
          yield* options.onShutdownAwaitingCleanup ?? Effect.void;
          for (const cleanup of cleanups) yield* runCleanupOnce(cleanup);
          for (const cleanup of cleanups) yield* Deferred.await(cleanup.done);
          if (globalScope !== undefined) yield* Scope.close(globalScope, Exit.void);
        }),
      ),
    );

    const repositoryInvalidations = yield* repository.subscribeInvalidations;
    const globalRoot = path.dirname(config.managedSkillsDir);
    const globalComponent = path.basename(config.managedSkillsDir);
    const globalWatch = yield* makeWatch(
      globalRoot,
      (event) => eventTouches(path, globalRoot, event.path, globalComponent),
      index.refreshGlobal,
      (scope) => Effect.sync(() => void (globalScope = scope)),
    );
    const invalidateGlobal = signal(globalWatch);
    const invalidateProject = Effect.fn("SkillWatchService.invalidateProject")(function* (
      projectRoot: string,
    ) {
      const canonicalRoot = yield* canonicalProjectRoot(projectRoot);
      const active = (yield* Ref.get(projectWatches)).get(canonicalRoot);
      if (active !== undefined) yield* signal(active);
    });
    yield* Stream.fromSubscription(repositoryInvalidations).pipe(
      Stream.runForEach((event) =>
        event.scope === "global" ? invalidateGlobal : invalidateProject(event.projectRoot),
      ),
      Effect.forkIn(serviceScope),
    );
    yield* index.refreshGlobal;

    return SkillWatchService.of({
      acquireProject,
      releaseProject,
      invalidateGlobal,
      invalidateProject,
    });
  });

export const make = makeWith();
export const layer = Layer.effect(SkillWatchService, make);
