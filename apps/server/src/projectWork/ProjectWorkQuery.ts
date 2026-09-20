import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  ProjectWorkTaskId,
  ProjectWorkAttemptId,
  ProjectWorkCriterionId,
  ProjectWorkEvidenceId,
  ProjectWorkRelationshipId,
  ProjectWorkBlockerId,
  ProjectWorkKnowledgeId,
  ProjectWorkDecisionId,
  ProjectWorkCommentId,
  type ProjectWorkTask,
  type ProjectWorkAttempt,
  type ProjectWorkCriterion,
  type ProjectWorkEvidence,
  type ProjectWorkRelationship,
  type ProjectWorkBlocker,
  type ProjectWorkKnowledge,
  type ProjectWorkDecision,
  type ProjectWorkComment,
  type ProjectWorkAttention,
  type ProjectWorkTaskContext,
} from "@t3tools/contracts";
import {
  isPersistenceError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../persistence/Errors.ts";
import { type ProjectWorkActivity, type ProjectWorkCheckpoint } from "./ProjectWorkProjection.ts";
import { deriveProjectWorkTaskPolicy } from "./ProjectWorkPolicy.ts";

export interface ProjectWorkTaskQuery extends ProjectWorkRecordQuery {
  readonly state?: string;
}

export interface ProjectWorkRecordQuery {
  readonly projectId: string;
  readonly limit?: number;
  readonly offset?: number;
  /** Server-owned reads may request the extra sentinel row used to compute
   * public pagination metadata. Transport input must never set this flag. */
  readonly trusted?: true;
}

export interface ProjectWorkActivityQuery extends ProjectWorkRecordQuery {
  readonly taskId?: ProjectWorkTaskId;
  readonly attemptId?: ProjectWorkAttemptId;
}

export interface ProjectWorkSnapshot {
  readonly projectId: string;
  readonly revision: number;
  readonly tasks: ReadonlyArray<ProjectWorkTask>;
  readonly attempts: ReadonlyArray<ProjectWorkAttempt>;
  readonly criteria: ReadonlyArray<ProjectWorkCriterion>;
  readonly evidence: ReadonlyArray<ProjectWorkEvidence>;
  readonly relationships: ReadonlyArray<ProjectWorkRelationship>;
  readonly blockers: ReadonlyArray<ProjectWorkBlocker>;
  readonly attention: ReadonlyArray<ProjectWorkAttention>;
  readonly activities: ReadonlyArray<ProjectWorkActivity>;
  readonly checkpoints: ReadonlyArray<ProjectWorkCheckpoint>;
  readonly knowledge: ReadonlyArray<ProjectWorkKnowledge>;
  readonly decisions: ReadonlyArray<ProjectWorkDecision>;
  readonly comments: ReadonlyArray<ProjectWorkComment>;
}

export interface ProjectWorkExportSnapshot {
  readonly snapshot: ProjectWorkSnapshot;
  readonly history?: ReadonlyArray<unknown>;
}

export interface ProjectWorkQueryShape {
  readonly getProjectRevision: (
    projectId: string,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
  readonly getTask: (
    projectId: string,
    taskId: ProjectWorkTaskId,
  ) => Effect.Effect<Option.Option<ProjectWorkTask>, ProjectionRepositoryError>;
  readonly getProjectWorkTask: (
    projectId: string,
    taskId: ProjectWorkTaskId,
  ) => Effect.Effect<Option.Option<ProjectWorkTask>, ProjectionRepositoryError>;
  readonly listTasks: (
    input: ProjectWorkTaskQuery,
  ) => Effect.Effect<ReadonlyArray<ProjectWorkTask>, ProjectionRepositoryError>;
  readonly listProjectWorkTasks: (
    input: ProjectWorkTaskQuery,
  ) => Effect.Effect<ReadonlyArray<ProjectWorkTask>, ProjectionRepositoryError>;
  readonly listAttempts: (
    input: ProjectWorkRecordQuery & {
      readonly taskId?: ProjectWorkTaskId;
      /** Reducer order for policy derivation; public lists remain newest-first. */
      readonly canonical?: true;
    },
  ) => Effect.Effect<ReadonlyArray<ProjectWorkAttempt>, ProjectionRepositoryError>;
  readonly getActiveAttempt: (
    projectId: string,
    taskId: ProjectWorkTaskId,
  ) => Effect.Effect<Option.Option<ProjectWorkAttempt>, ProjectionRepositoryError>;
  readonly getTaskContext: (
    projectId: string,
    taskId: ProjectWorkTaskId,
  ) => Effect.Effect<Option.Option<ProjectWorkTaskContext>, ProjectionRepositoryError>;
  readonly withProjectRevision: <A>(
    projectId: string,
    read: Effect.Effect<A, ProjectionRepositoryError>,
  ) => Effect.Effect<{ readonly value: A; readonly revision: number }, ProjectionRepositoryError>;
  readonly listCriteria: (
    input: ProjectWorkRecordQuery & { readonly taskId?: ProjectWorkTaskId },
  ) => Effect.Effect<ReadonlyArray<ProjectWorkCriterion>, ProjectionRepositoryError>;
  readonly listEvidence: (
    input: ProjectWorkRecordQuery & {
      readonly taskId?: ProjectWorkTaskId;
      readonly criterionId?: string;
    },
  ) => Effect.Effect<ReadonlyArray<ProjectWorkEvidence>, ProjectionRepositoryError>;
  readonly listRelationships: (
    input: ProjectWorkRecordQuery & { readonly taskId?: ProjectWorkTaskId },
  ) => Effect.Effect<ReadonlyArray<ProjectWorkRelationship>, ProjectionRepositoryError>;
  readonly listBlockers: (
    input: ProjectWorkRecordQuery & {
      readonly taskId?: ProjectWorkTaskId;
      readonly activeOnly?: boolean;
    },
  ) => Effect.Effect<ReadonlyArray<ProjectWorkBlocker>, ProjectionRepositoryError>;
  readonly listAttention: (
    input: ProjectWorkRecordQuery & { readonly taskId?: ProjectWorkTaskId },
  ) => Effect.Effect<ReadonlyArray<ProjectWorkAttention>, ProjectionRepositoryError>;
  readonly listActivities: (
    input: ProjectWorkActivityQuery,
  ) => Effect.Effect<ReadonlyArray<ProjectWorkActivity>, ProjectionRepositoryError>;
  readonly listCheckpoints: (
    input: ProjectWorkRecordQuery & {
      readonly taskId?: ProjectWorkTaskId;
      readonly attemptId?: ProjectWorkAttemptId;
    },
  ) => Effect.Effect<ReadonlyArray<ProjectWorkCheckpoint>, ProjectionRepositoryError>;
  readonly listKnowledge: (
    input: ProjectWorkRecordQuery,
  ) => Effect.Effect<ReadonlyArray<ProjectWorkKnowledge>, ProjectionRepositoryError>;
  readonly listDecisions: (
    input: ProjectWorkRecordQuery & { readonly state?: string },
  ) => Effect.Effect<ReadonlyArray<ProjectWorkDecision>, ProjectionRepositoryError>;
  readonly listComments: (
    input: ProjectWorkRecordQuery & { readonly taskId?: ProjectWorkTaskId },
  ) => Effect.Effect<ReadonlyArray<ProjectWorkComment>, ProjectionRepositoryError>;
  readonly snapshot: (
    projectId: string,
  ) => Effect.Effect<ProjectWorkSnapshot, ProjectionRepositoryError>;
  /** Atomic snapshot containing only the collections used by structured briefings. */
  readonly briefingSnapshot: (
    projectId: string,
    maxKnowledge: number,
  ) => Effect.Effect<ProjectWorkSnapshot, ProjectionRepositoryError>;
  readonly getSnapshot: (
    projectId: string,
  ) => Effect.Effect<ProjectWorkSnapshot, ProjectionRepositoryError>;
  /** Reads uncapped projections and optional history behind one SQLite read fence. */
  readonly exportSnapshot: (
    projectId: string,
    includeHistory: boolean,
  ) => Effect.Effect<ProjectWorkExportSnapshot, ProjectionRepositoryError>;
}

export class ProjectWorkQuery extends Context.Service<ProjectWorkQuery, ProjectWorkQueryShape>()(
  "t3/projectWork/ProjectWorkQuery",
) {}

const parse = <A>(value: string | null | undefined, fallback: A): A => {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value) as A;
  } catch {
    // Projection rows are written by the server. A malformed row should not
    // make a read crash; callers still receive the stable scalar fields.
    return fallback;
  }
};

const boundedInteger = (value: number | undefined, fallback: number, maximum?: number) => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const integer = Math.max(0, Math.floor(value));
  return maximum === undefined ? integer : Math.min(maximum, integer);
};

const bounds = (limit: number | undefined, offset: number | undefined, trusted = false) => ({
  // SQLite defines LIMIT -1 as unbounded. Only server-owned policy reads may
  // use it; public collection reads remain capped at 1,000 rows.
  limit:
    trusted && limit === undefined ? -1 : boundedInteger(limit, 1_000, trusted ? undefined : 1_000),
  offset: boundedInteger(offset, 0, 1_000_000),
});

const toTask = (row: Record<string, unknown>): ProjectWorkTask =>
  ({
    taskId: ProjectWorkTaskId.make(String(row.taskId)),
    projectId: String(row.projectId) as ProjectWorkTask["projectId"],
    title: String(row.title),
    ...(row.summary === null || row.summary === undefined ? {} : { summary: String(row.summary) }),
    state: String(row.state) as ProjectWorkTask["state"],
    ...(row.specificationJson
      ? { specification: parse(row.specificationJson as string, undefined) }
      : {}),
    ...(row.assigneeJson ? { assignee: parse(row.assigneeJson as string, undefined) } : {}),
    watchers: parse(row.watchersJson as string | null, []),
    ...(row.approvalJson ? { approval: parse(row.approvalJson as string, undefined) } : {}),
    revision: Number(row.revision),
    specRevision: Number(row.specRevision),
    ...(row.activeAttemptId
      ? {
          activeAttemptId: ProjectWorkAttemptId.make(String(row.activeAttemptId)),
        }
      : {}),
    ...(row.failureKind
      ? {
          failureKind: String(row.failureKind) as ProjectWorkTask["failureKind"],
        }
      : {}),
    ...(row.blockerId ? { blockerId: String(row.blockerId) as ProjectWorkTask["blockerId"] } : {}),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    ...(row.completedAt ? { completedAt: String(row.completedAt) } : {}),
    ...(row.canceledAt ? { canceledAt: String(row.canceledAt) } : {}),
    ...(row.attributionJson
      ? { attribution: parse(row.attributionJson as string, undefined) }
      : {}),
  }) as unknown as ProjectWorkTask;

const toAttempt = (row: Record<string, unknown>): ProjectWorkAttempt =>
  ({
    attemptId: ProjectWorkAttemptId.make(String(row.attemptId)),
    taskId: ProjectWorkTaskId.make(String(row.taskId)),
    state: String(row.state) as ProjectWorkAttempt["state"],
    ...(row.leasedUntil ? { leasedUntil: String(row.leasedUntil) } : {}),
    ...(row.startedAt ? { startedAt: String(row.startedAt) } : {}),
    ...(row.endedAt ? { endedAt: String(row.endedAt) } : {}),
    ...(row.failureKind
      ? {
          failureKind: String(row.failureKind) as ProjectWorkAttempt["failureKind"],
        }
      : {}),
    ...(row.failureReason ? { failureReason: String(row.failureReason) } : {}),
    ...(row.failureEvidenceIdsJson
      ? { failureEvidenceIds: parse(row.failureEvidenceIdsJson as string, []) }
      : {}),
    ...(row.failureResolvedAt ? { failureResolvedAt: String(row.failureResolvedAt) } : {}),
    ...(row.failureResolutionReason
      ? { failureResolutionReason: String(row.failureResolutionReason) }
      : {}),
    ...(row.failureResolutionEvidenceIdsJson
      ? {
          failureResolutionEvidenceIds: parse(row.failureResolutionEvidenceIdsJson as string, []),
        }
      : {}),
    ...(row.failureResolutionAttributionJson
      ? {
          failureResolutionAttribution: parse(
            row.failureResolutionAttributionJson as string,
            undefined,
          ),
        }
      : {}),
    checkpointIds: parse(row.checkpointIdsJson as string | null, []),
    revision: Number(row.revision),
    ...(row.attributionJson
      ? { attribution: parse(row.attributionJson as string, undefined) }
      : {}),
  }) as unknown as ProjectWorkAttempt;

const makeProjectWorkQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const query = <A>(
    effect: Effect.Effect<ReadonlyArray<A>, SqlError>,
  ): Effect.Effect<ReadonlyArray<A>, ProjectionRepositoryError> =>
    effect.pipe(Effect.mapError((cause) => toPersistenceSqlError("ProjectWorkQuery.query")(cause)));

  const getProjectRevision: ProjectWorkQueryShape["getProjectRevision"] = (projectId) =>
    query(sql<Record<string, unknown>>`
      SELECT COALESCE(MAX(CAST(json_extract(payload_json, '$.revision') AS INTEGER)), 0) AS revision
      FROM project_work_events
      WHERE project_id = ${projectId}
    `).pipe(Effect.map((rows) => Number(rows[0]?.revision ?? 0)));

  const withProjectRevision: ProjectWorkQueryShape["withProjectRevision"] = (projectId, read) =>
    sql
      .withTransaction(
        Effect.all({
          value: read,
          revision: getProjectRevision(projectId),
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isPersistenceError(cause)
            ? cause
            : toPersistenceSqlError("ProjectWorkQuery.withProjectRevision")(cause),
        ),
      );

  const getTask: ProjectWorkQueryShape["getTask"] = (projectId, taskId) =>
    query(sql<Record<string, unknown>>`
      SELECT task_id AS taskId, project_id AS projectId, title, summary, state,
        specification_json AS specificationJson, assignee_json AS assigneeJson, watchers_json AS watchersJson,
        approval_json AS approvalJson, revision, spec_revision AS specRevision,
        active_attempt_id AS activeAttemptId, failure_kind AS failureKind, blocker_id AS blockerId,
        created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt,
        canceled_at AS canceledAt, attribution_json AS attributionJson
      FROM project_work_tasks WHERE project_id = ${projectId} AND task_id = ${taskId} LIMIT 1
    `).pipe(
      Effect.map((rows) =>
        rows[0] === undefined ? Option.none<ProjectWorkTask>() : Option.some(toTask(rows[0])),
      ),
    );

  const listTasks: ProjectWorkQueryShape["listTasks"] = (input) => {
    const page = bounds(input.limit, input.offset, input.trusted);
    return query(sql<Record<string, unknown>>`
      SELECT task_id AS taskId, project_id AS projectId, title, summary, state,
        specification_json AS specificationJson, assignee_json AS assigneeJson, watchers_json AS watchersJson,
        approval_json AS approvalJson, revision, spec_revision AS specRevision,
        active_attempt_id AS activeAttemptId, failure_kind AS failureKind, blocker_id AS blockerId,
        created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt,
        canceled_at AS canceledAt, attribution_json AS attributionJson
      FROM project_work_tasks WHERE project_id = ${input.projectId}
        ${input.state === undefined ? sql`` : sql`AND state = ${input.state}`}
      ORDER BY updated_at DESC, task_id ASC LIMIT ${page.limit} OFFSET ${page.offset}
    `).pipe(Effect.map((rows) => rows.map(toTask)));
  };

  const listAttempts: ProjectWorkQueryShape["listAttempts"] = (input) => {
    const page = bounds(input.limit, input.offset, input.trusted);
    return query(sql<Record<string, unknown>>`
      SELECT attempt_id AS attemptId, project_id AS projectId, task_id AS taskId, state,
        leased_until AS leasedUntil, started_at AS startedAt,
        ended_at AS endedAt, failure_kind AS failureKind, failure_reason AS failureReason,
        failure_evidence_ids_json AS failureEvidenceIdsJson, failure_resolved_at AS failureResolvedAt,
        failure_resolution_reason AS failureResolutionReason,
        failure_resolution_evidence_ids_json AS failureResolutionEvidenceIdsJson,
        failure_resolution_attribution_json AS failureResolutionAttributionJson,
        checkpoint_ids_json AS checkpointIdsJson, revision, attribution_json AS attributionJson
      FROM project_work_attempts AS attempt
      ${
        input.canonical === true
          ? sql`LEFT JOIN (
              SELECT project_id AS creation_project_id,
                json_extract(payload_json, '$.attempt.attemptId') AS creation_attempt_id,
                MIN(sequence) AS creation_sequence
              FROM project_work_events
              WHERE project_id = ${input.projectId}
                AND event_type IN (
                  'project-work.task.claimed',
                  'project-work.attempt.reclaimed',
                  'project-work.attempt.taken-over'
                )
              GROUP BY project_id, json_extract(payload_json, '$.attempt.attemptId')
            ) AS creation
              ON creation.creation_project_id = attempt.project_id
              AND creation.creation_attempt_id = attempt.attempt_id`
          : sql``
      }
      WHERE attempt.project_id = ${input.projectId}
        ${input.taskId === undefined ? sql`` : sql`AND attempt.task_id = ${input.taskId}`}
      ${
        input.canonical === true
          ? sql`ORDER BY creation.creation_sequence ASC, attempt.attempt_id ASC`
          : sql`ORDER BY attempt.updated_at DESC, attempt.attempt_id ASC`
      }
      LIMIT ${page.limit} OFFSET ${page.offset}
    `).pipe(Effect.map((rows) => rows.map(toAttempt)));
  };

  const getActiveAttempt: ProjectWorkQueryShape["getActiveAttempt"] = (projectId, taskId) =>
    query(sql<Record<string, unknown>>`
      SELECT attempt_id AS attemptId, task_id AS taskId, state,
        leased_until AS leasedUntil, started_at AS startedAt,
        ended_at AS endedAt, failure_kind AS failureKind, failure_reason AS failureReason,
        failure_evidence_ids_json AS failureEvidenceIdsJson, failure_resolved_at AS failureResolvedAt,
        failure_resolution_reason AS failureResolutionReason,
        failure_resolution_evidence_ids_json AS failureResolutionEvidenceIdsJson,
        failure_resolution_attribution_json AS failureResolutionAttributionJson,
        checkpoint_ids_json AS checkpointIdsJson, revision, attribution_json AS attributionJson
      FROM project_work_attempts
      WHERE project_id = ${projectId} AND task_id = ${taskId}
        AND state IN ('leased', 'running')
      ORDER BY updated_at DESC, revision DESC, attempt_id ASC
      LIMIT 1
    `).pipe(
      Effect.map((rows) =>
        rows[0] === undefined ? Option.none<ProjectWorkAttempt>() : Option.some(toAttempt(rows[0])),
      ),
    );

  const listCriteria: ProjectWorkQueryShape["listCriteria"] = (input) => {
    const page = bounds(input.limit, input.offset, input.trusted);
    return query(sql<Record<string, unknown>>`
      SELECT criterion_id AS criterionId, project_id AS projectId, task_id AS taskId,
        description, required, status, satisfied_by_evidence_ids_json AS satisfiedJson,
        waiver_json AS waiverJson, revision, updated_at AS updatedAt
      FROM project_work_criteria WHERE project_id = ${input.projectId}
        ${input.taskId === undefined ? sql`` : sql`AND task_id = ${input.taskId}`}
      ORDER BY updated_at DESC, criterion_id ASC LIMIT ${page.limit} OFFSET ${page.offset}
    `).pipe(
      Effect.map((rows) =>
        rows.map(
          (row) =>
            ({
              criterionId: String(row.criterionId) as ProjectWorkCriterionId,
              taskId: String(row.taskId) as ProjectWorkTaskId,
              description: String(row.description),
              required: Boolean(row.required),
              status: String(row.status) as ProjectWorkCriterion["status"],
              satisfiedByEvidenceIds: parse(row.satisfiedJson as string | null, []),
              ...(row.waiverJson ? { waiver: parse(row.waiverJson as string, undefined) } : {}),
              revision: Number(row.revision),
              updatedAt: String(row.updatedAt),
            }) as unknown as ProjectWorkCriterion,
        ),
      ),
    );
  };

  const listEvidence: ProjectWorkQueryShape["listEvidence"] = (input) => {
    const page = bounds(input.limit, input.offset, input.trusted);
    return query(sql<Record<string, unknown>>`
      SELECT evidence_id AS evidenceId, project_id AS projectId, task_id AS taskId,
        criterion_id AS criterionId, kind, summary, detail, uri, recorded_at AS recordedAt,
        revision, attribution_json AS attributionJson
      FROM project_work_evidence WHERE project_id = ${input.projectId}
        ${input.taskId === undefined ? sql`` : sql`AND task_id = ${input.taskId}`}
        ${input.criterionId === undefined ? sql`` : sql`AND criterion_id = ${input.criterionId}`}
      ORDER BY recorded_at DESC, evidence_id ASC LIMIT ${page.limit} OFFSET ${page.offset}
    `).pipe(
      Effect.map((rows) =>
        rows.map(
          (row) =>
            ({
              evidenceId: String(row.evidenceId) as ProjectWorkEvidenceId,
              ...(row.taskId ? { taskId: String(row.taskId) as ProjectWorkTaskId } : {}),
              ...(row.criterionId
                ? {
                    criterionId: String(row.criterionId) as ProjectWorkCriterionId,
                  }
                : {}),
              kind: String(row.kind) as ProjectWorkEvidence["kind"],
              summary: String(row.summary),
              ...(row.detail ? { detail: String(row.detail) } : {}),
              ...(row.uri ? { uri: String(row.uri) } : {}),
              recordedAt: String(row.recordedAt),
              revision: Number(row.revision),
              ...(row.attributionJson
                ? {
                    attribution: parse(row.attributionJson as string, undefined),
                  }
                : {}),
            }) as unknown as ProjectWorkEvidence,
        ),
      ),
    );
  };

  const listRelationships: ProjectWorkQueryShape["listRelationships"] = (input) => {
    const page = bounds(input.limit, input.offset, input.trusted);
    return query(
      sql<
        Record<string, unknown>
      >`SELECT relationship_id AS relationshipId, project_id AS projectId, from_task_id AS fromTaskId, to_task_id AS toTaskId, kind, revision, created_at AS createdAt, attribution_json AS attributionJson FROM project_work_relationships WHERE project_id = ${input.projectId} ${input.taskId === undefined ? sql`` : sql`AND (from_task_id = ${input.taskId} OR to_task_id = ${input.taskId})`} ORDER BY created_at DESC, relationship_id ASC LIMIT ${page.limit} OFFSET ${page.offset}`,
    ).pipe(
      Effect.map((rows) =>
        rows.map(
          (row) =>
            ({
              relationshipId: String(row.relationshipId) as ProjectWorkRelationshipId,
              projectId: String(row.projectId) as ProjectWorkRelationship["projectId"],
              fromTaskId: String(row.fromTaskId) as ProjectWorkTaskId,
              toTaskId: String(row.toTaskId) as ProjectWorkTaskId,
              kind: String(row.kind) as ProjectWorkRelationship["kind"],
              revision: Number(row.revision),
              createdAt: String(row.createdAt),
              ...(row.attributionJson
                ? {
                    attribution: parse(row.attributionJson as string, undefined),
                  }
                : {}),
            }) as unknown as ProjectWorkRelationship,
        ),
      ),
    );
  };

  const listBlockers: ProjectWorkQueryShape["listBlockers"] = (input) => {
    const page = bounds(input.limit, input.offset, input.trusted);
    return query(
      sql<
        Record<string, unknown>
      >`SELECT blocker_id AS blockerId, project_id AS projectId, task_id AS taskId, reason, resolver, reference_ids_json AS referenceIdsJson, attention, resolved_at AS resolvedAt, revision, attribution_json AS attributionJson FROM project_work_blockers WHERE project_id = ${input.projectId} ${input.taskId === undefined ? sql`` : sql`AND task_id = ${input.taskId}`} ${input.activeOnly ? sql`AND resolved_at IS NULL` : sql``} ORDER BY revision DESC, blocker_id ASC LIMIT ${page.limit} OFFSET ${page.offset}`,
    ).pipe(
      Effect.map((rows) =>
        rows.map(
          (row) =>
            ({
              blockerId: String(row.blockerId) as ProjectWorkBlockerId,
              taskId: String(row.taskId) as ProjectWorkTaskId,
              reason: String(row.reason),
              resolver: String(row.resolver),
              referenceIds: parse(row.referenceIdsJson as string | null, []),
              attention: Boolean(row.attention),
              ...(row.resolvedAt ? { resolvedAt: String(row.resolvedAt) } : {}),
              revision: Number(row.revision),
              ...(row.attributionJson
                ? {
                    attribution: parse(row.attributionJson as string, undefined),
                  }
                : {}),
            }) as unknown as ProjectWorkBlocker,
        ),
      ),
    );
  };

  const listAttention: ProjectWorkQueryShape["listAttention"] = (input) => {
    const page = bounds(input.limit, input.offset, input.trusted);
    return query(
      sql<
        Record<string, unknown>
      >`SELECT task_id AS taskId, reason, detail, seen_at AS seenAt, resolved_at AS resolvedAt, revision FROM project_work_attention WHERE project_id = ${input.projectId} ${input.taskId === undefined ? sql`` : sql`AND task_id = ${input.taskId}`} ORDER BY revision DESC, task_id ASC LIMIT ${page.limit} OFFSET ${page.offset}`,
    ).pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          taskId: String(row.taskId) as ProjectWorkTaskId,
          reason: String(row.reason) as ProjectWorkAttention["reason"],
          ...(row.detail ? { detail: String(row.detail) } : {}),
          ...(row.seenAt ? { seenAt: String(row.seenAt) } : {}),
          ...(row.resolvedAt ? { resolvedAt: String(row.resolvedAt) } : {}),
          revision: Number(row.revision),
        })),
      ),
    );
  };

  const listActivities: ProjectWorkQueryShape["listActivities"] = (input) => {
    const page = bounds(input.limit, input.offset, input.trusted);
    return query(
      sql<
        Record<string, unknown>
      >`SELECT activity_id AS activityId, project_id AS projectId, task_id AS taskId, attempt_id AS attemptId, kind, summary, detail, occurred_at AS occurredAt, revision, attribution_json AS attributionJson FROM project_work_activity WHERE project_id = ${input.projectId} ${input.taskId === undefined ? sql`` : sql`AND task_id = ${input.taskId}`} ${input.attemptId === undefined ? sql`` : sql`AND attempt_id = ${input.attemptId}`} ORDER BY occurred_at DESC, activity_id DESC LIMIT ${page.limit} OFFSET ${page.offset}`,
    ).pipe(
      Effect.map((rows) =>
        rows.map(
          (row) =>
            ({
              activityId: String(row.activityId),
              projectId: String(row.projectId),
              ...(row.taskId ? { taskId: ProjectWorkTaskId.make(String(row.taskId)) } : {}),
              ...(row.attemptId
                ? {
                    attemptId: ProjectWorkAttemptId.make(String(row.attemptId)),
                  }
                : {}),
              kind: String(row.kind),
              summary: String(row.summary),
              ...(row.detail ? { detail: String(row.detail) } : {}),
              occurredAt: String(row.occurredAt),
              revision: Number(row.revision),
              ...(row.attributionJson
                ? {
                    attribution: parse(row.attributionJson as string, undefined),
                  }
                : {}),
            }) as unknown as ProjectWorkActivity,
        ),
      ),
    );
  };

  const listCheckpoints: ProjectWorkQueryShape["listCheckpoints"] = (input) => {
    const page = bounds(input.limit, input.offset, input.trusted);
    return query(
      sql<
        Record<string, unknown>
      >`SELECT checkpoint_id AS checkpointId, project_id AS projectId, task_id AS taskId, attempt_id AS attemptId, ref, captured_at AS capturedAt, revision, attribution_json AS attributionJson FROM project_work_checkpoints WHERE project_id = ${input.projectId} ${input.taskId === undefined ? sql`` : sql`AND task_id = ${input.taskId}`} ${input.attemptId === undefined ? sql`` : sql`AND attempt_id = ${input.attemptId}`} ORDER BY captured_at DESC, checkpoint_id DESC LIMIT ${page.limit} OFFSET ${page.offset}`,
    ).pipe(
      Effect.map((rows) =>
        rows.map(
          (row) =>
            ({
              checkpointId: String(row.checkpointId),
              projectId: String(row.projectId),
              taskId: ProjectWorkTaskId.make(String(row.taskId)),
              attemptId: ProjectWorkAttemptId.make(String(row.attemptId)),
              ...(row.ref ? { ref: String(row.ref) } : {}),
              capturedAt: String(row.capturedAt),
              revision: Number(row.revision),
              ...(row.attributionJson
                ? {
                    attribution: parse(row.attributionJson as string, undefined),
                  }
                : {}),
            }) as unknown as ProjectWorkCheckpoint,
        ),
      ),
    );
  };

  const listKnowledge: ProjectWorkQueryShape["listKnowledge"] = (input) => {
    const page = bounds(input.limit, input.offset, input.trusted);
    return query(
      sql<
        Record<string, unknown>
      >`SELECT knowledge_id AS knowledgeId, project_id AS projectId, title, body, source_kind AS sourceKind, source_id AS sourceId, revision, supersedes_knowledge_id AS supersedesKnowledgeId, created_at AS createdAt, updated_at AS updatedAt, attribution_json AS attributionJson FROM project_work_knowledge WHERE project_id = ${input.projectId} ORDER BY updated_at DESC, knowledge_id ASC LIMIT ${page.limit} OFFSET ${page.offset}`,
    ).pipe(
      Effect.map((rows) =>
        rows.map(
          (row) =>
            ({
              knowledgeId: String(row.knowledgeId) as ProjectWorkKnowledgeId,
              projectId: String(row.projectId) as ProjectWorkKnowledge["projectId"],
              title: String(row.title),
              body: String(row.body),
              sourceKind: String(row.sourceKind) as ProjectWorkKnowledge["sourceKind"],
              sourceId: String(row.sourceId),
              revision: Number(row.revision),
              ...(row.supersedesKnowledgeId
                ? {
                    supersedesKnowledgeId: String(
                      row.supersedesKnowledgeId,
                    ) as ProjectWorkKnowledgeId,
                  }
                : {}),
              createdAt: String(row.createdAt),
              updatedAt: String(row.updatedAt),
              ...(row.attributionJson
                ? {
                    attribution: parse(row.attributionJson as string, undefined),
                  }
                : {}),
            }) as unknown as ProjectWorkKnowledge,
        ),
      ),
    );
  };

  const listDecisions: ProjectWorkQueryShape["listDecisions"] = (input) => {
    const page = bounds(input.limit, input.offset, input.trusted);
    return query(
      sql<
        Record<string, unknown>
      >`SELECT decision_id AS decisionId, project_id AS projectId, title, body, state, supersedes_decision_id AS supersedesDecisionId, rejection_reason AS rejectionReason, rejected_at AS rejectedAt, state_transition_attribution_json AS stateTransitionAttributionJson, revision, created_at AS createdAt, updated_at AS updatedAt, attribution_json AS attributionJson FROM project_work_decisions WHERE project_id = ${input.projectId} ${input.state === undefined ? sql`` : sql`AND state = ${input.state}`} ORDER BY updated_at DESC, decision_id ASC LIMIT ${page.limit} OFFSET ${page.offset}`,
    ).pipe(
      Effect.map((rows) =>
        rows.map(
          (row) =>
            ({
              decisionId: String(row.decisionId) as ProjectWorkDecisionId,
              projectId: String(row.projectId) as ProjectWorkDecision["projectId"],
              title: String(row.title),
              body: String(row.body),
              state: String(row.state) as ProjectWorkDecision["state"],
              ...(row.supersedesDecisionId
                ? {
                    supersedesDecisionId: String(row.supersedesDecisionId) as ProjectWorkDecisionId,
                  }
                : {}),
              ...(row.rejectionReason ? { rejectionReason: String(row.rejectionReason) } : {}),
              ...(row.rejectedAt ? { rejectedAt: String(row.rejectedAt) } : {}),
              ...(row.stateTransitionAttributionJson
                ? {
                    stateTransitionAttribution: parse(
                      row.stateTransitionAttributionJson as string,
                      undefined,
                    ),
                  }
                : {}),
              revision: Number(row.revision),
              createdAt: String(row.createdAt),
              updatedAt: String(row.updatedAt),
              ...(row.attributionJson
                ? {
                    attribution: parse(row.attributionJson as string, undefined),
                  }
                : {}),
            }) as unknown as ProjectWorkDecision,
        ),
      ),
    );
  };

  const listComments: ProjectWorkQueryShape["listComments"] = (input) => {
    const page = bounds(input.limit, input.offset, input.trusted);
    return query(
      sql<
        Record<string, unknown>
      >`SELECT comment_id AS commentId, project_id AS projectId, task_id AS taskId, body, created_at AS createdAt, revision, attribution_json AS attributionJson FROM project_work_comments WHERE project_id = ${input.projectId} ${input.taskId === undefined ? sql`` : sql`AND task_id = ${input.taskId}`} ORDER BY created_at DESC, comment_id DESC LIMIT ${page.limit} OFFSET ${page.offset}`,
    ).pipe(
      Effect.map((rows) =>
        rows.map(
          (row) =>
            ({
              commentId: String(row.commentId) as ProjectWorkCommentId,
              projectId: String(row.projectId) as ProjectWorkComment["projectId"],
              ...(row.taskId ? { taskId: String(row.taskId) as ProjectWorkTaskId } : {}),
              body: String(row.body),
              createdAt: String(row.createdAt),
              revision: Number(row.revision),
              ...(row.attributionJson
                ? {
                    attribution: parse(row.attributionJson as string, undefined),
                  }
                : {}),
            }) as unknown as ProjectWorkComment,
        ),
      ),
    );
  };

  const readSnapshot = (projectId: string) =>
    Effect.all({
      revision: getProjectRevision(projectId),
      tasks: listTasks({ projectId, trusted: true }),
      attempts: listAttempts({ projectId, trusted: true }),
      criteria: listCriteria({ projectId, trusted: true }),
      evidence: listEvidence({ projectId, trusted: true }),
      relationships: listRelationships({ projectId, trusted: true }),
      blockers: listBlockers({ projectId, trusted: true }),
      attention: listAttention({ projectId, trusted: true }),
      activities: listActivities({ projectId, trusted: true }),
      checkpoints: listCheckpoints({ projectId, trusted: true }),
      knowledge: listKnowledge({ projectId, trusted: true }),
      decisions: listDecisions({ projectId, trusted: true }),
      comments: listComments({ projectId, trusted: true }),
    }).pipe(Effect.map(({ revision, ...value }) => ({ projectId, revision, ...value })));

  const snapshot: ProjectWorkQueryShape["snapshot"] = (projectId) =>
    sql
      .withTransaction(readSnapshot(projectId))
      .pipe(Effect.mapError((cause) => toPersistenceSqlError("ProjectWorkQuery.snapshot")(cause)));

  const briefingSnapshot: ProjectWorkQueryShape["briefingSnapshot"] = (projectId, maxKnowledge) =>
    sql
      .withTransaction(
        Effect.all({
          revision: getProjectRevision(projectId),
          tasks: listTasks({ projectId, trusted: true }),
          attempts: listAttempts({ projectId, trusted: true }),
          criteria: listCriteria({ projectId, trusted: true }),
          blockers: listBlockers({ projectId, trusted: true }),
          attention: listAttention({ projectId, trusted: true }),
          knowledge: listKnowledge({ projectId, limit: maxKnowledge, trusted: true }),
        }).pipe(
          Effect.map((value) => ({
            projectId,
            ...value,
            evidence: [],
            relationships: [],
            activities: [],
            checkpoints: [],
            decisions: [],
            comments: [],
          })),
        ),
      )
      .pipe(
        Effect.mapError((cause) =>
          toPersistenceSqlError("ProjectWorkQuery.briefingSnapshot")(cause),
        ),
      );

  const exportSnapshot: ProjectWorkQueryShape["exportSnapshot"] = (projectId, includeHistory) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* readSnapshot(projectId);
          if (!includeHistory) return { snapshot: current };
          const rows = yield* sql<Record<string, unknown>>`
            SELECT payload_json AS payloadJson
            FROM project_work_events
            WHERE project_id = ${projectId}
            ORDER BY sequence ASC
          `;
          const history = rows
            .map((row) => parse<unknown>(String(row.payloadJson), undefined))
            .filter((event): event is Record<string, unknown> => {
              if (event === null || typeof event !== "object") return false;
              const record = event as Record<string, unknown>;
              return typeof record.revision === "number" && record.revision <= current.revision;
            });
          return { snapshot: current, history };
        }),
      )
      .pipe(
        Effect.mapError((cause) => toPersistenceSqlError("ProjectWorkQuery.exportSnapshot")(cause)),
      );

  const getTaskContext: ProjectWorkQueryShape["getTaskContext"] = (projectId, taskId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const task = yield* getTask(projectId, taskId);
          if (Option.isNone(task)) return Option.none<ProjectWorkTaskContext>();
          const [
            revision,
            attempts,
            criteria,
            evidence,
            relationships,
            blockers,
            attention,
            comments,
          ] = yield* Effect.all([
            getProjectRevision(projectId),
            listAttempts({ projectId, taskId, trusted: true, canonical: true }),
            listCriteria({ projectId, taskId, trusted: true }),
            listEvidence({ projectId, taskId, trusted: true }),
            listRelationships({ projectId, taskId, trusted: true }),
            listBlockers({ projectId, taskId, trusted: true }),
            listAttention({ projectId, taskId, trusted: true }),
            listComments({ projectId, taskId, trusted: true }),
          ]);
          const relatedTaskRows = yield* query(sql<Record<string, unknown>>`
            SELECT task_id AS taskId, project_id AS projectId, title, summary, state,
              specification_json AS specificationJson, assignee_json AS assigneeJson,
              watchers_json AS watchersJson, approval_json AS approvalJson, revision,
              spec_revision AS specRevision, active_attempt_id AS activeAttemptId,
              failure_kind AS failureKind, blocker_id AS blockerId, created_at AS createdAt,
              updated_at AS updatedAt, completed_at AS completedAt, canceled_at AS canceledAt,
              attribution_json AS attributionJson
            FROM project_work_tasks
            WHERE project_id = ${projectId} AND task_id IN (
              SELECT CASE WHEN from_task_id = ${taskId} THEN to_task_id ELSE from_task_id END
              FROM project_work_relationships
              WHERE project_id = ${projectId}
                AND (from_task_id = ${taskId} OR to_task_id = ${taskId})
            )
            ORDER BY task_id ASC
          `);
          const activeAttempt = attempts.find(
            (attempt) => attempt.state === "leased" || attempt.state === "running",
          );
          const reclaimableAttempt = [...attempts]
            .reverse()
            .find(
              (attempt) =>
                (attempt.state === "failed" || attempt.state === "expired") &&
                attempt.failureResolvedAt === undefined,
            );
          const policy = deriveProjectWorkTaskPolicy(
            {
              projectId,
              revision,
              tasks: [task.value, ...relatedTaskRows.map(toTask)],
              attempts: [...attempts],
              criteria: [...criteria],
              evidence: [...evidence],
              relationships: [...relationships],
              blockers: [...blockers],
              attention: [...attention],
            },
            taskId,
          );
          const children = {
            criteria: criteria.slice(0, 100),
            evidence: evidence.slice(0, 100),
            relationships: relationships.slice(0, 100),
            blockers: blockers.slice(0, 100),
            comments: comments.slice(0, 100),
          };
          return Option.some({
            projectId: task.value.projectId,
            revision,
            task: task.value,
            ...(activeAttempt === undefined ? {} : { activeAttempt }),
            ...(reclaimableAttempt === undefined ? {} : { reclaimableAttempt }),
            ...children,
            children,
            policy,
          } as ProjectWorkTaskContext);
        }),
      )
      .pipe(
        Effect.mapError((cause) => toPersistenceSqlError("ProjectWorkQuery.getTaskContext")(cause)),
      );

  return {
    getProjectRevision,
    withProjectRevision,
    getTask,
    getProjectWorkTask: getTask,
    listTasks,
    listProjectWorkTasks: listTasks,
    listAttempts,
    getActiveAttempt,
    getTaskContext,
    listCriteria,
    listEvidence,
    listRelationships,
    listBlockers,
    listAttention,
    listActivities,
    listCheckpoints,
    listKnowledge,
    listDecisions,
    listComments,
    snapshot,
    briefingSnapshot,
    getSnapshot: snapshot,
    exportSnapshot,
  } satisfies ProjectWorkQueryShape;
});

export const ProjectWorkQueryLive = Layer.effect(ProjectWorkQuery, makeProjectWorkQuery);
