import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ProjectId, ProjectMemorySource, canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { assertProjectMemoryDeletionReadyInTransaction } from "./ProjectMemoryProjectDeletion.ts";
import { emptyProjectWorkReducerState } from "../ProjectWorkDecider.ts";
import { readCurrentState } from "../ProjectWorkRepository.ts";
import { PROJECT_WORK_CHECKPOINT_VERSION } from "../ProjectTeamsPersistence.ts";
import { projectMemoryHash } from "./ProjectMemoryService.ts";

const decodeSource = Schema.decodeUnknownEffect(ProjectMemorySource);

it.effect("refuses retained checkpoint memory whose source and original history are missing", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("checkpoint-memory-project");
    const at = "2026-10-08T00:00:00.000Z";
    const source = yield* decodeSource({
      kind: "memory-source",
      recordId: "checkpoint-source",
      projectId,
      revision: 0,
      generation: 0,
      updatedAt: at,
      status: "current",
      sourceKind: "finding",
      sourceId: "lost-comment",
      sourceRevision: 0,
      content: "Retained source before its history was lost.",
      contentHash: projectMemoryHash("Retained source before its history was lost."),
      attribution: {
        actor: { kind: "system", id: "checkpoint-fixture" },
        source: { kind: "system", id: "checkpoint-fixture" },
        recordedAt: at,
      },
      sharedWithProjectIds: [],
    });
    // This derived snapshot supplies no cleanup authority. The actual reader
    // nevertheless retains its typed record after physical/history loss.
    const checkpoint = {
      ...emptyProjectWorkReducerState(projectId),
      checkpointVersion: PROJECT_WORK_CHECKPOINT_VERSION,
      foundationRecords: [source],
    };
    yield* sql`INSERT INTO project_work_reducer_checkpoints VALUES (${projectId},0,${canonicalProjectWorkPayload(checkpoint)},${at})`;
    expect((yield* readCurrentState(sql, projectId)).foundationRecords).toEqual([source]);
    expect(yield* sql`SELECT * FROM project_team_memory_source`).toEqual([]);
    expect(yield* sql`SELECT * FROM project_work_events`).toEqual([]);
    const before = yield* sql`SELECT * FROM project_work_reducer_checkpoints`;
    expect(
      yield* sql
        .withTransaction(
          assertProjectMemoryDeletionReadyInTransaction(sql, projectId, "actual-host"),
        )
        .pipe(Effect.result),
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProjectMemoryServiceError" },
    });
    expect(yield* sql`SELECT * FROM project_work_reducer_checkpoints`).toEqual(before);
    // An unsupported derived version is ignored by the same authority reader;
    // its stale payload must not impose memory limits on ordinary empty work.
    yield* sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,'$.checkpointVersion',-1)
      WHERE project_id=${projectId}`;
    expect((yield* readCurrentState(sql, projectId)).foundationRecords).toEqual([]);
    yield* sql.withTransaction(
      assertProjectMemoryDeletionReadyInTransaction(sql, projectId, undefined),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("refuses orphaned physical memory without treating an empty foundation as cleanup", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("orphaned-memory-project");
    yield* sql.withTransaction(
      assertProjectMemoryDeletionReadyInTransaction(sql, projectId, undefined),
    );
    // A legal physical journal row simulates lost authority. It supplies no
    // task, backend outcome or permission to clean up the orphan.
    yield* sql`INSERT INTO project_team_memory_manifest VALUES
      ('orphaned-extraction','actual-host',${projectId},'orphaned-source',0,0,'{}')`;
    const before = yield* sql`SELECT * FROM project_team_memory_manifest`;
    const denied = yield* sql
      .withTransaction(assertProjectMemoryDeletionReadyInTransaction(sql, projectId, "actual-host"))
      .pipe(Effect.result);
    expect(denied).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProjectMemoryServiceError" },
    });
    expect(yield* sql`SELECT * FROM project_team_memory_manifest`).toEqual(before);
    expect(yield* sql`SELECT * FROM project_team_memory_outcome`).toEqual([]);
    expect(yield* sql`SELECT * FROM project_work_command_receipts`).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
