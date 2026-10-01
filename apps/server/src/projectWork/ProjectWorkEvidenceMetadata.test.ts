import { CommandId, ProjectId, ProjectWorkEvidenceId, ProjectWorkTaskId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runForkMigrations, runMigrations } from "../persistence/Migrations.ts";
import { ProjectWorkProjection, ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";
import { ProjectWorkQuery, ProjectWorkQueryLive } from "./ProjectWorkQuery.ts";
import { ProjectWorkRepository, ProjectWorkRepositoryLive } from "./ProjectWorkRepository.ts";

const at = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("metadata-project");
const taskId = ProjectWorkTaskId.make("metadata-task");
const evidenceId = ProjectWorkEvidenceId.make("metadata-evidence");
const evidence = {
  evidenceId,
  taskId,
  kind: "observation" as const,
  summary: "Report",
  detail: "Retained report",
  recordedAt: at,
  revision: 0,
};
const services = Layer.mergeAll(
  ProjectWorkRepositoryLive,
  ProjectWorkProjectionLive,
  ProjectWorkQueryLive,
);

it.layer(NodeSqliteClient.layerMemory())("evidence metadata SQL", (it) => {
  it.effect(
    "upgrades old normalized rows from retained events and preserves metadata through rebuild",
    () =>
      Effect.gen(function* () {
        yield* runMigrations({ toForkMigrationInclusive: 20 });
        const repository = yield* ProjectWorkRepository;
        const query = yield* ProjectWorkQuery;
        const projection = yield* ProjectWorkProjection;
        const sql = yield* SqlClient.SqlClient;
        yield* repository.execute({
          type: "project-work.task.create",
          commandId: CommandId.make("metadata-create"),
          projectId,
          taskId,
          title: "Task",
          createdAt: at,
        });
        yield* repository.execute({
          type: "project-work.evidence.add",
          commandId: CommandId.make("metadata-add"),
          projectId,
          addedAt: at,
          evidence,
        });
        expect((yield* query.listEvidence({ projectId }))[0]).not.toHaveProperty("scopeHash");
        expect((yield* projection.state(projectId)).evidence[0]).not.toHaveProperty(
          "outputArtifactIds",
        );
        // Model the old binary: typed metadata survived in events but not normalized rows.
        yield* sql`UPDATE project_work_events SET payload_json = json_set(payload_json,
      '$.evidence.scopeHash', ${"a".repeat(64)}, '$.evidence.outputArtifactIds', json(${'["artifact-1"]'}))
      WHERE project_id = ${projectId} AND event_type = 'project-work.evidence.added'`;
        const logBefore = yield* repository.replay(projectId);
        yield* runForkMigrations(21);
        const expected = {
          ...evidence,
          scopeHash: "a".repeat(64),
          outputArtifactIds: ["artifact-1"],
        };
        expect(yield* query.listEvidence({ projectId })).toEqual([expected]);
        expect((yield* projection.state(projectId)).evidence).toEqual([expected]);
        yield* sql`DELETE FROM project_work_evidence WHERE project_id = ${projectId}`;
        yield* projection.rebuild(projectId);
        expect(yield* query.listEvidence({ projectId })).toEqual([expected]);
        expect((yield* projection.state(projectId)).evidence).toEqual([expected]);
        expect(yield* repository.replay(projectId)).toEqual(logBefore);
        yield* runForkMigrations(21);
        expect(yield* query.listEvidence({ projectId })).toEqual([expected]);
      }).pipe(Effect.provide(services)),
  );

  it.effect("retains new scoped reports, empty links and exact duplicate receipts", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 21 });
      const repository = yield* ProjectWorkRepository;
      const query = yield* ProjectWorkQuery;
      const projection = yield* ProjectWorkProjection;
      const currentProject = ProjectId.make("new-metadata-project");
      const currentTask = ProjectWorkTaskId.make("new-metadata-task");
      yield* repository.execute({
        type: "project-work.task.create",
        commandId: CommandId.make("new-metadata-create"),
        projectId: currentProject,
        taskId: currentTask,
        title: "Task",
        createdAt: at,
      });
      const scoped = {
        ...evidence,
        evidenceId: ProjectWorkEvidenceId.make("new-metadata-evidence"),
        taskId: currentTask,
        scopeHash: "b".repeat(64),
        outputArtifactIds: [],
      };
      const command = {
        type: "project-work.evidence.add" as const,
        commandId: CommandId.make("new-metadata-add"),
        projectId: currentProject,
        evidence: scoped,
        addedAt: at,
      };
      const first = yield* repository.execute(command);
      expect(yield* repository.execute(command)).toEqual({ ...first, duplicate: true });
      expect(yield* query.listEvidence({ projectId: currentProject })).toEqual([scoped]);
      expect((yield* projection.state(currentProject)).evidence).toEqual([scoped]);
      yield* projection.rebuild(currentProject);
      expect(yield* query.listEvidence({ projectId: currentProject })).toEqual([scoped]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("rejects corrupt metadata in both read paths instead of dropping it", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 21 });
      const repository = yield* ProjectWorkRepository;
      const query = yield* ProjectWorkQuery;
      const projection = yield* ProjectWorkProjection;
      const sql = yield* SqlClient.SqlClient;
      const currentProject = ProjectId.make("corrupt-metadata-project");
      const corruptTask = ProjectWorkTaskId.make("corrupt-metadata-task");
      yield* repository.execute({
        type: "project-work.task.create",
        commandId: CommandId.make("corrupt-task-create"),
        projectId: currentProject,
        taskId: corruptTask,
        title: "Task",
        createdAt: at,
      });
      yield* repository.execute({
        type: "project-work.evidence.add",
        commandId: CommandId.make("corrupt-metadata-add"),
        projectId: currentProject,
        addedAt: at,
        evidence: {
          ...evidence,
          taskId: corruptTask,
          evidenceId: ProjectWorkEvidenceId.make("corrupt-metadata-evidence"),
        },
      });
      yield* sql`UPDATE project_work_evidence SET output_artifact_ids_json = ${"[42]"} WHERE project_id = ${currentProject}`;
      expect((yield* Effect.exit(query.listEvidence({ projectId: currentProject })))._tag).toBe(
        "Failure",
      );
      expect((yield* Effect.exit(projection.state(currentProject)))._tag).toBe("Failure");
    }).pipe(Effect.provide(services)),
  );
});
