import { EventId } from "@t3tools/contracts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Memory from "./ProjectMemoryService.ts";
import { layer, seed, scope, captureInput } from "./ProjectMemoryService.test-utils.ts";
import { sourceTuple } from "./ProjectMemoryRepository.ts";
it.effect("SQL recall remains current without any model or index and retraction is immediate", () =>
  Effect.gen(function* () {
    yield* seed();
    const memory = yield* Memory.ProjectMemoryService;
    const source = yield* memory.capture(captureInput());
    assert.equal((yield* memory.recallText({ ...scope, limit: 100, query: "focused" })).length, 1);
    yield* memory.retract(sourceTuple(scope, source));
    assert.deepStrictEqual(yield* memory.listCurrent({ ...scope, limit: 100 }), []);
    assert.equal((yield* Effect.result(memory.capture(captureInput())))._tag, "Failure");
    const sql = yield* SqlClient.SqlClient;
    assert.equal(
      (yield* sql`SELECT count(*) AS count FROM t3_workflow_v2_memory_cleanup WHERE status='pending'`)[0]
        ?.count,
      1,
    );
    assert.equal(
      (yield* Effect.result(memory.applyCurrent(sourceTuple(scope, source), () => Effect.void)))
        ._tag,
      "Failure",
    );
  }).pipe(Effect.provide(layer)),
);
it.effect("owner deletion retains cleanup identity and invalidates current sources", () =>
  Effect.gen(function* () {
    yield* seed();
    const memory = yield* Memory.ProjectMemoryService;
    const source = yield* memory.capture(captureInput());
    const projects = yield* ProjectStore.ProjectStoreV2;
    yield* projects.apply({
      sequence: 2,
      eventId: EventId.make("project-delete"),
      aggregateKind: "project",
      aggregateId: scope.owner.projectId,
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.deleted",
      payload: { projectId: scope.owner.projectId, deletedAt: "2026-01-01T00:00:00.000Z" },
    });
    yield* memory.deleteOwner(scope);
    assert.equal(
      (yield* Effect.result(memory.readSource(sourceTuple(scope, source))))._tag,
      "Failure",
    );
    const sql = yield* SqlClient.SqlClient;
    assert.equal(
      (yield* sql`SELECT count(*) AS count FROM t3_workflow_v2_memory_cleanup`)[0]?.count,
      1,
    );
  }).pipe(Effect.provide(layer)),
);
it.effect("rejects wrong implicit owner revision before touching sources or cleanup", () =>
  Effect.gen(function* () {
    yield* seed();
    const memory = yield* Memory.ProjectMemoryService;
    yield* memory.capture(captureInput());
    assert.equal(
      (yield* Effect.result(memory.deleteOwner({ ...scope, ownerRevision: 99 })))._tag,
      "Failure",
    );
    const sql = yield* SqlClient.SqlClient;
    assert.equal(
      (yield* sql`SELECT count(*) AS count FROM t3_workflow_v2_memory_sources WHERE status='current'`)[0]
        ?.count,
      1,
    );
    assert.equal(
      (yield* sql`SELECT count(*) AS count FROM t3_workflow_v2_memory_cleanup`)[0]?.count,
      0,
    );
  }).pipe(Effect.provide(layer)),
);
