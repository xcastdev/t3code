import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as ProjectWorkEventBus from "./ProjectWorkEventBus.ts";
import * as ProjectWorkLeaseReactor from "./ProjectWorkLeaseReactor.ts";
import * as ProjectWorkRepository from "./ProjectWorkRepository.ts";
import * as ProjectWorkStream from "./ProjectWorkStream.ts";
import type { ProjectWorkEvent } from "./ProjectWorkDecider.ts";

export const runProjectWorkLeaseWorker = (
  reactor: ProjectWorkLeaseReactor.ProjectWorkLeaseReactorShape,
  interval: Duration.Input = "30 seconds",
  onSweepComplete: (events: ReadonlyArray<ProjectWorkEvent>) => Effect.Effect<void> = () =>
    Effect.void,
) =>
  Effect.suspend(() =>
    DateTime.now.pipe(
      Effect.flatMap((now) => reactor.expire({ now: DateTime.formatIso(now) })),
      Effect.catchCause((cause) =>
        Effect.logWarning("project-work lease sweep failed", cause).pipe(Effect.as([])),
      ),
      Effect.tap(onSweepComplete),
    ),
  ).pipe(Effect.repeat(Schedule.spaced(interval)));

/** One memoized repository and event bus shared by commands, streams, and workers. */
export const coreLayer = Layer.mergeAll(
  ProjectWorkEventBus.ProjectWorkEventBusLive,
  ProjectWorkRepository.ProjectWorkRepositoryLive.pipe(
    Layer.provide(ProjectWorkEventBus.ProjectWorkEventBusLive),
  ),
  ProjectWorkStream.ProjectWorkStreamLive.pipe(
    Layer.provide(ProjectWorkEventBus.ProjectWorkEventBusLive),
  ),
);

export const leaseLayer = ProjectWorkLeaseReactor.ProjectWorkLeaseReactorLive.pipe(
  Layer.provide(coreLayer),
);

/** Startup drain is non-blocking; the scoped fiber is interrupted with the server layer. */
export const leaseWorkerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* ProjectWorkLeaseReactor.ProjectWorkLeaseReactor;
    yield* Effect.forkScoped(runProjectWorkLeaseWorker(reactor));
  }),
).pipe(Layer.provide(leaseLayer));
