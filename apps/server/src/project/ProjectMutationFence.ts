import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export class ProjectMutationFenceError extends Schema.TaggedError<ProjectMutationFenceError>()(
  "ProjectMutationFenceError",
  {
    projectId: Schema.String,
    reason: Schema.Literals([
      "unknown-project",
      "project-archived",
      "project-tombstoned",
      "storage",
    ]),
  },
) {}

/**
 * Must run on the same SqlClient transaction as the guarded mutation. The
 * legacy deletion marker remains authoritative during rollout, even before a
 * lifecycle row has been materialized.
 */
export const assertProjectAcceptsMutations = (
  sql: SqlClient.SqlClient,
  projectId: string,
): Effect.Effect<void, ProjectMutationFenceError, never> =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      readonly deletedAt: string | null;
      readonly lifecycleState: string | null;
    }>`
      SELECT projects.deleted_at AS deletedAt, lifecycle.state AS lifecycleState
      FROM projection_projects AS projects
      LEFT JOIN project_lifecycle AS lifecycle ON lifecycle.project_id = projects.project_id
      WHERE projects.project_id = ${projectId}
    `;
    const row = rows[0];
    if (row === undefined) {
      return yield* new ProjectMutationFenceError({ projectId, reason: "unknown-project" });
    }
    if (row.deletedAt !== null || row.lifecycleState === "tombstoned") {
      return yield* new ProjectMutationFenceError({ projectId, reason: "project-tombstoned" });
    }
    if (row.lifecycleState === "archived") {
      return yield* new ProjectMutationFenceError({ projectId, reason: "project-archived" });
    }
  }).pipe(
    Effect.mapError((cause) =>
      Schema.is(ProjectMutationFenceError)(cause)
        ? cause
        : new ProjectMutationFenceError({ projectId, reason: "storage" }),
    ),
  );
