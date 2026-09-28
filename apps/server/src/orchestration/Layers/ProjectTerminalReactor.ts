import { type OrchestrationEvent } from "@t3tools/contracts";
import { TerminalToolError } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { forkParked } from "../../serverActivation.ts";
import { ProjectTerminalService } from "../../terminal/ProjectTerminalService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectTerminalReactor,
  type ProjectTerminalReactorShape,
} from "../Services/ProjectTerminalReactor.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";

type ProjectDeletedEvent = Extract<OrchestrationEvent, { readonly type: "project.deleted" }>;

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const projectTerminals = yield* ProjectTerminalService;
  const receipts = yield* RuntimeReceiptBus;

  const processProjectDeleted = Effect.fn("ProjectTerminalReactor.processProjectDeleted")(
    function* (event: ProjectDeletedEvent) {
      yield* projectTerminals.closeProject(event.payload.projectId);
      yield* receipts.publish({
        type: "project.terminals.closed",
        projectId: event.payload.projectId,
        sequence: event.sequence,
      });
    },
  );

  const cleanupFailures = yield* Ref.make(new Map<number, Cause.Cause<TerminalToolError>>());
  const processSafely = (event: ProjectDeletedEvent) =>
    processProjectDeleted(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
        return Ref.update(cleanupFailures, (failures) => {
          const next = new Map(failures);
          next.set(event.sequence, cause);
          return next;
        }).pipe(
          Effect.andThen(
            Effect.logWarning("project terminal cleanup failed", {
              projectId: event.payload.projectId,
              sequence: event.sequence,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }),
    );

  const worker = yield* makeDrainableWorker(processSafely);
  const seenSequence = yield* SubscriptionRef.make(0);
  const noteSeen = (sequence: number) =>
    SubscriptionRef.update(seenSequence, (seen) => Math.max(seen, sequence));

  const start: ProjectTerminalReactorShape["start"] = Effect.fn("ProjectTerminalReactor.start")(
    function* () {
      const initialSequence = yield* engine.latestSequence;
      // Acquire the hot subscription before parking at server activation. A
      // project deletion committed during startup must stay buffered until the
      // consumer resumes.
      const domainEvents = yield* engine.subscribeDomainEvents;
      yield* noteSeen(initialSequence);
      yield* forkParked(
        Stream.runForEach(domainEvents, (event) =>
          (event.type === "project.deleted" ? worker.enqueue(event) : Effect.void).pipe(
            Effect.andThen(noteSeen(event.sequence)),
          ),
        ),
      );
    },
  );

  const drainThrough: ProjectTerminalReactorShape["drainThrough"] = Effect.fn(
    "ProjectTerminalReactor.drainThrough",
  )(function* (sequence) {
    yield* SubscriptionRef.changes(seenSequence).pipe(
      Stream.filter((seen) => seen >= sequence),
      Stream.runHead,
    );
    yield* worker.drain;
    const failure = yield* Ref.get(cleanupFailures).pipe(
      Effect.map(
        (failures) =>
          [...failures.entries()]
            .filter(([failedSequence]) => failedSequence <= sequence)
            .toSorted(([left], [right]) => left - right)[0]?.[1],
      ),
    );
    if (failure) return yield* Effect.failCause(failure);
  });

  const drain: ProjectTerminalReactorShape["drain"] = engine.latestSequence.pipe(
    Effect.flatMap(drainThrough),
  );

  return { start, drainThrough, drain } satisfies ProjectTerminalReactorShape;
});

export const ProjectTerminalReactorLive = Layer.effect(ProjectTerminalReactor, make);
