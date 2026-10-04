import {
  canonicalProjectWorkPayload,
  ProjectId,
  ProjectTeamRecord,
  ProjectWorkTask,
  ProjectWorkTaskId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";
import type { ProjectTeamSchedulerPorts } from "./ProjectTeamScheduler.ts";

type ReadPorts = Pick<
  ProjectTeamSchedulerPorts<SqlError.SqlError | ProjectWorkPolicyError>,
  "readProjectPage" | "readProjectState"
>;
const Id = ProjectId.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256));
const TaskId = ProjectWorkTaskId.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
);
const Positive = Schema.Int.check(Schema.isGreaterThan(0));
const decodeProjectPage = Schema.decodeEffect(
  Schema.Struct({
    afterProjectId: Schema.optionalKey(Id),
    limit: Positive.check(Schema.isLessThanOrEqualTo(32)),
  }),
  { onExcessProperty: "error" },
);
const decodeTaskPage = Schema.decodeEffect(
  Schema.Struct({
    projectId: Id,
    afterTaskId: Schema.optionalKey(TaskId),
    limit: Positive.check(Schema.isLessThanOrEqualTo(64)),
  }),
  { onExcessProperty: "error" },
);
const decodeIds = Schema.decodeEffect(Schema.Array(Schema.Struct({ projectId: Id })));
const decodeTasks = Schema.decodeUnknownEffect(Schema.Array(ProjectWorkTask));
const decodeRecords = Schema.decodeUnknownEffect(Schema.Array(ProjectTeamRecord));
const invalid = (reason: string) => new ProjectWorkPolicyError("invalid-state", reason);

/** Priorities are project-wide across the configured model policies. Never select an
 * arbitrary record when current policy identities or effective priorities disagree. */
const readPolicy = Effect.fn("ProjectTeamSchedulingView.readPolicy")(function* (
  state: ProjectWorkReducerState,
  projectId: ProjectId,
) {
  if (state.projectId !== projectId)
    return yield* Effect.fail(invalid("Project authority identity differs"));
  const tasks = yield* decodeTasks(state.tasks).pipe(
    Effect.mapError(() => invalid("Malformed current project tasks")),
  );
  const taskIds = new Set<ProjectWorkTaskId>();
  for (const task of tasks) {
    if (task.projectId !== projectId || taskIds.has(task.taskId))
      return yield* Effect.fail(
        invalid("Current task identities are ambiguous or cross project boundaries"),
      );
    taskIds.add(task.taskId);
  }
  const records = yield* decodeRecords(state.foundationRecords ?? []).pipe(
    Effect.mapError(() => invalid("Malformed current project policy")),
  );
  const recordIds = new Set<string>();
  for (const record of records) {
    if (record.projectId !== projectId || recordIds.has(record.recordId))
      return yield* Effect.fail(
        invalid("Current policy identities are ambiguous or cross project boundaries"),
      );
    recordIds.add(record.recordId);
  }
  const configured = records
    .filter((record) => record.kind === "limits")
    .filter((record) => record.status === "configured");
  const models = new Set<string>();
  let signature: string | undefined;
  let policy:
    | { projectPriority: number; taskPriorities: Map<ProjectWorkTaskId, number> }
    | undefined;
  for (const limits of configured) {
    if (models.has(limits.model))
      return yield* Effect.fail(invalid("Duplicate configured model policies"));
    models.add(limits.model);
    const priorities = new Map<ProjectWorkTaskId, number>();
    for (const entry of limits.taskPriorities ?? []) {
      if (!taskIds.has(entry.taskId) || priorities.has(entry.taskId))
        return yield* Effect.fail(invalid("Task priorities require unique current project tasks"));
      priorities.set(entry.taskId, entry.priority);
    }
    const projectPriority = limits.projectPriority ?? 0;
    const current = canonicalProjectWorkPayload({
      projectPriority,
      taskPriorities: [...priorities]
        .filter(([, priority]) => priority !== 0)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      generation: limits.generation,
      providerInstanceId: limits.providerInstanceId ?? null,
      profileRecordIds:
        limits.profileRecordIds === undefined ? null : [...limits.profileRecordIds].sort(),
      environmentModelCalls: limits.environmentModelCalls,
      projectWritableWorkers: limits.projectWritableWorkers,
    });
    if (signature !== undefined && signature !== current)
      return yield* Effect.fail(invalid("Configured project scheduling policies disagree"));
    signature = current;
    policy = { projectPriority, taskPriorities: priorities };
  }
  return policy;
});

/** Selection reads own one SQL transaction each. The complete reducer state remains
 * authoritative; physical task and limits projections cannot supply cached authority. */
export const makeProjectTeamSchedulingView = Effect.fn("makeProjectTeamSchedulingView")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const readProjectPage = Effect.fn("ProjectTeamSchedulingView.readProjectPage")(function* (
      input: Parameters<ReadPorts["readProjectPage"]>[0],
    ) {
      const page = yield* decodeProjectPage(input).pipe(
        Effect.mapError(() => invalid("Invalid project keyset bounds")),
      );
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ projectId: ProjectId }>`SELECT project.project_id AS projectId
              FROM projection_projects AS project
              LEFT JOIN project_lifecycle AS lifecycle ON lifecycle.project_id = project.project_id
              WHERE project.deleted_at IS NULL
                AND (lifecycle.state IS NULL OR lifecycle.state = 'active')
                AND project.project_id > ${page.afterProjectId ?? ""}
              ORDER BY project.project_id ASC LIMIT ${page.limit}`;
          const ids = yield* decodeIds(rows).pipe(
            Effect.mapError(() => invalid("Malformed project keyset identities")),
          );
          return yield* Effect.forEach(ids, ({ projectId }) =>
            Effect.gen(function* () {
              const state = yield* readCurrentState(sql, projectId);
              const policy = yield* readPolicy(state, projectId);
              // Keep the full SQL window so disabled projects cannot shorten a keyset page.
              return { projectId, priority: policy?.projectPriority ?? 0 };
            }),
          );
        }),
      );
    });
    const readProjectState = Effect.fn("ProjectTeamSchedulingView.readProjectState")(function* (
      input: Parameters<ReadPorts["readProjectState"]>[0],
    ) {
      const page = yield* decodeTaskPage(input).pipe(
        Effect.mapError(() => invalid("Invalid task keyset bounds")),
      );
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const active = yield* sql`SELECT project.project_id FROM projection_projects AS project
              LEFT JOIN project_lifecycle AS lifecycle ON lifecycle.project_id = project.project_id
              WHERE project.project_id = ${page.projectId} AND project.deleted_at IS NULL
                AND (lifecycle.state IS NULL OR lifecycle.state = 'active')`;
          if (active.length !== 1)
            return yield* Effect.fail(invalid("Project is no longer active"));
          const state = yield* readCurrentState(sql, page.projectId);
          const policy = yield* readPolicy(state, page.projectId);
          const candidates =
            policy === undefined
              ? []
              : state.tasks
                  .filter(
                    (task) => page.afterTaskId === undefined || task.taskId > page.afterTaskId,
                  )
                  .sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0))
                  .slice(0, page.limit)
                  .map((task) => ({
                    taskId: task.taskId,
                    priority: policy.taskPriorities.get(task.taskId) ?? 0,
                  }));
          return { state, candidates };
        }),
      );
    });
    return { readProjectPage, readProjectState } satisfies ReadPorts;
  },
);
