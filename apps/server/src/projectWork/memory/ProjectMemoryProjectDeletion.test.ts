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
import { ProjectMemoryQueryOwner } from "./ProjectMemoryModelAccounting.ts";

const decodeSource = Schema.decodeUnknownEffect(ProjectMemorySource);
const decodeQueryOwner = Schema.decodeUnknownEffect(ProjectMemoryQueryOwner, {
  onExcessProperty: "error",
});

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

it.effect(
  "refuses pending query orphans and physical owner tuple drift without changing retained evidence",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const at = "2026-10-08T00:00:00.000Z";
      for (const drift of [
        "matching",
        "binding",
        "environment",
        "task",
        "generation",
        "operation",
        "command",
        "query",
      ] as const) {
        const projectId = ProjectId.make(`query-owner-${drift}`);
        const queryId = `query-${drift}`;
        const commandId = `query-command-${drift}`;
        // These immutable orphan rows carry no executing operation or cleanup
        // authority. Even a valid envelope must join its physical identity.
        const owner = yield* decodeQueryOwner({
          version: 2,
          kind: "query",
          operation: {
            version: 1,
            environmentId: "actual-host",
            projectId,
            taskId: "query-task",
            bindingId: "query-binding",
            generation: 0,
            providerInstanceId: "pi",
            threadId: "query-thread",
            operationId: "query-operation",
            workerId: "query-worker",
            ordinal: 0,
            attemptId: "query-attempt",
            rootBindingId: "query-root-binding",
            rootTaskId: "query-task",
            rootMaximumTokens: 1,
            rootDeadlineAtMs: 1,
            attemptMaximumTokens: 1,
            attemptDeadlineAtMs: 1,
            operationMaximumTokens: 1,
            operationDeadlineAtMs: 1,
            leaseDeadlineAtMs: 1,
            roleSha256: "0".repeat(64),
            configurationSha256: "0".repeat(64),
            requestSha256: "0".repeat(64),
            allocation: {
              version: 1,
              unit: "query-unexecuted-unit",
              nonce: "query-unexecuted-nonce",
              policy: { memoryBytes: 16777216, runtimeSeconds: 1 },
              launch: {
                workspaceRoot: "/fixture/unexecuted",
                workspace: { path: "/fixture/unexecuted", dev: 0, ino: 0 },
                protectedRoots: [],
                protectedWorkspaceEntries: [],
                runtimeFiles: [],
                argv: [],
                memoryBytes: 16777216,
                runtimeSeconds: 1,
              },
            },
          },
          request: {
            type: "project-team.memory.query",
            commandId,
            projectId,
            taskId: "query-task",
            expectedRevision: 0,
            expectedTaskRevision: 0,
            specRevision: 0,
            planRevision: 0,
            query: "Exact retained pending query",
          },
          configurationSha256: "0".repeat(64),
          taskScopeSha256: "0".repeat(64),
          intentFingerprint: "untrusted-orphan",
          actorId: "query-worker",
          sourceKind: "mcp",
          sourceId: "query-thread",
          admittedAt: at,
          admittedEffect: {
            kind: "effect",
            recordId: queryId,
            effectId: queryId,
            projectId,
            revision: 0,
            generation: 0,
            updatedAt: at,
            status: "pending",
            effectKind: "memory-query",
            targetId: commandId,
            payload: { recordIds: [], expectedRevision: 0 },
            claimGeneration: 0,
            availableAt: at,
          },
        });
        yield* sql`INSERT INTO project_team_memory_query
        (query_id,environment_id,project_id,task_id,binding_id,generation,operation_id,command_id,owner_json,status)
        VALUES (${drift === "query" ? `${queryId}-changed` : queryId},
          ${drift === "environment" ? "foreign-host" : owner.operation.environmentId},${projectId},
          ${drift === "task" ? "foreign-task" : owner.operation.taskId},
          ${drift === "binding" ? "foreign-binding" : owner.operation.bindingId},
          ${drift === "generation" ? 1 : owner.operation.generation},
          ${drift === "operation" ? "foreign-operation" : owner.operation.operationId},
          ${drift === "command" ? `${commandId}-changed` : commandId},
          ${canonicalProjectWorkPayload(owner)},'pending')`;
        const before = yield* sql`SELECT * FROM project_team_memory_query ORDER BY query_id`;
        const denied = yield* sql
          .withTransaction(
            assertProjectMemoryDeletionReadyInTransaction(sql, projectId, "actual-host"),
          )
          .pipe(Effect.result);
        expect(denied, drift).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ProjectMemoryServiceError" },
        });
        expect(
          yield* sql`SELECT * FROM project_team_memory_query ORDER BY query_id`,
          drift,
        ).toEqual(before);
        expect(yield* sql`SELECT * FROM project_work_command_receipts`, drift).toEqual([]);
        expect(yield* sql`SELECT * FROM project_team_model_request`, drift).toEqual([]);
      }
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
