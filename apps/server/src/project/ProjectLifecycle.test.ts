import { CommandId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runForkMigrations, runMigrations } from "../persistence/Migrations.ts";

import {
  ProjectLifecycle,
  ProjectLifecycleError,
  ProjectLifecycleLive,
  relocationDecision,
} from "./ProjectLifecycle.ts";

const lifecycleLayer = ProjectLifecycleLive.pipe(
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
  Layer.provideMerge(FileSystem.layerNoop({})),
);

describe("ProjectLifecycle", () => {
  it("requires a real directory and rejects a repository identity mismatch", () => {
    expect(
      relocationDecision({
        currentWorkspaceRoot: "/workspace/old",
        candidateWorkspaceRoot: "/workspace/new",
        candidateExists: false,
        candidateIsDirectory: false,
      }),
    ).toEqual({ allowed: false, reason: "missing-path" });
    expect(
      relocationDecision({
        currentWorkspaceRoot: "/workspace/old",
        candidateWorkspaceRoot: "/workspace/new",
        candidateExists: true,
        candidateIsDirectory: true,
        expectedRepositoryKey: "github:owner/repo",
        actualRepositoryKey: "github:other/repo",
      }),
    ).toEqual({ allowed: false, reason: "repository-mismatch" });
  });

  it("allows an explicit move while preserving the project identity", () => {
    expect(
      relocationDecision({
        currentWorkspaceRoot: "/workspace/old",
        candidateWorkspaceRoot: "/workspace/new",
        candidateExists: true,
        candidateIsDirectory: true,
        expectedRepositoryKey: "github:owner/repo",
        actualRepositoryKey: "github:owner/repo",
      }),
    ).toEqual({ allowed: true });
  });

  it("does not turn a relink into a no-op or silently accept the same path", () => {
    expect(
      relocationDecision({
        currentWorkspaceRoot: "/workspace/project/",
        candidateWorkspaceRoot: "/workspace/project",
        candidateExists: true,
        candidateIsDirectory: true,
      }),
    ).toEqual({ allowed: false, reason: "same-path" });
  });

  it("keeps a tombstone while purging local work rows and makes deletion retries idempotent", async () => {
    const projectId = ProjectId.make("deleted-project");
    const commandId = CommandId.make("delete-command");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const lifecycle = yield* ProjectLifecycle;
        yield* runMigrations();
        yield* runForkMigrations(13);
        yield* sql`
          INSERT INTO projection_projects
            (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES
            (${String(projectId)}, 'Deleted project', '/workspace/deleted', '[]',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
        `;
        yield* sql`
          INSERT INTO project_work_events
            (event_id, project_id, event_type, occurred_at, command_id, payload_json)
          VALUES
            ('event-delete-1', ${String(projectId)}, 'project-work.task.created',
              '2026-01-01T00:00:00.000Z', 'command-work-1', '{}')
        `;
        yield* sql`
          INSERT INTO project_work_reducer_checkpoints
            (project_id, last_sequence, state_json, updated_at)
          VALUES (${String(projectId)}, 1, '{}', '2026-01-01T00:00:00.000Z')
        `;

        const first = yield* lifecycle.permanentDelete({
          commandId,
          projectId,
          workspaceRoot: "/workspace/deleted",
          confirmation: "permanent-local-delete",
        });
        const eventRows = yield* sql`
          SELECT event_id FROM project_work_events WHERE project_id = ${String(projectId)}
        `;
        const checkpointRows = yield* sql`
          SELECT project_id FROM project_work_reducer_checkpoints
          WHERE project_id = ${String(projectId)}
        `;
        const tombstoneRows = yield* sql<{
          readonly state: string;
          readonly tombstoneJson: string;
        }>`
          SELECT state, tombstone_json AS tombstoneJson
          FROM project_lifecycle WHERE project_id = ${String(projectId)}
        `;
        const retry = yield* lifecycle.permanentDelete({
          commandId,
          projectId,
          workspaceRoot: "/workspace/deleted",
          confirmation: "permanent-local-delete",
        });
        const blocked = yield* Effect.result(
          lifecycle.permanentDelete({
            commandId: CommandId.make("delete-command-2"),
            projectId,
            workspaceRoot: "/workspace/deleted",
            confirmation: "permanent-local-delete",
          }),
        );

        return { first, retry, eventRows, checkpointRows, tombstoneRows, blocked };
      }).pipe(Effect.provide(lifecycleLayer)),
    );

    expect(result.eventRows).toEqual([]);
    expect(result.checkpointRows).toEqual([]);
    expect(result.tombstoneRows[0]?.state).toBe("tombstoned");
    expect(result.tombstoneRows[0]?.tombstoneJson).toContain("permanent-local-delete");
    expect(result.retry).toEqual(result.first);
    expect(result.blocked._tag).toBe("Failure");
    if (result.blocked._tag === "Failure") {
      const failure = result.blocked.failure;
      expect(Schema.is(ProjectLifecycleError)(failure)).toBe(true);
      if (Schema.is(ProjectLifecycleError)(failure)) {
        expect(failure.reason).toBe("tombstoned");
      }
    }
    expect(result.first.externalDataPreserved).toBe(true);
    expect(result.first.filesDeleted).toBe(false);
  });

  it("treats a legacy projection deletion as an effective tombstone without rewriting durable coordinates", async () => {
    const projectId = ProjectId.make("effective-tombstone-project");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const lifecycle = yield* ProjectLifecycle;
        yield* runMigrations();
        yield* runForkMigrations(12);
        yield* sql`
          INSERT INTO projection_projects
            (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
          VALUES (${String(projectId)}, 'Deleted projection', '/workspace/projection', '[]',
            '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z',
            '2026-01-03T00:00:00.000Z')
        `;
        yield* sql`
          INSERT INTO project_lifecycle
            (project_id, state, workspace_root, repository_key, revision, changed_at)
          VALUES (${String(projectId)}, 'active', '/workspace/durable', 'github:owner/repo', 4,
            '2026-01-02T00:00:00.000Z')
        `;

        const project = yield* lifecycle.get(projectId);
        const rows = yield* sql<Record<string, unknown>>`
          SELECT state, workspace_root AS workspaceRoot, repository_key AS repositoryKey
          FROM project_lifecycle WHERE project_id = ${String(projectId)}
        `;
        return { project, row: rows[0] };
      }).pipe(Effect.provide(lifecycleLayer)),
    );

    expect(result.project).toMatchObject({
      state: "tombstoned",
      workspaceRoot: "/workspace/durable",
      repositoryKey: "github:owner/repo",
      revision: 4,
    });
    expect(result.row).toEqual({
      state: "active",
      workspaceRoot: "/workspace/durable",
      repositoryKey: "github:owner/repo",
    });
  });

  it("permanently deletes archived and legacy-deleted projects before fencing new tombstoned commands", async () => {
    const archivedProjectId = ProjectId.make("archived-delete-project");
    const legacyProjectId = ProjectId.make("legacy-delete-project");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const lifecycle = yield* ProjectLifecycle;
        yield* runMigrations();
        yield* runForkMigrations(12);
        yield* sql`
          INSERT INTO projection_projects
            (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
          VALUES
            (${String(archivedProjectId)}, 'Archived', '/workspace/archived-delete', '[]',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL),
            (${String(legacyProjectId)}, 'Legacy deleted', '/workspace/legacy-delete', '[]',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
              '2026-01-02T00:00:00.000Z')
        `;
        yield* sql`
          INSERT INTO project_lifecycle
            (project_id, state, workspace_root, revision, changed_at)
          VALUES (${String(archivedProjectId)}, 'archived', '/workspace/archived-delete', 1,
            '2026-01-02T00:00:00.000Z')
        `;

        const archived = yield* lifecycle.permanentDelete({
          commandId: CommandId.make("archived-delete-command"),
          projectId: archivedProjectId,
          workspaceRoot: "/workspace/archived-delete",
          confirmation: "permanent-local-delete",
        });
        const legacyInput = {
          commandId: CommandId.make("legacy-delete-command"),
          projectId: legacyProjectId,
          workspaceRoot: "/workspace/legacy-delete",
          confirmation: "permanent-local-delete" as const,
        };
        const legacy = yield* lifecycle.permanentDelete(legacyInput);
        const replay = yield* lifecycle.permanentDelete(legacyInput);
        const fenced = yield* Effect.result(
          lifecycle.permanentDelete({
            ...legacyInput,
            commandId: CommandId.make("legacy-delete-command-2"),
          }),
        );
        return { archived, legacy, replay, fenced };
      }).pipe(Effect.provide(lifecycleLayer)),
    );

    expect(result.archived.tombstone?.reason).toBe("permanent-local-delete");
    expect(result.legacy.tombstone?.reason).toBe("legacy-project-delete");
    expect(result.replay).toEqual(result.legacy);
    expect(result.fenced._tag).toBe("Failure");
    if (
      result.fenced._tag === "Failure" &&
      Schema.is(ProjectLifecycleError)(result.fenced.failure)
    ) {
      expect(result.fenced.failure.reason).toBe("tombstoned");
    }
  });

  it("round-trips archive and restore through the durable lifecycle row", async () => {
    const projectId = ProjectId.make("archived-project");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const lifecycle = yield* ProjectLifecycle;
        yield* runMigrations();
        yield* runForkMigrations(12);
        yield* sql`
          INSERT INTO projection_projects
            (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES
            (${String(projectId)}, 'Archived project', '/workspace/archived', '[]',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
        `;
        const archived = yield* lifecycle.archive({
          commandId: CommandId.make("archive-command"),
          projectId,
          workspaceRoot: "/workspace/archived",
        });
        const restored = yield* lifecycle.restore({
          commandId: CommandId.make("restore-command"),
          projectId,
          workspaceRoot: "/workspace/archived",
        });
        const state = yield* lifecycle.get(projectId);
        return { archived, restored, state };
      }).pipe(Effect.provide(lifecycleLayer)),
    );

    expect(result.archived.project.state).toBe("archived");
    expect(result.restored.project.state).toBe("active");
    expect(result.state?.state).toBe("active");
  });

  it("rejects reuse of a lifecycle command id for a different request", async () => {
    const projectId = ProjectId.make("lifecycle-conflict-project");
    const commandId = CommandId.make("lifecycle-conflict-command");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const lifecycle = yield* ProjectLifecycle;
        yield* runMigrations();
        yield* runForkMigrations(12);
        yield* sql`
          INSERT INTO projection_projects
            (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES (${String(projectId)}, 'Conflict project', '/workspace/conflict', '[]',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
        `;
        yield* lifecycle.archive({ commandId, projectId, workspaceRoot: "/workspace/conflict" });
        return yield* Effect.result(
          lifecycle.restore({ commandId, projectId, workspaceRoot: "/workspace/conflict" }),
        );
      }).pipe(Effect.provide(lifecycleLayer)),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(Schema.is(ProjectLifecycleError)(result.failure)).toBe(true);
      if (Schema.is(ProjectLifecycleError)(result.failure)) {
        expect(result.failure.reason).toBe("operation-conflict");
      }
    }
  });
});
