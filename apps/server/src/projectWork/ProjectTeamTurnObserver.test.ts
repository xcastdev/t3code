import { expect, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeTurnCompletedEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
  makeProjectTeamTurnObserver,
  ProjectTeamTurnObserverError,
  type ProjectTeamTurnPublication,
} from "./ProjectTeamTurnObserver.ts";

const identity = {
  providerInstanceId: ProviderInstanceId.make("pi_owned"),
  threadId: ThreadId.make("owned-thread"),
  turnId: TurnId.make("original-operation"),
};
const completed = (state: ProviderRuntimeTurnCompletedEvent["payload"]["state"] = "completed") =>
  ({
    eventId: EventId.make("terminal"),
    provider: ProviderDriverKind.make("piAgent"),
    ...identity,
    createdAt: "2026-10-04T08:00:00.000Z",
    type: "turn.completed",
    payload: { state },
  }) satisfies ProviderRuntimeTurnCompletedEvent;

const fixture = Effect.fn("observerTest.fixture")(function* (maximumPending = 2) {
  const events = yield* PubSub.unbounded<ProjectTeamTurnPublication>();
  let sequence = 0n;
  const observer = yield* makeProjectTeamTurnObserver({
    subscribe: PubSub.subscribe(events),
    currentPublicationSequence: () => sequence,
    maximumPending,
  });
  const publish = (event: ProjectTeamTurnPublication["event"]) =>
    Effect.suspend(() => PubSub.publish(events, { sequence: ++sequence, event }));
  return { observer, events, publish };
});

const barrier = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  return {
    entered,
    release,
    wait: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
  };
});
const isObserverError = Schema.is(ProjectTeamTurnObserverError);
const codes = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.flatMap((reason) =>
        Cause.isFailReason(reason) && isObserverError(reason.error) ? [reason.error.code] : [],
      )
    : [];
const observedScope = Effect.gen(function* () {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  return scope;
});

it.effect(
  "captures completion published inside the send effect before its immediate API return",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { observer, publish } = yield* fixture();
        const event = completed();
        const result = yield* observer.withObservation(
          identity,
          publish(event).pipe(Effect.as("prepared")),
        );
        expect(result.sent).toBe("prepared");
        expect(result.event).toEqual(event);
        yield* observer.stop;
      }),
    ),
);

it.effect(
  "ignores a matching publication preceding registration even when it is still queued",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { observer, publish } = yield* fixture();
        yield* publish({ ...completed(), eventId: EventId.make("old") });
        const fresh = { ...completed(), eventId: EventId.make("fresh") };
        const result = yield* observer.withObservation(identity, publish(fresh));
        expect(result.event.eventId).toBe("fresh");
      }),
    ),
);

it.effect(
  "requires exact instance, thread and original turn identity and a completed event type",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { observer, publish } = yield* fixture();
        const correct = { ...completed(), eventId: EventId.make("correct") };
        const incorrect: ProjectTeamTurnPublication["event"][] = [
          { ...completed(), providerInstanceId: ProviderInstanceId.make("pi_other") },
          { ...completed(), threadId: ThreadId.make("other-thread") },
          { ...completed(), turnId: TurnId.make("old-generation-operation") },
          { ...completed(), type: "turn.started", payload: {} },
        ];
        const result = yield* observer.withObservation(
          identity,
          Effect.forEach(incorrect, publish).pipe(Effect.andThen(publish(correct))),
        );
        expect(result.event.eventId).toBe("correct");
      }),
    ),
);

it.effect("keeps the observation pending after the send API returns until actual completion", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { observer, publish } = yield* fixture();
      const sent = yield* Deferred.make<void>();
      const run = yield* observer
        .withObservation(identity, Deferred.succeed(sent, undefined).pipe(Effect.as("prepared")))
        .pipe(Effect.forkChild);
      yield* Deferred.await(sent);
      expect(run.pollUnsafe()).toBeUndefined();
      yield* publish(completed());
      expect((yield* Fiber.join(run)).sent).toBe("prepared");
    }),
  ),
);

it.effect(
  "retains a terminal hint published while send is held and still joins send before returning",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { observer, publish } = yield* fixture();
        const send = yield* barrier;
        const run = yield* observer
          .withObservation(identity, send.wait.pipe(Effect.as("prepared")))
          .pipe(Effect.forkChild);
        yield* Deferred.await(send.entered);
        yield* publish(completed("failed"));
        expect(run.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(send.release, undefined);
        const result = yield* Fiber.join(run);
        expect(result.event.payload.state).toBe("failed");
        expect(result.sent).toBe("prepared");
      }),
    ),
);

for (const state of ["completed", "failed", "interrupted", "cancelled"] as const) {
  it.effect(`preserves the actual ${state} status without granting receipt authority`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { observer, publish } = yield* fixture();
        const result = yield* observer.withObservation(identity, publish(completed(state)));
        expect(result.event.payload.state).toBe(state);
      }),
    ),
  );
}

it.effect("rejects duplicate ownership and excess capacity before a second send starts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { observer, publish } = yield* fixture(1);
      const send = yield* barrier;
      const run = yield* observer.withObservation(identity, send.wait).pipe(Effect.forkChild);
      yield* Deferred.await(send.entered);
      let forbiddenSends = 0;
      const forbidden = Effect.sync(() => {
        forbiddenSends++;
      });
      expect(codes(yield* Effect.exit(observer.withObservation(identity, forbidden)))).toEqual([
        "duplicate",
      ]);
      expect(
        codes(
          yield* Effect.exit(
            observer.withObservation({ ...identity, turnId: TurnId.make("other") }, forbidden),
          ),
        ),
      ).toEqual(["capacity"]);
      expect(forbiddenSends).toBe(0);
      yield* publish(completed());
      yield* Deferred.succeed(send.release, undefined);
      yield* Fiber.join(run);
      const result = yield* observer.withObservation(
        { ...identity, turnId: TurnId.make("next") },
        publish({ ...completed(), turnId: TurnId.make("next") }),
      );
      expect(result.event.turnId).toBe("next");
    }),
  ),
);

it.effect("captures an immutable identity when the observation effect is created", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { observer, publish } = yield* fixture();
      const mutable = { ...identity };
      const run = observer.withObservation(mutable, publish(completed()));
      mutable.providerInstanceId = ProviderInstanceId.make("changed");
      mutable.threadId = ThreadId.make("changed");
      mutable.turnId = TurnId.make("changed");
      expect((yield* run).event.turnId).toBe("original-operation");
    }),
  ),
);

it.effect("preserves every send failure reason before and after a terminal publication", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { observer, publish } = yield* fixture();
      const error = { detail: "original send failure" };
      const cause = Cause.fromReasons([
        Cause.makeFailReason(error),
        Cause.makeFailReason(error),
        Cause.makeDieReason("send defect"),
      ]);
      for (const send of [
        Effect.failCause(cause),
        publish(completed()).pipe(Effect.andThen(Effect.failCause(cause))),
      ]) {
        const exit = yield* Effect.exit(observer.withObservation(identity, send));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual(["Fail", "Fail", "Die"]);
          expect(
            exit.cause.reasons.flatMap((reason) =>
              Cause.isFailReason(reason) ? [reason.error] : [],
            ),
          ).toEqual([error, error]);
          expect(
            exit.cause.reasons.flatMap((reason) =>
              Cause.isDieReason(reason) ? [reason.defect] : [],
            ),
          ).toEqual(["send defect"]);
        }
      }
      yield* observer.stop;
    }),
  ),
);

it.effect("concurrent stops share one joined receipt while a send finalizer is held", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { observer, publish } = yield* fixture();
      const send = yield* barrier;
      const cleanup = yield* barrier;
      const cleaned = yield* Deferred.make<void>();
      const run = yield* observer
        .withObservation(
          identity,
          send.wait.pipe(
            Effect.ensuring(
              cleanup.wait.pipe(Effect.andThen(Deferred.succeed(cleaned, undefined))),
            ),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(send.entered);
      yield* publish(completed());
      const stop1 = yield* observer.stop.pipe(Effect.forkChild);
      yield* Deferred.await(cleanup.entered);
      const stop2 = yield* observer.stop.pipe(Effect.forkChild);
      expect(stop1.pollUnsafe()).toBeUndefined();
      expect(stop2.pollUnsafe()).toBeUndefined();
      expect(
        codes(
          yield* Effect.exit(
            observer.withObservation(identity, Effect.die("must not send after stop")),
          ),
        ),
      ).toEqual(["stopped"]);
      yield* Deferred.succeed(cleanup.release, undefined);
      const first = yield* Fiber.join(stop1);
      const second = yield* Fiber.join(stop2);
      expect(second).toBe(first);
      expect(first.observations).toHaveLength(1);
      expect(yield* Deferred.isDone(cleaned)).toBe(true);
      expect(Exit.isFailure(yield* Fiber.await(run))).toBe(true);
    }),
  ),
);

it.effect("caller interruption joins its send and permits other observations to finish", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { observer, publish } = yield* fixture();
      const send = yield* barrier;
      const cleanup = yield* Deferred.make<void>();
      const first = yield* observer
        .withObservation(
          identity,
          send.wait.pipe(Effect.ensuring(Deferred.succeed(cleanup, undefined))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(send.entered);
      yield* Fiber.interrupt(first);
      expect(yield* Deferred.isDone(cleanup)).toBe(true);
      const next = { ...identity, turnId: TurnId.make("next") };
      expect(
        (yield* observer.withObservation(next, publish({ ...completed(), turnId: next.turnId })))
          .event.turnId,
      ).toBe("next");
    }),
  ),
);

it.effect("caller interruption preserves repeated independent cleanup defects after joining", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { observer } = yield* fixture();
      const entered = yield* barrier;
      const defect = new Error("same independent cleanup reason");
      const send = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const exit = yield* restore(entered.wait).pipe(Effect.exit);
          if (Exit.isFailure(exit))
            return yield* Effect.failCause(
              Cause.fromReasons([
                ...exit.cause.reasons,
                Cause.makeDieReason(defect),
                Cause.makeDieReason(defect),
              ]),
            );
        }),
      );
      const run = yield* observer.withObservation(identity, send).pipe(Effect.forkChild);
      yield* Deferred.await(entered.entered);
      yield* Fiber.interrupt(run);
      const exit = yield* Fiber.await(run);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(
          exit.cause.reasons.flatMap((reason) =>
            Cause.isDieReason(reason) ? [reason.defect] : [],
          ),
        ).toEqual([defect, defect]);
        expect(exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true);
      }
      yield* observer.stop;
    }),
  ),
);

it.effect.each(["direct send", "observation"] as const)(
  "%s cancellation preserves original independent interrupt occurrences after joining",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { observer } = yield* fixture();
        const held = yield* barrier;
        const defect = new Error("original cancellation cleanup");
        const send = Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const cancelled = yield* restore(held.wait).pipe(Effect.exit);
            if (Exit.isFailure(cancelled))
              return yield* Effect.failCause(
                Cause.fromReasons([
                  ...cancelled.cause.reasons,
                  Cause.makeInterruptReason(700001),
                  Cause.makeInterruptReason(700002),
                  Cause.makeInterruptReason(700002),
                  Cause.makeDieReason(defect),
                ]),
              );
          }),
        );
        const operation =
          mode === "direct send"
            ? send
            : observer.withObservation(identity, send).pipe(Effect.asVoid);
        const run = yield* operation.pipe(Effect.forkChild);
        yield* Deferred.await(held.entered);
        yield* Fiber.interrupt(run);
        const exit = yield* Fiber.await(run);
        const receipt = yield* observer.stop;
        expect(receipt.observations).toEqual([]);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(
            exit.cause.reasons.flatMap((reason) =>
              Cause.isDieReason(reason) ? [reason.defect] : [],
            ),
          ).toEqual([defect]);
          expect(
            exit.cause.reasons.flatMap((reason) =>
              Cause.isInterruptReason(reason) &&
              (reason.fiberId === 700001 || reason.fiberId === 700002)
                ? [reason.fiberId]
                : [],
            ),
          ).toEqual([700001, 700002, 700002]);
        }
      }),
    ),
);

it.effect.each(["implicit", "interrupted explicit", "interrupted masked explicit"] as const)(
  "%s stop leaves unobserved subscription cleanup failure visible at Root closure",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProjectTeamTurnPublication>();
        const rootScope = yield* Scope.make();
        const cleanup = yield* barrier;
        const defect = new Error("unobserved subscription cleanup");
        const observer = yield* makeProjectTeamTurnObserver({
          subscribe: Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(events);
            yield* Effect.addFinalizer(() => cleanup.wait.pipe(Effect.andThen(Effect.die(defect))));
            return subscription;
          }),
          currentPublicationSequence: () => 0n,
          maximumPending: 1,
        }).pipe(Effect.provideService(Scope.Scope, rootScope));
        const stop =
          mode === "interrupted masked explicit"
            ? Effect.uninterruptible(observer.stop)
            : observer.stop;
        const stopped = mode === "implicit" ? undefined : yield* stop.pipe(Effect.forkChild);
        if (stopped !== undefined) {
          yield* Deferred.await(cleanup.entered);
          yield* Effect.sync(() => stopped.interruptUnsafe(720000));
        }
        const closed = yield* Scope.close(rootScope, Exit.void).pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(cleanup.entered);
        expect(closed.pollUnsafe()).toBeUndefined();
        if (stopped !== undefined) expect(stopped.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(cleanup.release, undefined);
        const scopeExit = yield* Fiber.join(closed);
        const stopExit = stopped === undefined ? undefined : yield* Fiber.await(stopped);
        if (stopExit !== undefined) {
          expect(Exit.isFailure(stopExit)).toBe(true);
          if (Exit.isFailure(stopExit))
            expect(
              stopExit.cause.reasons.flatMap((reason) =>
                Cause.isInterruptReason(reason) ? [reason.fiberId] : [],
              ),
            ).toContain(720000);
        }
        const receipt = yield* observer.stop;
        expect(
          [receipt.consumer, receipt.subscription].flatMap((exit) =>
            Exit.isFailure(exit)
              ? exit.cause.reasons.flatMap((reason) =>
                  Cause.isDieReason(reason) ? [reason.defect] : [],
                )
              : [],
          ),
        ).toContain(defect);
        const returned = stopExit === undefined ? [scopeExit] : [Exit.asVoid(stopExit), scopeExit];
        expect(
          returned.flatMap((exit) =>
            Exit.isFailure(exit)
              ? exit.cause.reasons.flatMap((reason) =>
                  Cause.isDieReason(reason)
                    ? Cause.isCause(reason.defect)
                      ? reason.defect.reasons.flatMap((inner) =>
                          Cause.isDieReason(inner) ? [inner.defect] : [],
                        )
                      : [reason.defect]
                    : [],
                )
              : [],
          ),
        ).toContain(defect);
      }),
    ),
);

it.effect(
  "actual PubSub shutdown unblocks and joins a held send without successful completion",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { observer, events } = yield* fixture();
        const send = yield* barrier;
        const cleanup = yield* Deferred.make<void>();
        const run = yield* observer
          .withObservation(
            identity,
            send.wait.pipe(Effect.ensuring(Deferred.succeed(cleanup, undefined))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(send.entered);
        yield* PubSub.shutdown(events);
        expect(Exit.isFailure(yield* Fiber.await(run))).toBe(true);
        expect(yield* Deferred.isDone(cleanup)).toBe(true);
        const receipt = yield* observer.stop;
        expect(Exit.isFailure(receipt.consumer)).toBe(true);
      }),
    ),
);

for (const sequence of [-1n, 0n, 1n]) {
  it.effect(
    `rejects a nonmonotonic or negative ${sequence} publication and joins pending work`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { observer, events, publish } = yield* fixture();
          const send = yield* barrier;
          yield* publish({ ...completed(), turnId: TurnId.make("unrelated") });
          const run = yield* observer.withObservation(identity, send.wait).pipe(Effect.forkChild);
          yield* Deferred.await(send.entered);
          yield* PubSub.publish(events, { sequence, event: completed() });
          expect(codes(yield* Fiber.await(run))).toContain("invalid-sequence");
          const receipt = yield* observer.stop;
          expect(codes(receipt.consumer)).toEqual(["invalid-sequence"]);
        }),
      ),
  );
}

it.effect(
  "stop closes the actual owned subscription and does not shut down the shared source",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { observer, events, publish } = yield* fixture();
        const other = yield* PubSub.subscribe(events);
        yield* observer.stop;
        const event = completed();
        yield* publish(event);
        expect((yield* PubSub.take(other)).event).toEqual(event);
        expect(yield* PubSub.isShutdown(events)).toBe(false);
      }),
    ),
);

it.effect("consumer defects unblock every owned send and remain in the joined stop receipt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { observer, events } = yield* fixture();
      const firstSend = yield* barrier;
      const secondSend = yield* barrier;
      const first = yield* observer
        .withObservation(identity, firstSend.wait)
        .pipe(Effect.forkChild);
      const second = yield* observer
        .withObservation({ ...identity, turnId: TurnId.make("second") }, secondSend.wait)
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstSend.entered);
      yield* Deferred.await(secondSend.entered);
      const defect = new Error("actual publication envelope failed");
      const publication = {
        sequence: 1n,
        get event(): ProjectTeamTurnPublication["event"] {
          throw defect;
        },
      };
      yield* PubSub.publish(events, publication);
      for (const run of [first, second]) {
        const exit = yield* Fiber.await(run);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(
            exit.cause.reasons.flatMap((reason) =>
              Cause.isDieReason(reason) ? [reason.defect] : [],
            ),
          ).toContain(defect);
      }
      const receipt = yield* observer.stop;
      expect(Exit.isFailure(receipt.consumer)).toBe(true);
      if (Exit.isFailure(receipt.consumer))
        expect(
          receipt.consumer.cause.reasons.flatMap((reason) =>
            Cause.isDieReason(reason) ? [reason.defect] : [],
          ),
        ).toEqual([defect]);
    }),
  ),
);

it.effect("joined stop retains cleanup failures after an earlier completion hint", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { observer, publish } = yield* fixture();
      const send = yield* barrier;
      const defect = new Error("owned send cleanup failed");
      const run = yield* observer
        .withObservation(identity, send.wait.pipe(Effect.ensuring(Effect.die(defect))))
        .pipe(Effect.forkChild);
      yield* Deferred.await(send.entered);
      yield* publish(completed());
      const receipt = yield* observer.stop;
      expect(receipt.observations).toHaveLength(1);
      const exit = receipt.observations[0];
      expect(exit && Exit.isFailure(exit)).toBe(true);
      if (exit && Exit.isFailure(exit))
        expect(
          exit.cause.reasons.flatMap((reason) =>
            Cause.isDieReason(reason) ? [reason.defect] : [],
          ),
        ).toEqual([defect]);
      const callerExit = yield* Fiber.await(run);
      if (Exit.isFailure(callerExit))
        expect(
          callerExit.cause.reasons.flatMap((reason) =>
            Cause.isDieReason(reason) ? [reason.defect] : [],
          ),
        ).toContain(defect);
      else expect.fail("Stopped observation must not report success");
    }),
  ),
);

it.effect(
  "subscription cleanup failure remains in the consumer receipt instead of becoming success",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProjectTeamTurnPublication>();
        const defect = new Error("owned subscription cleanup failed");
        const observer = yield* makeProjectTeamTurnObserver({
          subscribe: Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(events);
            yield* Effect.addFinalizer(() => Effect.die(defect));
            return subscription;
          }),
          currentPublicationSequence: () => 0n,
          maximumPending: 1,
        });
        const receipt = yield* observer.stop;
        const reasons = [receipt.consumer, receipt.subscription].flatMap((exit) =>
          Exit.isFailure(exit)
            ? exit.cause.reasons.flatMap((reason) =>
                Cause.isDieReason(reason) ? [reason.defect] : [],
              )
            : [],
        );
        expect(reasons).toContain(defect);
      }),
    ),
);

it.effect("automatic Scope cleanup surfaces an unobserved subscription failure", () =>
  Effect.gen(function* () {
    const defect = new Error("unobserved subscription cleanup failed");
    const exit = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<ProjectTeamTurnPublication>();
          yield* makeProjectTeamTurnObserver({
            subscribe: Effect.gen(function* () {
              const subscription = yield* PubSub.subscribe(events);
              yield* Effect.addFinalizer(() => Effect.die(defect));
              return subscription;
            }),
            currentPublicationSequence: () => 0n,
            maximumPending: 1,
          });
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const reported = exit.cause.reasons.flatMap((reason) =>
        Cause.isDieReason(reason) && Cause.isCause(reason.defect) ? [reason.defect] : [],
      );
      expect(
        reported.flatMap((cause) =>
          cause.reasons.flatMap((reason) => (Cause.isDieReason(reason) ? [reason.defect] : [])),
        ),
      ).toContain(defect);
    }
  }),
);

it.effect("does not return readiness before the actual subscription acquisition completes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProjectTeamTurnPublication>();
      const acquisition = yield* barrier;
      const construction = yield* makeProjectTeamTurnObserver({
        subscribe: acquisition.wait.pipe(Effect.andThen(PubSub.subscribe(events))),
        currentPublicationSequence: () => 0n,
        maximumPending: 1,
      }).pipe(Effect.forkChild);
      yield* Deferred.await(acquisition.entered);
      expect(construction.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(acquisition.release, undefined);
      const observer = yield* Fiber.join(construction);
      const result = yield* observer.withObservation(
        identity,
        PubSub.publish(events, { sequence: 1n, event: completed() }),
      );
      expect(result.event.payload.state).toBe("completed");
      yield* observer.stop;
    }),
  ),
);

it.effect(
  "interrupted acquisition closes its own acquired resources and preserves the caller interruption",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProjectTeamTurnPublication>();
        const acquisition = yield* barrier;
        const released = yield* Deferred.make<void>();
        const construction = yield* makeProjectTeamTurnObserver({
          subscribe: Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(events);
            yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
            yield* acquisition.wait;
            return subscription;
          }),
          currentPublicationSequence: () => 0n,
          maximumPending: 1,
        }).pipe(Effect.forkChild);
        yield* Deferred.await(acquisition.entered);
        yield* Fiber.interrupt(construction);
        expect(Exit.isFailure(yield* Fiber.await(construction))).toBe(true);
        expect(yield* Deferred.isDone(released)).toBe(true);
      }),
    ),
);

it.effect("accepts 128 owned waiters and refuses the next without sending", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { observer } = yield* fixture(128);
      const runs = [];
      for (let index = 0; index < 128; index++) {
        const send = yield* barrier;
        const run = yield* observer
          .withObservation({ ...identity, turnId: TurnId.make(`owned-${index}`) }, send.wait)
          .pipe(Effect.forkChild);
        yield* Deferred.await(send.entered);
        runs.push(run);
      }
      let sends = 0;
      const exit = yield* Effect.exit(
        observer.withObservation(
          identity,
          Effect.sync(() => {
            sends++;
          }),
        ),
      );
      expect(codes(exit)).toEqual(["capacity"]);
      expect(sends).toBe(0);
      const receipt = yield* observer.stop;
      expect(receipt.observations).toHaveLength(128);
      for (const run of runs) expect(Exit.isFailure(yield* Fiber.await(run))).toBe(true);
    }),
  ),
);

class RootValue extends Context.Service<RootValue, string>()(
  "t3/projectWork/ProjectTeamTurnObserver.test/RootValue",
) {}

it.effect(
  "captures original services and ports while preserving the observation caller Scope",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProjectTeamTurnPublication>();
        const foreign = yield* PubSub.unbounded<ProjectTeamTurnPublication>();
        let sequence = 0n;
        const rootScope = yield* observedScope;
        const callerScope = yield* observedScope;
        const options = {
          subscribe: PubSub.subscribe(events),
          currentPublicationSequence: () => sequence,
          maximumPending: 1,
        };
        const construction = makeProjectTeamTurnObserver(options);
        options.subscribe = PubSub.subscribe(foreign);
        options.currentPublicationSequence = () => 999n;
        options.maximumPending = 0;
        const observer = yield* construction.pipe(
          Effect.provideService(RootValue, "original"),
          Effect.provideService(Scope.Scope, rootScope),
        );
        const result = yield* observer
          .withObservation(
            identity,
            Effect.gen(function* () {
              const value = yield* RootValue;
              const scope = yield* Effect.scope;
              yield* PubSub.publish(events, { sequence: ++sequence, event: completed() });
              return { value, scope };
            }),
          )
          .pipe(
            Effect.provideService(RootValue, "replacement"),
            Effect.provideService(Scope.Scope, callerScope),
          );
        expect(result.sent).toEqual({ value: "original", scope: callerScope });
        expect(Object.isFrozen(observer)).toBe(true);
        yield* observer.stop;
      }),
    ),
);

it.effect("Root Scope finalization joins all held observations and closes the subscription", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const rootScope = yield* observedScope;
      const { observer } = yield* fixture().pipe(Effect.provideService(Scope.Scope, rootScope));
      const firstSend = yield* barrier;
      const secondSend = yield* barrier;
      const cleaned: string[] = [];
      const first = yield* observer
        .withObservation(
          identity,
          firstSend.wait.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                cleaned.push("first");
              }),
            ),
          ),
        )
        .pipe(Effect.forkChild);
      const second = yield* observer
        .withObservation(
          { ...identity, turnId: TurnId.make("second") },
          secondSend.wait.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                cleaned.push("second");
              }),
            ),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstSend.entered);
      yield* Deferred.await(secondSend.entered);
      yield* Scope.close(rootScope, Exit.void);
      expect(cleaned.toSorted()).toEqual(["first", "second"]);
      expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true);
      expect(Exit.isFailure(yield* Fiber.await(second))).toBe(true);
    }),
  ),
);

it.effect("closing the observation caller Scope joins its send without stopping other owners", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { observer, publish } = yield* fixture();
      const callerScope = yield* observedScope;
      const send = yield* barrier;
      const cleaned = yield* Deferred.make<void>();
      const run = yield* observer
        .withObservation(
          identity,
          send.wait.pipe(Effect.ensuring(Deferred.succeed(cleaned, undefined))),
        )
        .pipe(Effect.provideService(Scope.Scope, callerScope), Effect.forkChild);
      yield* Deferred.await(send.entered);
      yield* Scope.close(callerScope, Exit.void);
      expect(yield* Deferred.isDone(cleaned)).toBe(true);
      expect(run.pollUnsafe()).toBeDefined();
      const next = { ...identity, turnId: TurnId.make("other-owner") };
      expect(
        (yield* observer.withObservation(next, publish({ ...completed(), turnId: next.turnId })))
          .event.turnId,
      ).toBe("other-owner");
    }),
  ),
);

for (const maximumPending of [0, -1, 129, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  it.effect(`refuses invalid pending capacity ${maximumPending} before subscribing`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProjectTeamTurnPublication>();
        let subscriptions = 0;
        const exit = yield* Effect.exit(
          makeProjectTeamTurnObserver({
            subscribe: Effect.sync(() => {
              subscriptions++;
            }).pipe(Effect.andThen(PubSub.subscribe(events))),
            currentPublicationSequence: () => 0n,
            maximumPending,
          }),
        );
        expect(codes(exit)).toEqual(["invalid-capacity"]);
        expect(subscriptions).toBe(0);
      }),
    ),
  );
}
