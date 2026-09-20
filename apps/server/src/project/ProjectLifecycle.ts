import {
  EnvironmentId,
  ProjectId,
  ProjectLifecycleArchiveInput,
  ProjectLifecycleMutationResult,
  ProjectLifecyclePermanentDeleteInput,
  ProjectLifecycleRecord,
  ProjectLifecycleRelocationCheckInput,
  ProjectLifecycleRelocationCheckResult,
  ProjectLifecycleRestoreInput,
  ProjectLifecycleTombstone,
  projectWorkPayloadFingerprint,
  type ProjectLifecycleState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import { toPersistenceSqlError, type ProjectionRepositoryError } from "../persistence/Errors.ts";

export class ProjectLifecycleError extends Schema.TaggedError<ProjectLifecycleError>()(
  "ProjectLifecycleError",
  {
    reason: Schema.Literals([
      "unknown-project",
      "tombstoned",
      "already-archived",
      "not-archived",
      "path-mismatch",
      "relocation-rejected",
      "confirmation-required",
      "operation-conflict",
    ]),
    projectId: ProjectId,
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Project lifecycle ${this.reason} for ${this.projectId}${this.detail ? `: ${this.detail}` : ""}`;
  }
}

export interface ProjectLifecycleShape {
  readonly get: (
    projectId: ProjectId,
  ) => Effect.Effect<ProjectLifecycleRecord | undefined, ProjectionRepositoryError>;
  readonly archive: (
    input: ProjectLifecycleArchiveInput,
  ) => Effect.Effect<
    ProjectLifecycleMutationResult,
    ProjectLifecycleError | ProjectionRepositoryError
  >;
  readonly restore: (
    input: ProjectLifecycleRestoreInput,
  ) => Effect.Effect<
    ProjectLifecycleMutationResult,
    ProjectLifecycleError | ProjectionRepositoryError
  >;
  readonly checkRelocation: (
    input: ProjectLifecycleRelocationCheckInput,
  ) => Effect.Effect<ProjectLifecycleRelocationCheckResult, ProjectionRepositoryError>;
  readonly permanentDelete: (
    input: ProjectLifecyclePermanentDeleteInput,
  ) => Effect.Effect<
    ProjectLifecycleMutationResult,
    ProjectLifecycleError | ProjectionRepositoryError
  >;
}

export class ProjectLifecycle extends Context.Service<ProjectLifecycle, ProjectLifecycleShape>()(
  "t3/project/ProjectLifecycle",
) {}

export const ensureProjectLifecycleTables = (sql: SqlClient.SqlClient) =>
  Effect.all([
    sql`CREATE TABLE IF NOT EXISTS project_lifecycle (project_id TEXT PRIMARY KEY, state TEXT NOT NULL, workspace_root TEXT NOT NULL, repository_key TEXT, revision INTEGER NOT NULL DEFAULT 0, changed_at TEXT NOT NULL, tombstone_json TEXT)`,
    sql`CREATE TABLE IF NOT EXISTS project_lifecycle_operations (project_id TEXT NOT NULL, command_id TEXT NOT NULL, operation TEXT NOT NULL, request_fingerprint TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id, command_id))`,
  ]);

const now = (): string => DateTime.formatIso(DateTime.nowUnsafe());
const json = (value: unknown): string => JSON.stringify(value);
const canonicalPath = (value: string): string =>
  value.trim().replaceAll("\\", "/").replace(/\/$/, "");

type RelocationReason = NonNullable<ProjectLifecycleRelocationCheckResult["reason"]>;
type RelocationDecision = { readonly allowed: boolean; readonly reason?: RelocationReason };

const decodeLifecycleMutationResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectLifecycleMutationResult),
);
const decodeLifecycleRecord = Schema.decodeUnknownEffect(ProjectLifecycleRecord);
const decodeLifecycleTombstone = Schema.decodeUnknownEffect(ProjectLifecycleTombstone);

/** Pure path/key guard shared by the filesystem check and its tests. */
export const relocationDecision = (input: {
  readonly currentWorkspaceRoot: string;
  readonly candidateWorkspaceRoot: string;
  readonly candidateExists: boolean;
  readonly candidateIsDirectory: boolean;
  readonly expectedRepositoryKey?: string;
  readonly actualRepositoryKey?: string;
}): RelocationDecision => {
  const current = canonicalPath(input.currentWorkspaceRoot);
  const candidate = canonicalPath(input.candidateWorkspaceRoot);
  if (current === candidate) return { allowed: false, reason: "same-path" };
  if (!input.candidateExists) return { allowed: false, reason: "missing-path" };
  if (!input.candidateIsDirectory) return { allowed: false, reason: "not-directory" };
  if (
    input.expectedRepositoryKey !== undefined &&
    input.actualRepositoryKey !== undefined &&
    input.expectedRepositoryKey !== input.actualRepositoryKey
  ) {
    return { allowed: false, reason: "repository-mismatch" };
  }
  return { allowed: true };
};

const makeProjectLifecycle = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const identity = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironmentIdentity);
  const repositoryIdentityResolver = yield* Effect.serviceOption(
    RepositoryIdentityResolver.RepositoryIdentityResolver,
  );
  const environmentId = Option.isSome(identity)
    ? yield* identity.value.getEnvironmentId
    : EnvironmentId.make("local");

  const readRow = (projectId: ProjectId) =>
    Effect.gen(function* () {
      yield* ensureProjectLifecycleTables(sql);
      const rows = yield* sql<Record<string, unknown>>`
        SELECT project_id AS projectId, state, workspace_root AS workspaceRoot,
          repository_key AS repositoryKey, revision, changed_at AS changedAt
        FROM project_lifecycle WHERE project_id = ${String(projectId)}
      `;
      const row = rows[0];
      const legacy = yield* sql<Record<string, unknown>>`
        SELECT project_id AS projectId, workspace_root AS workspaceRoot,
          updated_at AS changedAt, deleted_at AS deletedAt
        FROM projection_projects WHERE project_id = ${String(projectId)}
      `;
      const source = legacy[0];
      if (row !== undefined) {
        // The legacy projection deletion marker remains authoritative during
        // rollout. Once either store says deleted, reads must not revive or
        // resynchronize the durable lifecycle row.
        const tombstoned = row.state === "tombstoned" || source?.deletedAt != null;
        const workspaceRoot =
          !tombstoned && source !== undefined ? source.workspaceRoot : row.workspaceRoot;
        const resolvedIdentity =
          !tombstoned && row.repositoryKey == null && Option.isSome(repositoryIdentityResolver)
            ? yield* repositoryIdentityResolver.value
                .resolve(String(workspaceRoot))
                .pipe(Effect.orElseSucceed(() => null))
            : null;
        const repositoryKey = row.repositoryKey ?? resolvedIdentity?.canonicalKey;
        if (
          !tombstoned &&
          (workspaceRoot !== row.workspaceRoot || repositoryKey !== row.repositoryKey)
        ) {
          yield* sql`
            UPDATE project_lifecycle
            SET workspace_root = ${String(workspaceRoot)}, repository_key = ${repositoryKey ?? null}
            WHERE project_id = ${String(projectId)} AND state <> 'tombstoned'
          `;
        }
        return yield* decodeLifecycleRecord({
          environmentId,
          projectId: row.projectId,
          state: tombstoned ? "tombstoned" : row.state,
          workspaceRoot,
          ...(repositoryKey == null ? {} : { repositoryKey }),
          revision: Number(row.revision),
          changedAt: row.changedAt,
        });
      }
      if (source === undefined) return undefined;
      const state: ProjectLifecycleState = source.deletedAt == null ? "active" : "tombstoned";
      const resolvedIdentity =
        state === "active" && Option.isSome(repositoryIdentityResolver)
          ? yield* repositoryIdentityResolver.value
              .resolve(String(source.workspaceRoot))
              .pipe(Effect.orElseSucceed(() => null))
          : null;
      return yield* decodeLifecycleRecord({
        environmentId,
        projectId: source.projectId,
        state,
        workspaceRoot: source.workspaceRoot,
        ...(resolvedIdentity?.canonicalKey === undefined
          ? {}
          : { repositoryKey: resolvedIdentity.canonicalKey }),
        revision: 0,
        changedAt: source.changedAt,
      });
    });

  const get: ProjectLifecycleShape["get"] = (projectId) =>
    readRow(projectId).pipe(Effect.mapError(toPersistenceSqlError("ProjectLifecycle.get")));

  const mutationResult = (
    project: ProjectLifecycleRecord,
    tombstone?: ProjectLifecycleTombstone,
  ): ProjectLifecycleMutationResult =>
    Schema.decodeSync(ProjectLifecycleMutationResult)({
      project,
      ...(tombstone === undefined ? {} : { tombstone }),
      filesDeleted: false,
      externalDataPreserved: true,
    });

  const priorMutationResult = (
    projectId: ProjectId,
    commandId: string,
    operation: string,
    requestFingerprint: string,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql<Record<string, unknown>>`
        SELECT operation, request_fingerprint AS requestFingerprint, result_json AS resultJson
        FROM project_lifecycle_operations
        WHERE project_id = ${String(projectId)} AND command_id = ${commandId}
      `;
      const row = rows[0];
      if (
        row !== undefined &&
        (row.operation !== operation || row.requestFingerprint !== requestFingerprint)
      ) {
        return yield* new ProjectLifecycleError({
          reason: "operation-conflict",
          projectId,
          detail: `Command '${commandId}' was already used for a different lifecycle request.`,
        });
      }
      const resultJson = row?.resultJson;
      return resultJson === undefined
        ? undefined
        : yield* decodeLifecycleMutationResult(String(resultJson));
    });

  const mutateState = (input: {
    readonly commandId: string;
    readonly projectId: ProjectId;
    readonly target: Exclude<ProjectLifecycleState, "tombstoned">;
    readonly workspaceRoot?: string;
  }) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* ensureProjectLifecycleTables(sql);
        const operation = input.target === "archived" ? "archive" : "restore";
        const requestFingerprint = projectWorkPayloadFingerprint(input);
        const prior = yield* priorMutationResult(
          input.projectId,
          input.commandId,
          operation,
          requestFingerprint,
        );
        if (prior !== undefined) return prior;
        const current = yield* readRow(input.projectId);
        if (current === undefined) {
          return yield* new ProjectLifecycleError({
            reason: "unknown-project",
            projectId: input.projectId,
          });
        }
        if (current.state === "tombstoned") {
          return yield* new ProjectLifecycleError({
            reason: "tombstoned",
            projectId: input.projectId,
          });
        }
        if (
          input.workspaceRoot !== undefined &&
          canonicalPath(input.workspaceRoot) !== canonicalPath(current.workspaceRoot)
        ) {
          return yield* new ProjectLifecycleError({
            reason: "path-mismatch",
            projectId: input.projectId,
          });
        }
        if (input.target === "archived" && current.state === "archived") {
          return yield* new ProjectLifecycleError({
            reason: "already-archived",
            projectId: input.projectId,
          });
        }
        if (input.target === "active" && current.state !== "archived") {
          return yield* new ProjectLifecycleError({
            reason: "not-archived",
            projectId: input.projectId,
          });
        }
        const changedAt = now();
        const next: ProjectLifecycleRecord = {
          ...current,
          state: input.target,
          revision: current.revision + 1,
          changedAt,
        };
        yield* sql`
          INSERT INTO project_lifecycle
            (project_id, state, workspace_root, repository_key, revision, changed_at, tombstone_json)
          VALUES (${String(input.projectId)}, ${input.target}, ${current.workspaceRoot},
            ${current.repositoryKey ?? null}, ${next.revision}, ${changedAt}, NULL)
          ON CONFLICT(project_id) DO UPDATE SET state = excluded.state,
            workspace_root = excluded.workspace_root, repository_key = excluded.repository_key,
            revision = excluded.revision, changed_at = excluded.changed_at, tombstone_json = NULL
        `;
        const result = mutationResult(next);
        yield* sql`
          INSERT INTO project_lifecycle_operations
            (project_id, command_id, operation, request_fingerprint, result_json, created_at)
          VALUES (${String(input.projectId)}, ${input.commandId}, ${operation}, ${requestFingerprint}, ${json(result)}, ${changedAt})
          ON CONFLICT(project_id, command_id) DO NOTHING
        `;
        return result;
      }),
    );

  const archive: ProjectLifecycleShape["archive"] = (input) =>
    mutateState({ ...input, target: "archived" }).pipe(
      Effect.mapError((cause) =>
        Schema.is(ProjectLifecycleError)(cause)
          ? cause
          : toPersistenceSqlError("ProjectLifecycle.archive")(cause),
      ),
    );
  const restore: ProjectLifecycleShape["restore"] = (input) =>
    mutateState({ ...input, target: "active" }).pipe(
      Effect.mapError((cause) =>
        Schema.is(ProjectLifecycleError)(cause)
          ? cause
          : toPersistenceSqlError("ProjectLifecycle.restore")(cause),
      ),
    );

  const checkRelocation: ProjectLifecycleShape["checkRelocation"] = (input) =>
    Effect.gen(function* () {
      const current = yield* readRow(input.projectId);
      if (current === undefined) {
        return {
          projectId: input.projectId,
          allowed: false,
          reason: "unknown-project" as const,
          candidateWorkspaceRoot: canonicalPath(input.candidateWorkspaceRoot),
        };
      }
      if (current.state === "tombstoned") {
        return {
          projectId: input.projectId,
          allowed: false,
          reason: "tombstoned" as const,
          candidateWorkspaceRoot: canonicalPath(input.candidateWorkspaceRoot),
        };
      }
      if (canonicalPath(input.currentWorkspaceRoot) !== canonicalPath(current.workspaceRoot)) {
        return {
          projectId: input.projectId,
          allowed: false,
          reason: "stale-current-path" as const,
          candidateWorkspaceRoot: canonicalPath(input.candidateWorkspaceRoot),
        };
      }
      const candidateInfo = yield* fileSystem
        .stat(input.candidateWorkspaceRoot)
        .pipe(Effect.option);
      const candidatePath = yield* fileSystem
        .realPath(input.candidateWorkspaceRoot)
        .pipe(Effect.orElseSucceed(() => canonicalPath(input.candidateWorkspaceRoot)));
      const pathDecision = relocationDecision({
        currentWorkspaceRoot: current.workspaceRoot,
        candidateWorkspaceRoot: candidatePath,
        candidateExists: Option.isSome(candidateInfo),
        candidateIsDirectory:
          Option.isSome(candidateInfo) && candidateInfo.value.type === "Directory",
      });
      if (!pathDecision.allowed) {
        return {
          projectId: input.projectId,
          ...pathDecision,
          candidateWorkspaceRoot: candidatePath,
        };
      }
      const currentRepositoryIdentity = Option.isSome(repositoryIdentityResolver)
        ? yield* repositoryIdentityResolver.value
            .resolve(current.workspaceRoot, { refresh: true })
            .pipe(Effect.orElseSucceed(() => null))
        : null;
      const expectedRepositoryKey =
        current.repositoryKey ?? currentRepositoryIdentity?.canonicalKey;
      if (expectedRepositoryKey === undefined) {
        return {
          projectId: input.projectId,
          allowed: false,
          reason: "repository-identity-unavailable" as const,
          candidateWorkspaceRoot: candidatePath,
        };
      }
      if (
        input.expectedRepositoryKey !== undefined &&
        expectedRepositoryKey !== input.expectedRepositoryKey
      ) {
        return {
          projectId: input.projectId,
          allowed: false,
          reason: "repository-mismatch" as const,
          candidateWorkspaceRoot: candidatePath,
        };
      }
      const repositoryIdentity = Option.isSome(repositoryIdentityResolver)
        ? yield* repositoryIdentityResolver.value
            .resolve(candidatePath)
            .pipe(Effect.orElseSucceed(() => null))
        : null;
      if (repositoryIdentity === null) {
        return {
          projectId: input.projectId,
          allowed: false,
          reason: "repository-identity-unavailable" as const,
          candidateWorkspaceRoot: candidatePath,
        };
      }
      const decision = relocationDecision({
        currentWorkspaceRoot: input.currentWorkspaceRoot,
        candidateWorkspaceRoot: candidatePath,
        candidateExists: Option.isSome(candidateInfo),
        candidateIsDirectory:
          Option.isSome(candidateInfo) && candidateInfo.value.type === "Directory",
        expectedRepositoryKey,
        ...(repositoryIdentity?.canonicalKey === undefined
          ? {}
          : { actualRepositoryKey: repositoryIdentity.canonicalKey }),
      });
      return {
        projectId: input.projectId,
        ...decision,
        candidateWorkspaceRoot: candidatePath,
        ...(repositoryIdentity === null ? {} : { repositoryIdentity }),
      } satisfies ProjectLifecycleRelocationCheckResult;
    }).pipe(Effect.mapError(toPersistenceSqlError("ProjectLifecycle.checkRelocation")));

  const permanentDelete: ProjectLifecycleShape["permanentDelete"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* ensureProjectLifecycleTables(sql);
          const operation = "permanent-local-delete";
          const requestFingerprint = projectWorkPayloadFingerprint(input);
          const prior = yield* priorMutationResult(
            input.projectId,
            input.commandId,
            operation,
            requestFingerprint,
          );
          if (prior !== undefined) return prior;
          if (input.confirmation !== "permanent-local-delete") {
            return yield* new ProjectLifecycleError({
              reason: "confirmation-required",
              projectId: input.projectId,
            });
          }
          const durableLifecycleRows = yield* sql<{ readonly state: string }>`
            SELECT state FROM project_lifecycle WHERE project_id = ${String(input.projectId)}
          `;
          if (durableLifecycleRows[0]?.state === "tombstoned") {
            return yield* new ProjectLifecycleError({
              reason: "tombstoned",
              projectId: input.projectId,
            });
          }
          const current = yield* readRow(input.projectId);
          if (current === undefined) {
            return yield* new ProjectLifecycleError({
              reason: "unknown-project",
              projectId: input.projectId,
            });
          }
          if (canonicalPath(input.workspaceRoot) !== canonicalPath(current.workspaceRoot)) {
            return yield* new ProjectLifecycleError({
              reason: "path-mismatch",
              projectId: input.projectId,
            });
          }
          const changedAt = now();
          const tombstone = yield* decodeLifecycleTombstone({
            environmentId,
            projectId: input.projectId,
            workspaceRoot: current.workspaceRoot,
            ...(current.repositoryKey === undefined
              ? {}
              : { repositoryKey: current.repositoryKey }),
            tombstonedAt: changedAt,
            reason:
              current.state === "tombstoned" ? "legacy-project-delete" : "permanent-local-delete",
            externalDataPreserved: true,
          });
          const next: ProjectLifecycleRecord = {
            ...current,
            state: "tombstoned",
            revision: current.revision + 1,
            changedAt,
          };
          yield* sql`
          INSERT INTO project_lifecycle
            (project_id, state, workspace_root, repository_key, revision, changed_at, tombstone_json)
          VALUES (${String(input.projectId)}, 'tombstoned', ${current.workspaceRoot},
            ${current.repositoryKey ?? null}, ${next.revision}, ${changedAt}, ${json(tombstone)})
          ON CONFLICT(project_id) DO UPDATE SET state = 'tombstoned', revision = excluded.revision,
            changed_at = excluded.changed_at, tombstone_json = excluded.tombstone_json
        `;
          // Remove only local durable work/projection rows.  The lifecycle row is
          // intentionally retained so stale clients cannot recreate this ID.
          for (const table of [
            "project_work_tasks",
            "project_work_attempts",
            "project_work_criteria",
            "project_work_evidence",
            "project_work_relationships",
            "project_work_blockers",
            "project_work_knowledge",
            "project_work_decisions",
            "project_work_comments",
            "project_work_attention",
            "project_work_attention_occurrences",
            "project_work_notification_publications",
            "project_work_activity",
            "project_work_checkpoints",
            "project_work_search_fts",
            "project_work_command_receipts",
            "project_work_approvals",
            "project_work_reducer_checkpoints",
            "project_work_events",
          ]) {
            yield* sql.unsafe(`DELETE FROM ${table} WHERE project_id = ?`, [
              String(input.projectId),
            ]);
          }
          yield* sql`DELETE FROM project_work_projection_state WHERE projector = ${"project-work:" + String(input.projectId)}`;
          const result = mutationResult(next, tombstone);
          yield* sql`
          INSERT INTO project_lifecycle_operations
            (project_id, command_id, operation, request_fingerprint, result_json, created_at)
          VALUES (${String(input.projectId)}, ${input.commandId}, ${operation}, ${requestFingerprint}, ${json(result)}, ${changedAt})
          ON CONFLICT(project_id, command_id) DO NOTHING
        `;
          return result;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(ProjectLifecycleError)(cause)
            ? cause
            : toPersistenceSqlError("ProjectLifecycle.permanentDelete")(cause),
        ),
      );

  return {
    get,
    archive,
    restore,
    checkRelocation,
    permanentDelete,
  } satisfies ProjectLifecycleShape;
});

export const ProjectLifecycleLive = Layer.effect(ProjectLifecycle, makeProjectLifecycle);
