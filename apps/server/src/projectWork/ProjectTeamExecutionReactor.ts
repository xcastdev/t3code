import type { ServerSettings, ServerSettingsError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectWorkEventBus } from "./ProjectWorkEventBus.ts";
import type { ProjectWorkEvent } from "./ProjectWorkDecider.ts";

export interface ProjectTeamExecutionOwner<E, R> {
  /** Resolves only after retained startup work has been reconciled. */
  readonly ready: Effect.Effect<void, E, R>;
  readonly sweep: Effect.Effect<void, E, R>;
  /** Revokes future dispatch before awaiting the exact owned workers' joins. */
  readonly stop: Effect.Effect<void, E, R>;
}

/** A local scheduling receipt, never durable dispatch or native drain proof. */
export interface ProjectTeamExecutionReceipt {
  readonly generation: number;
  readonly status: "disabled" | "starting" | "ready" | "stopped";
  readonly completedSweeps: number;
  readonly observedCursor: number;
}

const meaningful = (event: ProjectWorkEvent) => {
  if (event.type === "project-work.foundation.recorded") {
    switch (event.record.kind) {
      case "mission":
      case "task-membership":
      case "role-revision":
      case "member":
      case "plan-revision":
      case "gate":
      case "limits":
      case "repair-episode":
        return true;
      case "message":
        return event.record.status === "queued";
      case "question":
        return event.record.status === "answered";
      default:
        return false;
    }
  }
  switch (event.type) {
    case "project-work.task.created":
    case "project-work.task.specified":
    case "project-work.task.specification-revised":
    case "project-work.task.ready":
    case "project-work.task.completed":
    case "project-work.task.failed":
    case "project-work.task.failure-resolved":
    case "project-work.task.blocked":
    case "project-work.task.blocker-resolved":
    case "project-work.task.reopened":
    case "project-work.task.canceled":
    case "project-work.task.approved":
    case "project-work.task.assigned":
    case "project-work.task.specification-protected":
    case "project-work.criterion.upserted":
    case "project-work.criterion.waived":
    case "project-work.relationship.linked":
    case "project-work.relationship.unlinked":
    case "project-work.attempt.stopped":
    case "project-work.attempt.expired":
      return true;
    default:
      return false;
  }
};

/** Owns wake scheduling only. Each owner sweep must reread durable SQL authority. */
export const makeProjectTeamExecutionReactor = Effect.fn("ProjectTeamExecutionReactor.make")(
  function* <E, R>(options: {
    readonly start: Effect.Effect<ProjectTeamExecutionOwner<E, R>, E, R | Scope.Scope>;
  }) {
    const start = options.start;
    const settings = yield* ServerSettingsService;
    const bus = yield* ProjectWorkEventBus;
    const context = yield* Effect.context<R>();
    type Error = E | ServerSettingsError;
    type Generation = {
      readonly scope: Scope.Closeable;
      closed: boolean;
      recovered: boolean;
      owner: ProjectTeamExecutionOwner<E, R> | undefined;
      operation: Fiber.Fiber<void, E> | undefined;
      closing: Deferred.Deferred<void, Error> | undefined;
    };
    const watchers = yield* Scope.make();
    const cleanup = yield* Scope.make();
    const wake = yield* Queue.dropping<void>(1);
    const initialized = yield* Deferred.make<ProjectTeamExecutionReceipt, Error>();
    let pending: Deferred.Deferred<ProjectTeamExecutionReceipt, Error> | undefined;
    let processing: Deferred.Deferred<ProjectTeamExecutionReceipt, Error> | undefined;
    let cursorChanged = yield* Deferred.make<void>();
    let observedCursor = 0;
    let completedSweeps = 0;
    let generation = 0;
    let desired = false;
    let stopped = false;
    let active: Generation | undefined;
    let failure: Cause.Cause<Error> | undefined;
    let stopResult: Deferred.Deferred<void, Error> | undefined;
    const receipt = (): ProjectTeamExecutionReceipt => ({
      generation,
      status: stopped
        ? "stopped"
        : active !== undefined && !active.closed
          ? active.recovered
            ? "ready"
            : "starting"
          : "disabled",
      completedSweeps,
      observedCursor,
    });
    const remember = (cause: Cause.Cause<Error>) => {
      failure =
        failure === undefined ? cause : Cause.fromReasons([...failure.reasons, ...cause.reasons]);
      Deferred.doneUnsafe(cursorChanged, Effect.void);
    };
    const finish = Effect.fn("ProjectTeamExecutionReactor.finish")(function* (
      waiter: Deferred.Deferred<ProjectTeamExecutionReceipt, Error> | undefined,
    ) {
      const result = failure === undefined ? Exit.succeed(receipt()) : Exit.failCause(failure);
      yield* Deferred.done(initialized, result);
      if (waiter !== undefined) yield* Deferred.done(waiter, result);
    });
    const closeGeneration = Effect.fn("ProjectTeamExecutionReactor.closeGeneration")(function* (
      current: Generation,
    ) {
      current.closed = true;
      if (current.closing === undefined) {
        const closing = Deferred.makeUnsafe<void, Error>();
        current.closing = closing;
        yield* Effect.forkIn(
          Effect.uninterruptible(
            Effect.gen(function* () {
              // stop runs alongside interruption: an owner may need stop to release held work.
              let stoppedOwner: ProjectTeamExecutionOwner<E, R> | undefined;
              const results = yield* Effect.all(
                [
                  Effect.suspend(() => {
                    stoppedOwner = current.owner;
                    return stoppedOwner === undefined
                      ? Effect.void
                      : stoppedOwner.stop.pipe(
                          Scope.provide(cleanup),
                          Effect.provideContext(context),
                        );
                  }).pipe(Effect.exit),
                  Effect.suspend(() =>
                    current.operation === undefined
                      ? Effect.void
                      : Fiber.interrupt(current.operation),
                  ).pipe(Effect.exit),
                ],
                { concurrency: "unbounded" },
              );
              const lateOwner = yield* Effect.suspend(() =>
                current.owner !== undefined && current.owner !== stoppedOwner
                  ? current.owner.stop.pipe(Scope.provide(cleanup), Effect.provideContext(context))
                  : Effect.void,
              ).pipe(Effect.exit);
              const scoped = yield* Scope.close(current.scope, Exit.void).pipe(Effect.exit);
              const reasons = [...results, lateOwner, scoped].flatMap((result) =>
                Exit.isFailure(result) ? result.cause.reasons : [],
              );
              if (reasons.length !== 0) return yield* Effect.failCause(Cause.fromReasons(reasons));
            }),
          ).pipe(
            Effect.exit,
            Effect.flatMap((result) => {
              if (Exit.isFailure(result)) remember(result.cause);
              return Deferred.done(closing, result);
            }),
          ),
          cleanup,
        );
      }
      yield* Deferred.await(current.closing);
    }, Effect.uninterruptible);
    const close = Effect.uninterruptible(
      Effect.gen(function* () {
        if (stopResult !== undefined) return yield* Deferred.await(stopResult);
        // Publish the join and revoke scheduling before yielding to cleanup.
        const joined = Deferred.makeUnsafe<void, Error>();
        stopResult = joined;
        stopped = true;
        if (active !== undefined) {
          yield* closeGeneration(active).pipe(Effect.exit);
        }
        const watched = yield* Scope.close(watchers, Exit.void).pipe(Effect.exit);
        if (Exit.isFailure(watched)) remember(watched.cause);
        const cleaned = yield* Scope.close(cleanup, Exit.void).pipe(Effect.exit);
        if (Exit.isFailure(cleaned)) remember(cleaned.cause);
        yield* Queue.shutdown(wake);
        yield* Deferred.succeed(cursorChanged, undefined);
        yield* finish(pending);
        yield* finish(processing);
        pending = undefined;
        yield* Deferred.done(joined, failure === undefined ? Exit.void : Exit.failCause(failure));
        return yield* Deferred.await(joined);
      }),
    );
    const stop = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const settled = yield* close.pipe(Effect.exit);
        const interrupted = yield* restore(Effect.void).pipe(Effect.exit);
        const reasons = [settled, interrupted].flatMap((result) =>
          Exit.isFailure(result) ? result.cause.reasons : [],
        );
        if (reasons.length !== 0) return yield* Effect.failCause(Cause.fromReasons(reasons));
      }),
    );
    // Own every scope before acquiring either subscription or the initial snapshot.
    yield* Effect.addFinalizer(() => stop.pipe(Effect.orDie));
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const construction = yield* restore(
          Effect.gen(function* () {
            const guard = (work: Effect.Effect<void>) =>
              work.pipe(
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    if (stopped) return;
                    remember(cause);
                    if (active !== undefined) yield* closeGeneration(active).pipe(Effect.exit);
                    yield* finish(pending);
                    yield* finish(processing);
                  }),
                ),
              );
            const changes = yield* settings.subscribeChanges.pipe(Scope.provide(watchers));
            const events = yield* bus.subscribe.pipe(Scope.provide(watchers));
            const applySettings = Effect.fn("ProjectTeamExecutionReactor.applySettings")(function* (
              value: ServerSettings,
            ) {
              desired = value.projectWorkEnabled && value.projectTeamExecutionEnabled;
              if (!desired && active !== undefined && !active.closed) {
                active.closed = true;
                const current = active;
                yield* Effect.forkIn(closeGeneration(current).pipe(Effect.exit), watchers);
              }
              yield* Queue.offer(wake, undefined);
            });
            yield* applySettings(yield* settings.getSettings);
            yield* Effect.forkIn(guard(Stream.runForEach(changes, applySettings)), watchers);
            yield* Effect.forkIn(
              guard(
                Stream.runForEach(events, (committed) =>
                  Effect.gen(function* () {
                    observedCursor = Math.max(observedCursor, committed.cursor);
                    const signal = cursorChanged;
                    cursorChanged = yield* Deferred.make<void>();
                    yield* Deferred.succeed(signal, undefined);
                    if (meaningful(committed.event)) yield* Queue.offer(wake, undefined);
                  }),
                ),
              ),
              watchers,
            );
            yield* Effect.forkIn(
              guard(
                Effect.gen(function* () {
                  while (true) {
                    if (stopped) return;
                    yield* Queue.take(wake);
                    const waiter = pending;
                    pending = undefined;
                    processing = waiter;
                    if (active?.closed) {
                      yield* closeGeneration(active).pipe(Effect.exit);
                      if (failure === undefined) active = undefined;
                    }
                    if (failure === undefined && desired && !stopped) {
                      const current = active ?? {
                        scope: yield* Scope.make(),
                        closed: false,
                        recovered: false,
                        owner: undefined,
                        operation: undefined,
                        closing: undefined,
                      };
                      if (active === undefined) {
                        active = current;
                        generation++;
                      }
                      current.operation = yield* Effect.forkIn(
                        Effect.gen(function* () {
                          if (current.closed || stopped || !desired) return;
                          if (current.owner === undefined) {
                            yield* Effect.uninterruptibleMask((restore) =>
                              Effect.gen(function* () {
                                const owner = yield* restore(
                                  start.pipe(
                                    Scope.provide(current.scope),
                                    Effect.provideContext(context),
                                  ),
                                );
                                current.owner = owner;
                              }),
                            );
                            yield* current.owner!.ready.pipe(
                              Scope.provide(current.scope),
                              Effect.provideContext(context),
                            );
                            current.recovered = true;
                          }
                          if (current.closed || stopped || !desired) return;
                          yield* current.owner!.sweep.pipe(
                            Scope.provide(current.scope),
                            Effect.provideContext(context),
                          );
                          completedSweeps++;
                        }),
                        current.scope,
                      );
                      const result = yield* Fiber.await(current.operation);
                      if (
                        Exit.isFailure(result) &&
                        !(current.closed && Cause.hasInterruptsOnly(result.cause))
                      ) {
                        current.closed = true;
                        remember(result.cause);
                      }
                      if (current.closed) {
                        yield* closeGeneration(current).pipe(Effect.exit);
                      }
                    }
                    yield* finish(waiter);
                    processing = undefined;
                  }
                }),
              ),
              watchers,
            );
            const observed = Effect.fn("ProjectTeamExecutionReactor.observed")(function* (
              afterCursor: number,
            ) {
              while (true) {
                if (observedCursor >= afterCursor || stopped || failure !== undefined) break;
                yield* Deferred.await(cursorChanged);
              }
              if (failure !== undefined) return yield* Effect.failCause(failure);
              return receipt();
            });
            const drain = Effect.fn("ProjectTeamExecutionReactor.drain")(function* (
              afterCursor = 0,
            ) {
              yield* observed(afterCursor);
              if (stopped) return receipt();
              // Publishing and capturing the shared waiter must not yield.
              pending ??= Deferred.makeUnsafe<ProjectTeamExecutionReceipt, Error>();
              const waiter = pending;
              yield* Queue.offer(wake, undefined);
              return yield* Deferred.await(waiter);
            });
            return { ready: Deferred.await(initialized), observed, drain, stop };
          }),
        ).pipe(Effect.exit);
        const interrupted = yield* restore(Effect.void).pipe(Effect.exit);
        if (Exit.isSuccess(construction) && Exit.isSuccess(interrupted)) return construction.value;
        const settled = yield* close.pipe(Effect.exit);
        return yield* Effect.failCause(
          Cause.fromReasons([
            ...(Exit.isFailure(construction) ? construction.cause.reasons : []),
            ...(Exit.isFailure(interrupted) ? interrupted.cause.reasons : []),
            ...(Exit.isFailure(settled) ? settled.cause.reasons : []),
          ]),
        );
      }),
    );
  },
);
