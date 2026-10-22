import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProjectWorkTaskId,
  type ProjectWorkStreamItem,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { ProjectWorkEventBusLive } from "./ProjectWorkEventBus.ts";
import { ProjectWorkRepository, ProjectWorkRepositoryLive } from "./ProjectWorkRepository.ts";
import { ProjectWorkStream, ProjectWorkStreamLive } from "./ProjectWorkStream.ts";

const at = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("stream-project");
const foreignProjectId = ProjectId.make("foreign-project");
const layer = Layer.mergeAll(ProjectWorkRepositoryLive, ProjectWorkStreamLive).pipe(
  Layer.provideMerge(ProjectWorkEventBusLive),
  Layer.provideMerge(ProjectStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory))),
);
const seed = Effect.fn("ProjectWorkStreamTest.seed")(function* (id: ProjectId) {
  const projects = yield* ProjectStore.ProjectStoreV2;
  yield* projects.apply({
    sequence: 1,
    eventId: EventId.make(`create-${id}`),
    aggregateKind: "project",
    aggregateId: id,
    occurredAt: at,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId: id,
      title: id,
      workspaceRoot: `/tmp/${id}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: at,
      updatedAt: at,
    },
  });
});
const append = Effect.fn("ProjectWorkStreamTest.append")(function* (id: ProjectId, index: number) {
  const repo = yield* ProjectWorkRepository;
  return yield* repo.execute({
    type: "project-work.task.create",
    projectId: id,
    commandId: CommandId.make(`create-${index}`),
    taskId: ProjectWorkTaskId.make(`${id}-${index}`),
    title: `Task ${index}`,
    createdAt: at,
  });
});

it.effect(
  "coalesces hints without blocking writes and replays all deltas after a slow reader resumes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(projectId);
        yield* seed(foreignProjectId);
        const service = yield* ProjectWorkStream;
        const ready = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const stream = yield* service.stream({
          projectId,
          requestCompletionMarker: true,
          limit: 4,
        });
        const consumer = yield* stream.pipe(
          Stream.tap((item) =>
            item.kind === "synchronized"
              ? Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(resume)))
              : Effect.void,
          ),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(ready);
        const first = yield* append(projectId, 1);
        const second = yield* append(projectId, 2);
        // The sole retained hint belongs to another project; it must still wake this replay.
        yield* append(foreignProjectId, 3);
        yield* Deferred.succeed(resume, undefined);
        const items = yield* Fiber.join(consumer);
        const ids = items.flatMap((item) => (item.kind === "delta" ? [item.delta.eventId] : []));
        assert.deepStrictEqual(ids, [first.events[0]?.eventId, second.events[0]?.eventId]);
        assert.equal(items.length, 3);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect(
  "reports an explicit resync head when coalesced durable history exceeds the replay bound",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(projectId);
        yield* seed(foreignProjectId);
        const service = yield* ProjectWorkStream;
        const ready = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const stream = yield* service.stream({
          projectId,
          requestCompletionMarker: true,
          limit: 1,
        });
        const consumer = yield* stream.pipe(
          Stream.tap((item) =>
            item.kind === "synchronized"
              ? Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(resume)))
              : Effect.void,
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(ready);
        yield* append(projectId, 1);
        yield* append(projectId, 2);
        yield* append(foreignProjectId, 3);
        yield* Deferred.succeed(resume, undefined);
        const items = yield* Fiber.join(consumer);
        const marker = items[1];
        assert.deepStrictEqual(marker, {
          kind: "resync-required",
          projectId,
          cursor: 2,
          reason: "replay-too-large",
        } satisfies ProjectWorkStreamItem);
        // A resubscription from that head has no duplicate historical delta.
        const resumed = yield* service.stream({
          projectId,
          afterCursor: 2,
          requestCompletionMarker: true,
        });
        assert.deepStrictEqual(yield* resumed.pipe(Stream.take(1), Stream.runCollect), [
          { kind: "synchronized", projectId, cursor: 2 },
        ]);
      }),
    ).pipe(Effect.provide(layer)),
);
