import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { ProjectWorkEvent } from "./ProjectWorkDecider.ts";

/** A committed work event with its durable, global work-log cursor. */
export interface ProjectWorkCommittedEvent {
  readonly cursor: number;
  readonly event: ProjectWorkEvent;
}

export interface ProjectWorkEventBusShape {
  /** Publish only after the SQL transaction that wrote the event commits. */
  readonly publish: (events: ReadonlyArray<ProjectWorkCommittedEvent>) => Effect.Effect<void>;
  readonly subscribe: Effect.Effect<Stream.Stream<ProjectWorkCommittedEvent>, never, Scope.Scope>;
}

export class ProjectWorkEventBus extends Context.Service<
  ProjectWorkEventBus,
  ProjectWorkEventBusShape
>()("t3/projectWork/ProjectWorkEventBus") {}

const makeProjectWorkEventBus = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<ProjectWorkCommittedEvent>();
  const bus = {
    publish: (events) =>
      Effect.forEach(events, (event) => PubSub.publish(pubsub, event), { discard: true }),
    subscribe: PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription)),
  } satisfies ProjectWorkEventBusShape;
  return bus;
});

export const ProjectWorkEventBusLive = Layer.effect(ProjectWorkEventBus, makeProjectWorkEventBus);
