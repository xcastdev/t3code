import * as Schema from "effect/Schema";
import { ProjectTeamRecord, EventId, ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boundProjectWorkReplay, projectWorkDeltaForEvent } from "./ProjectWorkStream.ts";
import type { ProjectWorkEvent } from "./ProjectWorkDecider.ts";

const decodeTeamRecord = Schema.decodeUnknownSync(ProjectTeamRecord);

const projectId = ProjectId.make("stream-project");
const event = {
  eventId: EventId.make("work-event-1"),
  projectId,
  revision: 4,
  occurredAt: "2026-01-01T00:00:00.000Z",
  type: "project-work.task.created" as const,
  task: {
    taskId: ProjectWorkTaskId.make("task-1"),
  },
} as unknown as ProjectWorkEvent;

describe("ProjectWorkStream", () => {
  it("maps work events to bounded deltas without entering legacy event unions", () => {
    expect(projectWorkDeltaForEvent(event, 19)).toEqual({
      projectId,
      cursor: 19,
      eventId: event.eventId,
      kind: "task",
      recordId: "task-1",
      revision: 4,
      deleted: false,
    });
  });

  it("resumes after unrelated global-log rows without renumbering the cursor", () => {
    const first = projectWorkDeltaForEvent(event, 19);
    const second = projectWorkDeltaForEvent(
      { ...event, eventId: EventId.make("work-event-2"), revision: 5 },
      27,
    );
    const replay = boundProjectWorkReplay({
      afterCursor: 18,
      headCursor: 27,
      rows: [
        { cursor: 19, delta: first },
        { cursor: 27, delta: second },
      ],
      limit: 2,
    });
    expect(replay.resync).toBeNull();
    expect(replay.cursor).toBe(27);
    expect(replay.deltas.map((delta) => delta.cursor)).toEqual([19, 27]);
  });

  it("forces a resync for an impossible or oversized cursor range", () => {
    const delta = projectWorkDeltaForEvent(event, 4);
    expect(boundProjectWorkReplay({ afterCursor: 8, headCursor: 4, rows: [] }).resync).toBe(
      "cursor-ahead",
    );
    expect(
      boundProjectWorkReplay({
        afterCursor: 0,
        headCursor: 4,
        rows: [
          { cursor: 4, delta },
          { cursor: 5, delta: { ...delta, cursor: 5 } },
        ],
        limit: 1,
      }).resync,
    ).toBe("replay-too-large");
  });
});

it("invalidates foundation record IDs with a legacy kind and advances durable cursor", () => {
  const record = decodeTeamRecord({
    kind: "mission",
    recordId: "mission-1",
    projectId,
    revision: 0,
    generation: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "draft",
    title: "Mission",
    objective: "Bounded",
    requiredTaskIds: [],
  });
  const delta = projectWorkDeltaForEvent(
    { ...event, type: "project-work.foundation.recorded", record },
    28,
  );
  expect(delta.kind).toBe("task");
  expect(delta.recordId).toBe("mission-1");
  expect(
    boundProjectWorkReplay({ afterCursor: 27, headCursor: 28, rows: [{ cursor: 28, delta }] })
      .cursor,
  ).toBe(28);
});

import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  seed as seedTeam,
  decodeRecord,
  attribution,
  at,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import { ProjectWorkRepositoryLive } from "./ProjectWorkRepository.ts";
import { ProjectWorkStream, ProjectWorkStreamLive } from "./ProjectWorkStream.ts";
import { ProjectWorkEventBusLive } from "./ProjectWorkEventBus.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
const managedStreamLayer = Layer.mergeAll(ProjectWorkRepositoryLive, ProjectWorkStreamLive).pipe(
  Layer.provideMerge(Authorization.layer),
  Layer.provideMerge(ProjectWorkEventBusLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);
effectIt.effect(
  "filters initial and live managed deltas and stops an open subscription on durable revocation",
  () =>
    Effect.gen(function* () {
      const f = yield* seedTeam("coordinator");
      const source = decodeRecord({
        kind: "memory-source",
        projectId: f.principal.managed.projectId,
        recordId: "hidden-memory",
        revision: 0,
        generation: 0,
        updatedAt: at,
        status: "current",
        sourceKind: "finding",
        sourceId: "finding",
        sourceRevision: 0,
        content: "hidden",
        contentHash: "hash",
        attribution,
        sharedWithProjectIds: [],
      });
      yield* f.change(source);
      const service = yield* ProjectWorkStream;
      const synchronized = yield* Deferred.make<void>();
      const memberDelivered = yield* Deferred.make<void>();
      const received: string[] = [];
      const stream = yield* service.stream(
        { projectId: f.principal.managed.projectId, requestCompletionMarker: true },
        f.principal,
      );
      const fiber = yield* stream.pipe(
        Stream.runForEach((item) =>
          Effect.gen(function* () {
            if (item.kind === "synchronized") {
              yield* Deferred.succeed(synchronized, undefined);
              return;
            }
            if (item.kind === "delta") {
              received.push(item.delta.recordId);
              if (item.delta.recordId === "member" && item.delta.revision > 10)
                yield* Deferred.succeed(memberDelivered, undefined);
            }
          }),
        ),
        Effect.result,
        Effect.forkScoped,
      );
      yield* Deferred.await(synchronized);
      expect(received).not.toContain("hidden-memory");
      expect(received).not.toContain("role");
      yield* f.change(
        decodeRecord({ ...source, revision: 1, generation: 1, content: "still hidden" }),
      );
      yield* f.change(decodeRecord({ ...f.member, revision: 1, name: "Updated member" }));
      yield* Deferred.await(memberDelivered);
      expect(received).not.toContain("hidden-memory");
      yield* f.change(
        decodeRecord({ ...f.binding, revision: f.binding.revision + 1, status: "revoked" }),
      );
      const result = yield* Fiber.join(fiber);
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(Layer.fresh(managedStreamLayer))),
);
