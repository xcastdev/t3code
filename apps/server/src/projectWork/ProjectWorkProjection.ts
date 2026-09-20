import {
  EventId,
  ProjectWorkTaskId,
  ProjectWorkAttemptId,
  ProjectWorkKnowledgeId,
  ProjectWorkDecisionId,
  ProjectWorkCommentId,
  ProjectWorkCriterionId,
  ProjectWorkEvidenceId,
  ProjectWorkRelationshipId,
  ProjectWorkBlockerId,
  type ProjectWorkAttempt,
  type ProjectWorkComment,
  type ProjectWorkDecision,
  type ProjectWorkKnowledge,
  type ProjectWorkTask,
  type ProjectWorkCriterion,
  type ProjectWorkEvidence,
  type ProjectWorkRelationship,
  type ProjectWorkBlocker,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  applyProjectWorkEvents,
  emptyProjectWorkReducerState,
  type ProjectWorkActivity,
  type ProjectWorkCheckpoint,
  type ProjectWorkEvent,
  type ProjectWorkReducerState,
  type ProjectWorkState,
} from "./ProjectWorkDecider.ts";
import { toPersistenceSqlError, type ProjectionRepositoryError } from "../persistence/Errors.ts";

export type { ProjectWorkActivity, ProjectWorkCheckpoint } from "./ProjectWorkDecider.ts";
export type ProjectWorkProjectionEvent = ProjectWorkEvent;

class ProjectWorkProjectionDecodeError extends Schema.TaggedError<ProjectWorkProjectionDecodeError>()(
  "ProjectWorkProjectionDecodeError",
  { detail: Schema.String },
) {}
const isProjectWorkProjectionDecodeError = Schema.is(ProjectWorkProjectionDecodeError);

export interface ProjectWorkProjectionState extends ProjectWorkReducerState {
  checkpoints: Array<ProjectWorkCheckpoint>;
  activities: Array<ProjectWorkActivity>;
  knowledge: Array<ProjectWorkKnowledge>;
  decisions: Array<ProjectWorkDecision>;
  comments: Array<ProjectWorkComment>;
}

export const emptyProjectWorkProjectionState = (projectId: string): ProjectWorkProjectionState => ({
  ...emptyProjectWorkReducerState(projectId),
  checkpoints: [],
  activities: [],
  knowledge: [],
  decisions: [],
  comments: [],
});

/** Pure reducer entry point for tests; SQL writes are owned by the repository. */
export function applyProjectWorkProjectionEvent(
  state: ProjectWorkProjectionState,
  event: ProjectWorkProjectionEvent,
): ProjectWorkProjectionState {
  return applyProjectWorkEvents(state, [event]) as ProjectWorkProjectionState;
}

export const applyProjectWorkProjectionEvents = (
  state: ProjectWorkProjectionState,
  events: ReadonlyArray<ProjectWorkProjectionEvent>,
): ProjectWorkProjectionState =>
  applyProjectWorkEvents(state, events) as ProjectWorkProjectionState;

const json = (value: unknown): string => JSON.stringify(value);
const readJson = <A>(value: unknown, fallback: A): A => {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as A;
  } catch {
    return fallback;
  }
};

export const ensureProjectWorkTables = (sql: SqlClient.SqlClient) =>
  Effect.all([
    sql`CREATE TABLE IF NOT EXISTS project_work_activity (activity_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT, attempt_id TEXT, kind TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT, occurred_at TEXT NOT NULL, revision INTEGER NOT NULL, attribution_json TEXT)`,
    sql`CREATE TABLE IF NOT EXISTS project_work_checkpoints (checkpoint_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, ref TEXT, captured_at TEXT NOT NULL, revision INTEGER NOT NULL, attribution_json TEXT)`,
    sql`CREATE TABLE IF NOT EXISTS project_work_projection_state (projector TEXT PRIMARY KEY, last_applied_sequence INTEGER NOT NULL DEFAULT 0, rebuild_generation INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`,
    sql`CREATE TABLE IF NOT EXISTS project_work_reducer_checkpoints (project_id TEXT PRIMARY KEY, last_sequence INTEGER NOT NULL, state_json TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    sql`CREATE TABLE IF NOT EXISTS project_work_command_receipts (project_id TEXT NOT NULL, command_id TEXT NOT NULL, payload_fingerprint TEXT NOT NULL, actor_kind TEXT, actor_id TEXT, source_kind TEXT, source_id TEXT, event_ids_json TEXT NOT NULL, created_at TEXT NOT NULL, result_json TEXT, PRIMARY KEY (project_id, command_id))`,
    sql`ALTER TABLE project_work_command_receipts ADD COLUMN result_json TEXT`.pipe(
      Effect.catch(() => Effect.succeed([])),
    ),
    // Keep focused repositories usable against a pre-011 test database; the
    // registered fork migration remains the production schema authority.
    sql`CREATE TABLE IF NOT EXISTS project_work_attention_occurrences (occurrence_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL, reason TEXT NOT NULL, detail TEXT, revision INTEGER NOT NULL, occurred_at TEXT NOT NULL, resolved_at TEXT, UNIQUE (project_id, task_id, reason, revision))`,
    sql`CREATE TABLE IF NOT EXISTS project_work_notification_publications (publication_id TEXT PRIMARY KEY, occurrence_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, task_id TEXT NOT NULL, reason TEXT NOT NULL, detail TEXT, task_state TEXT NOT NULL, revision INTEGER NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL, owner_id TEXT, claim_token TEXT, claimed_until TEXT, delivered_destination_ids_json TEXT NOT NULL DEFAULT '[]', failed_destination_ids_json TEXT NOT NULL DEFAULT '[]', last_error TEXT, outcome_json TEXT, created_at TEXT NOT NULL, delivered_at TEXT)`,
    sql`CREATE INDEX IF NOT EXISTS idx_project_work_notification_publications_queue ON project_work_notification_publications(status, available_at, claimed_until, publication_id)`,
  ]);

const taskFrom = (row: Record<string, unknown>): ProjectWorkTask =>
  ({
    taskId: ProjectWorkTaskId.make(String(row.taskId)),
    projectId: String(row.projectId) as ProjectWorkTask["projectId"],
    title: String(row.title),
    ...(row.summary == null ? {} : { summary: String(row.summary) }),
    state: String(row.state) as ProjectWorkTask["state"],
    ...(row.specificationJson == null
      ? {}
      : { specification: readJson(row.specificationJson, undefined) }),
    ...(row.assigneeJson == null ? {} : { assignee: readJson(row.assigneeJson, undefined) }),
    watchers: readJson(row.watchersJson, []),
    ...(row.approvalJson == null ? {} : { approval: readJson(row.approvalJson, undefined) }),
    revision: Number(row.revision),
    specRevision: Number(row.specRevision),
    ...(row.activeAttemptId == null
      ? {}
      : { activeAttemptId: ProjectWorkAttemptId.make(String(row.activeAttemptId)) }),
    ...(row.failureKind == null
      ? {}
      : { failureKind: String(row.failureKind) as ProjectWorkTask["failureKind"] }),
    ...(row.blockerId == null
      ? {}
      : { blockerId: ProjectWorkBlockerId.make(String(row.blockerId)) }),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    ...(row.completedAt == null ? {} : { completedAt: String(row.completedAt) }),
    ...(row.canceledAt == null ? {} : { canceledAt: String(row.canceledAt) }),
    ...(row.attributionJson == null
      ? {}
      : { attribution: readJson(row.attributionJson, undefined) }),
  }) as unknown as ProjectWorkTask;

const attemptFrom = (row: Record<string, unknown>): ProjectWorkAttempt =>
  ({
    attemptId: ProjectWorkAttemptId.make(String(row.attemptId)),
    taskId: ProjectWorkTaskId.make(String(row.taskId)),
    state: String(row.state) as ProjectWorkAttempt["state"],
    ...(row.leaseToken == null ? {} : { leaseToken: String(row.leaseToken) }),
    ...(row.leasedUntil == null ? {} : { leasedUntil: String(row.leasedUntil) }),
    ...(row.startedAt == null ? {} : { startedAt: String(row.startedAt) }),
    ...(row.endedAt == null ? {} : { endedAt: String(row.endedAt) }),
    ...(row.failureKind == null
      ? {}
      : { failureKind: String(row.failureKind) as ProjectWorkAttempt["failureKind"] }),
    ...(row.failureReason == null ? {} : { failureReason: String(row.failureReason) }),
    ...(row.failureEvidenceIdsJson == null
      ? {}
      : { failureEvidenceIds: readJson(row.failureEvidenceIdsJson, []) }),
    ...(row.failureResolvedAt == null ? {} : { failureResolvedAt: String(row.failureResolvedAt) }),
    ...(row.failureResolutionReason == null
      ? {}
      : { failureResolutionReason: String(row.failureResolutionReason) }),
    ...(row.failureResolutionEvidenceIdsJson == null
      ? {}
      : { failureResolutionEvidenceIds: readJson(row.failureResolutionEvidenceIdsJson, []) }),
    ...(row.failureResolutionAttributionJson == null
      ? {}
      : {
          failureResolutionAttribution: readJson(row.failureResolutionAttributionJson, undefined),
        }),
    checkpointIds: readJson(row.checkpointIdsJson, []),
    revision: Number(row.revision),
    ...(row.attributionJson == null
      ? {}
      : { attribution: readJson(row.attributionJson, undefined) }),
  }) as unknown as ProjectWorkAttempt;

export const readProjectWorkState = (sql: SqlClient.SqlClient, projectId: string) =>
  Effect.gen(function* () {
    const state = emptyProjectWorkProjectionState(projectId);
    const tasks = yield* sql<
      Record<string, unknown>
    >`SELECT task_id AS taskId, project_id AS projectId, title, summary, state, specification_json AS specificationJson, assignee_json AS assigneeJson, watchers_json AS watchersJson, approval_json AS approvalJson, revision, spec_revision AS specRevision, active_attempt_id AS activeAttemptId, failure_kind AS failureKind, blocker_id AS blockerId, created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt, canceled_at AS canceledAt, attribution_json AS attributionJson FROM project_work_tasks WHERE project_id = ${projectId}`;
    state.tasks.push(...tasks.map(taskFrom));
    const attempts = yield* sql<
      Record<string, unknown>
    >`SELECT attempt_id AS attemptId, task_id AS taskId, state, lease_token AS leaseToken, leased_until AS leasedUntil, started_at AS startedAt, ended_at AS endedAt, failure_kind AS failureKind, failure_reason AS failureReason, failure_evidence_ids_json AS failureEvidenceIdsJson, failure_resolved_at AS failureResolvedAt, failure_resolution_reason AS failureResolutionReason, failure_resolution_evidence_ids_json AS failureResolutionEvidenceIdsJson, failure_resolution_attribution_json AS failureResolutionAttributionJson, checkpoint_ids_json AS checkpointIdsJson, revision, attribution_json AS attributionJson FROM project_work_attempts WHERE project_id = ${projectId}`;
    state.attempts.push(...attempts.map(attemptFrom));
    const criteria = yield* sql<
      Record<string, unknown>
    >`SELECT criterion_id AS criterionId, task_id AS taskId, description, required, status, satisfied_by_evidence_ids_json AS satisfiedJson, waiver_json AS waiverJson, revision, updated_at AS updatedAt FROM project_work_criteria WHERE project_id = ${projectId}`;
    state.criteria.push(
      ...criteria.map(
        (row) =>
          ({
            criterionId: ProjectWorkCriterionId.make(String(row.criterionId)),
            taskId: ProjectWorkTaskId.make(String(row.taskId)),
            description: String(row.description),
            required: Number(row.required) === 1,
            status: String(row.status) as ProjectWorkCriterion["status"],
            satisfiedByEvidenceIds: readJson(row.satisfiedJson, []),
            ...(row.waiverJson == null ? {} : { waiver: readJson(row.waiverJson, undefined) }),
            revision: Number(row.revision),
            updatedAt: String(row.updatedAt),
          }) as unknown as ProjectWorkCriterion,
      ),
    );
    const evidence = yield* sql<
      Record<string, unknown>
    >`SELECT evidence_id AS evidenceId, task_id AS taskId, criterion_id AS criterionId, kind, summary, detail, uri, recorded_at AS recordedAt, revision, attribution_json AS attributionJson FROM project_work_evidence WHERE project_id = ${projectId}`;
    state.evidence.push(
      ...evidence.map(
        (row) =>
          ({
            evidenceId: ProjectWorkEvidenceId.make(String(row.evidenceId)),
            ...(row.taskId == null ? {} : { taskId: ProjectWorkTaskId.make(String(row.taskId)) }),
            ...(row.criterionId == null
              ? {}
              : { criterionId: ProjectWorkCriterionId.make(String(row.criterionId)) }),
            kind: String(row.kind) as ProjectWorkEvidence["kind"],
            summary: String(row.summary),
            ...(row.detail == null ? {} : { detail: String(row.detail) }),
            ...(row.uri == null ? {} : { uri: String(row.uri) }),
            recordedAt: String(row.recordedAt),
            revision: Number(row.revision),
            ...(row.attributionJson == null
              ? {}
              : { attribution: readJson(row.attributionJson, undefined) }),
          }) as unknown as ProjectWorkEvidence,
      ),
    );
    const relationships = yield* sql<
      Record<string, unknown>
    >`SELECT relationship_id AS relationshipId, from_task_id AS fromTaskId, to_task_id AS toTaskId, kind, revision, created_at AS createdAt, attribution_json AS attributionJson FROM project_work_relationships WHERE project_id = ${projectId}`;
    state.relationships.push(
      ...relationships.map(
        (row) =>
          ({
            relationshipId: ProjectWorkRelationshipId.make(String(row.relationshipId)),
            projectId: projectId as ProjectWorkRelationship["projectId"],
            fromTaskId: ProjectWorkTaskId.make(String(row.fromTaskId)),
            toTaskId: ProjectWorkTaskId.make(String(row.toTaskId)),
            kind: String(row.kind) as ProjectWorkRelationship["kind"],
            revision: Number(row.revision),
            createdAt: String(row.createdAt),
            ...(row.attributionJson == null
              ? {}
              : { attribution: readJson(row.attributionJson, undefined) }),
          }) as unknown as ProjectWorkRelationship,
      ),
    );
    const blockers = yield* sql<
      Record<string, unknown>
    >`SELECT blocker_id AS blockerId, task_id AS taskId, reason, resolver, reference_ids_json AS referenceIdsJson, attention, resolved_at AS resolvedAt, revision, attribution_json AS attributionJson FROM project_work_blockers WHERE project_id = ${projectId}`;
    state.blockers.push(
      ...blockers.map(
        (row) =>
          ({
            blockerId: ProjectWorkBlockerId.make(String(row.blockerId)),
            taskId: ProjectWorkTaskId.make(String(row.taskId)),
            reason: String(row.reason),
            resolver: String(row.resolver),
            referenceIds: readJson(row.referenceIdsJson, []),
            attention: Number(row.attention) === 1,
            ...(row.resolvedAt == null ? {} : { resolvedAt: String(row.resolvedAt) }),
            revision: Number(row.revision),
            ...(row.attributionJson == null
              ? {}
              : { attribution: readJson(row.attributionJson, undefined) }),
          }) as unknown as ProjectWorkBlocker,
      ),
    );
    const attention = yield* sql<
      Record<string, unknown>
    >`SELECT task_id AS taskId, reason, detail, seen_at AS seenAt, resolved_at AS resolvedAt, revision FROM project_work_attention WHERE project_id = ${projectId}`;
    state.attention.push(
      ...attention.map((row) => ({
        taskId: ProjectWorkTaskId.make(String(row.taskId)),
        reason: String(row.reason) as ProjectWorkState["attention"][number]["reason"],
        ...(row.detail == null ? {} : { detail: String(row.detail) }),
        ...(row.seenAt == null ? {} : { seenAt: String(row.seenAt) }),
        ...(row.resolvedAt == null ? {} : { resolvedAt: String(row.resolvedAt) }),
        revision: Number(row.revision),
      })),
    );
    const checkpoints = yield* sql<
      Record<string, unknown>
    >`SELECT checkpoint_id AS checkpointId, task_id AS taskId, attempt_id AS attemptId, ref, captured_at AS capturedAt, revision, attribution_json AS attributionJson FROM project_work_checkpoints WHERE project_id = ${projectId}`;
    state.checkpoints.push(
      ...checkpoints.map(
        (row) =>
          ({
            checkpointId: String(row.checkpointId),
            projectId,
            taskId: ProjectWorkTaskId.make(String(row.taskId)),
            attemptId: ProjectWorkAttemptId.make(String(row.attemptId)),
            ...(row.ref == null ? {} : { ref: String(row.ref) }),
            capturedAt: String(row.capturedAt),
            revision: Number(row.revision),
            ...(row.attributionJson == null
              ? {}
              : { attribution: readJson(row.attributionJson, undefined) }),
          }) as unknown as ProjectWorkCheckpoint,
      ),
    );
    const activities = yield* sql<
      Record<string, unknown>
    >`SELECT activity_id AS activityId, task_id AS taskId, attempt_id AS attemptId, kind, summary, detail, occurred_at AS occurredAt, revision, attribution_json AS attributionJson FROM project_work_activity WHERE project_id = ${projectId}`;
    state.activities.push(
      ...activities.map(
        (row) =>
          ({
            activityId: String(row.activityId),
            projectId,
            ...(row.taskId == null ? {} : { taskId: ProjectWorkTaskId.make(String(row.taskId)) }),
            ...(row.attemptId == null
              ? {}
              : { attemptId: ProjectWorkAttemptId.make(String(row.attemptId)) }),
            kind: String(row.kind),
            summary: String(row.summary),
            ...(row.detail == null ? {} : { detail: String(row.detail) }),
            occurredAt: String(row.occurredAt),
            revision: Number(row.revision),
            ...(row.attributionJson == null
              ? {}
              : { attribution: readJson(row.attributionJson, undefined) }),
          }) as unknown as ProjectWorkActivity,
      ),
    );
    const knowledge = yield* sql<
      Record<string, unknown>
    >`SELECT knowledge_id AS knowledgeId, title, body, source_kind AS sourceKind, source_id AS sourceId, revision, supersedes_knowledge_id AS supersedesKnowledgeId, created_at AS createdAt, updated_at AS updatedAt, attribution_json AS attributionJson FROM project_work_knowledge WHERE project_id = ${projectId}`;
    state.knowledge.push(
      ...knowledge.map(
        (row) =>
          ({
            knowledgeId: ProjectWorkKnowledgeId.make(String(row.knowledgeId)),
            projectId: projectId as ProjectWorkKnowledge["projectId"],
            title: String(row.title),
            body: String(row.body),
            sourceKind: String(row.sourceKind) as ProjectWorkKnowledge["sourceKind"],
            sourceId: String(row.sourceId),
            revision: Number(row.revision),
            ...(row.supersedesKnowledgeId == null
              ? {}
              : {
                  supersedesKnowledgeId: ProjectWorkKnowledgeId.make(
                    String(row.supersedesKnowledgeId),
                  ),
                }),
            createdAt: String(row.createdAt),
            updatedAt: String(row.updatedAt),
            ...(row.attributionJson == null
              ? {}
              : { attribution: readJson(row.attributionJson, undefined) }),
          }) as unknown as ProjectWorkKnowledge,
      ),
    );
    const decisions = yield* sql<
      Record<string, unknown>
    >`SELECT decision_id AS decisionId, title, body, state, supersedes_decision_id AS supersedesDecisionId, rejection_reason AS rejectionReason, rejected_at AS rejectedAt, state_transition_attribution_json AS stateTransitionAttributionJson, revision, created_at AS createdAt, updated_at AS updatedAt, attribution_json AS attributionJson FROM project_work_decisions WHERE project_id = ${projectId}`;
    state.decisions.push(
      ...decisions.map(
        (row) =>
          ({
            decisionId: ProjectWorkDecisionId.make(String(row.decisionId)),
            projectId: projectId as ProjectWorkDecision["projectId"],
            title: String(row.title),
            body: String(row.body),
            state: String(row.state) as ProjectWorkDecision["state"],
            ...(row.supersedesDecisionId == null
              ? {}
              : {
                  supersedesDecisionId: ProjectWorkDecisionId.make(
                    String(row.supersedesDecisionId),
                  ),
                }),
            ...(row.rejectionReason == null
              ? {}
              : { rejectionReason: String(row.rejectionReason) }),
            ...(row.rejectedAt == null ? {} : { rejectedAt: String(row.rejectedAt) }),
            ...(row.stateTransitionAttributionJson == null
              ? {}
              : {
                  stateTransitionAttribution: readJson(
                    row.stateTransitionAttributionJson,
                    undefined,
                  ),
                }),
            revision: Number(row.revision),
            createdAt: String(row.createdAt),
            updatedAt: String(row.updatedAt),
            ...(row.attributionJson == null
              ? {}
              : { attribution: readJson(row.attributionJson, undefined) }),
          }) as unknown as ProjectWorkDecision,
      ),
    );
    const comments = yield* sql<
      Record<string, unknown>
    >`SELECT comment_id AS commentId, task_id AS taskId, body, created_at AS createdAt, revision, attribution_json AS attributionJson FROM project_work_comments WHERE project_id = ${projectId}`;
    state.comments.push(
      ...comments.map(
        (row) =>
          ({
            commentId: ProjectWorkCommentId.make(String(row.commentId)),
            projectId: projectId as ProjectWorkComment["projectId"],
            ...(row.taskId == null ? {} : { taskId: ProjectWorkTaskId.make(String(row.taskId)) }),
            body: String(row.body),
            createdAt: String(row.createdAt),
            revision: Number(row.revision),
            ...(row.attributionJson == null
              ? {}
              : { attribution: readJson(row.attributionJson, undefined) }),
          }) as unknown as ProjectWorkComment,
      ),
    );
    const eventRows = yield* sql<
      Record<string, unknown>
    >`SELECT payload_json AS payloadJson FROM project_work_events WHERE project_id = ${projectId} ORDER BY sequence ASC`;
    state.history = eventRows.map((row) => {
      const event = JSON.parse(String(row.payloadJson)) as {
        readonly eventId: string;
        readonly type: string;
        readonly revision: number;
        readonly occurredAt: string;
      };
      return {
        eventId: EventId.make(event.eventId),
        type: event.type as never,
        revision: event.revision,
        occurredAt: event.occurredAt,
      };
    });
    state.revision = Math.max(
      0,
      ...state.history.map((entry) => entry.revision),
      ...state.activities.map((entry) => entry.revision),
      ...state.tasks.map((entry) => entry.revision),
      ...state.attempts.map((entry) => entry.revision),
    );
    return state;
  });

export interface ProjectWorkProjectionPersistOptions {
  /** The authoritative event-log sequence represented by this snapshot. */
  readonly lastAppliedSequence?: number;
  readonly updatedAt?: string;
  /** Previous reducer state enables event-scoped normalized/FTS persistence. */
  readonly previousState?: ProjectWorkProjectionState;
}

/** Fast path for the most common append-only mutation. The reducer checkpoint
 * still contains the complete authoritative state, while normalized rows and
 * FTS receive only the two records introduced by task creation. A full rebuild
 * remains able to derive the identical projection from the event log. */
export const persistProjectWorkTaskCreated = (
  sql: SqlClient.SqlClient,
  state: ProjectWorkProjectionState,
  event: Extract<ProjectWorkEvent, { readonly type: "project-work.task.created" }>,
  lastAppliedSequence: number,
) =>
  Effect.gen(function* () {
    const task = event.task;
    const activity = state.activities.find((entry) => entry.activityId === String(event.eventId));
    if (activity === undefined) throw new Error(`Missing activity for event '${event.eventId}'.`);
    yield* sql`INSERT INTO project_work_tasks (task_id, project_id, title, summary, state, specification_json, assignee_json, watchers_json, approval_json, revision, spec_revision, active_attempt_id, failure_kind, blocker_id, created_at, updated_at, completed_at, canceled_at, attribution_json) VALUES (${task.taskId}, ${event.projectId}, ${task.title}, ${task.summary ?? null}, ${task.state}, ${task.specification === undefined ? null : json(task.specification)}, ${task.assignee === undefined ? null : json(task.assignee)}, ${json(task.watchers ?? [])}, ${task.approval === undefined ? null : json(task.approval)}, ${task.revision}, ${task.specRevision}, ${task.activeAttemptId ?? null}, ${task.failureKind ?? null}, ${task.blockerId ?? null}, ${task.createdAt}, ${task.updatedAt}, ${task.completedAt ?? null}, ${task.canceledAt ?? null}, ${task.attribution === undefined ? null : json(task.attribution)})`;
    yield* sql`INSERT INTO project_work_activity (activity_id, project_id, task_id, attempt_id, kind, summary, detail, occurred_at, revision, attribution_json) VALUES (${activity.activityId}, ${event.projectId}, ${activity.taskId ?? null}, ${activity.attemptId ?? null}, ${activity.kind}, ${activity.summary}, ${activity.detail ?? null}, ${activity.occurredAt}, ${activity.revision}, ${activity.attribution === undefined ? null : json(activity.attribution)})`;
    yield* sql`INSERT INTO project_work_search_fts (project_id, record_kind, record_id, title, body, provenance_json, revision) VALUES (${event.projectId}, ${"task"}, ${task.taskId}, ${task.title}, ${(task.summary ?? "") + (task.specification === undefined ? "" : ` ${json(task.specification)}`)}, ${task.attribution === undefined ? json({ taskId: task.taskId, state: task.state }) : json({ ...task.attribution, taskId: task.taskId, state: task.state })}, ${task.revision})`;
    yield* sql`INSERT INTO project_work_search_fts (project_id, record_kind, record_id, title, body, provenance_json, revision) VALUES (${event.projectId}, ${"activity"}, ${activity.activityId}, ${activity.kind}, ${activity.summary + (activity.detail === undefined ? "" : ` ${activity.detail}`)}, ${activity.attribution === undefined ? json({ taskId: activity.taskId ?? null, attemptId: activity.attemptId ?? null }) : json({ ...activity.attribution, taskId: activity.taskId ?? null, attemptId: activity.attemptId ?? null })}, ${activity.revision})`;
    yield* sql`INSERT INTO project_work_projection_state (projector, last_applied_sequence, rebuild_generation, updated_at) VALUES (${"project-work:" + event.projectId}, ${lastAppliedSequence}, 0, ${event.occurredAt}) ON CONFLICT(projector) DO UPDATE SET last_applied_sequence = excluded.last_applied_sequence, updated_at = excluded.updated_at`;
    // @effect-diagnostics-next-line preferSchemaOverJson:off -- typed reducer state checkpoint.
    const stateJson = JSON.stringify(state);
    yield* sql`INSERT INTO project_work_reducer_checkpoints (project_id, last_sequence, state_json, updated_at) VALUES (${event.projectId}, ${lastAppliedSequence}, ${stateJson}, ${event.occurredAt}) ON CONFLICT(project_id) DO UPDATE SET last_sequence = excluded.last_sequence, state_json = excluded.state_json, updated_at = excluded.updated_at`;
  });

export const persistProjectWorkState = (
  sql: SqlClient.SqlClient,
  nextState: ProjectWorkProjectionState,
  projectId: string,
  options: ProjectWorkProjectionPersistOptions = {},
) =>
  Effect.gen(function* () {
    const previous = options.previousState;
    const changed = <A>(
      next: ReadonlyArray<A>,
      prior: ReadonlyArray<A>,
      key: (value: A) => string,
    ) => {
      const before = new Map(prior.map((value) => [key(value), value]));
      return next.filter((value) => {
        const old = before.get(key(value));
        if (old === undefined) return true;
        return (
          (old as { readonly revision?: unknown }).revision !==
          (value as { readonly revision?: unknown }).revision
        );
      });
    };
    const removed = <A>(
      next: ReadonlyArray<A>,
      prior: ReadonlyArray<A>,
      key: (value: A) => string,
    ) => {
      const retained = new Set(next.map(key));
      return prior.filter((value) => !retained.has(key(value)));
    };
    const select = <A>(
      next: ReadonlyArray<A>,
      prior: ReadonlyArray<A>,
      key: (value: A) => string,
    ) => (previous === undefined ? [...next] : changed(next, prior, key));
    const state: ProjectWorkProjectionState =
      previous === undefined
        ? nextState
        : {
            ...nextState,
            tasks: select(nextState.tasks, previous.tasks, (value) => String(value.taskId)),
            attempts: select(nextState.attempts, previous.attempts, (value) =>
              String(value.attemptId),
            ),
            criteria: select(nextState.criteria, previous.criteria, (value) =>
              String(value.criterionId),
            ),
            evidence: select(nextState.evidence, previous.evidence, (value) =>
              String(value.evidenceId),
            ),
            relationships: select(nextState.relationships, previous.relationships, (value) =>
              String(value.relationshipId),
            ),
            blockers: select(nextState.blockers, previous.blockers, (value) =>
              String(value.blockerId),
            ),
            checkpoints: select(nextState.checkpoints, previous.checkpoints, (value) =>
              String(value.checkpointId),
            ),
            activities: select(nextState.activities, previous.activities, (value) =>
              String(value.activityId),
            ),
            knowledge: select(nextState.knowledge, previous.knowledge, (value) =>
              String(value.knowledgeId),
            ),
            decisions: select(nextState.decisions, previous.decisions, (value) =>
              String(value.decisionId),
            ),
            comments: select(nextState.comments, previous.comments, (value) =>
              String(value.commentId),
            ),
            attention: select(
              nextState.attention,
              previous.attention,
              (value) => `${value.taskId}\u0000${value.reason}`,
            ),
          };
    if (previous !== undefined) {
      yield* sql`CREATE TEMP TABLE IF NOT EXISTS project_work_changed_fts (record_kind TEXT NOT NULL, record_id TEXT NOT NULL, PRIMARY KEY(record_kind, record_id)) WITHOUT ROWID`;
      yield* sql`DELETE FROM project_work_changed_fts`;
      const synchronize = <A>(input: {
        readonly table: string;
        readonly column: string;
        readonly kind?: string;
        readonly next: ReadonlyArray<A>;
        readonly allNext: ReadonlyArray<A>;
        readonly prior: ReadonlyArray<A>;
        readonly key: (value: A) => string;
      }) =>
        Effect.forEach(
          [...input.next, ...removed(input.allNext, input.prior, input.key)],
          (value) => {
            const id = input.key(value);
            return Effect.gen(function* () {
              // Table and column names are closed constants at call sites.
              yield* sql.unsafe(
                `DELETE FROM ${input.table} WHERE project_id = ? AND ${input.column} = ?`,
                [projectId, id],
              );
              if (input.kind !== undefined) {
                yield* sql`INSERT OR IGNORE INTO project_work_changed_fts (record_kind, record_id) VALUES (${input.kind}, ${id})`;
              }
            });
          },
          { discard: true },
        );
      yield* synchronize({
        table: "project_work_tasks",
        column: "task_id",
        kind: "task",
        next: state.tasks,
        allNext: nextState.tasks,
        prior: previous.tasks,
        key: (value) => String(value.taskId),
      });
      yield* synchronize({
        table: "project_work_attempts",
        column: "attempt_id",
        next: state.attempts,
        allNext: nextState.attempts,
        prior: previous.attempts,
        key: (value) => String(value.attemptId),
      });
      yield* synchronize({
        table: "project_work_criteria",
        column: "criterion_id",
        kind: "criterion",
        next: state.criteria,
        allNext: nextState.criteria,
        prior: previous.criteria,
        key: (value) => String(value.criterionId),
      });
      yield* synchronize({
        table: "project_work_evidence",
        column: "evidence_id",
        kind: "evidence",
        next: state.evidence,
        allNext: nextState.evidence,
        prior: previous.evidence,
        key: (value) => String(value.evidenceId),
      });
      yield* synchronize({
        table: "project_work_relationships",
        column: "relationship_id",
        next: state.relationships,
        allNext: nextState.relationships,
        prior: previous.relationships,
        key: (value) => String(value.relationshipId),
      });
      yield* synchronize({
        table: "project_work_blockers",
        column: "blocker_id",
        kind: "blocker",
        next: state.blockers,
        allNext: nextState.blockers,
        prior: previous.blockers,
        key: (value) => String(value.blockerId),
      });
      yield* synchronize({
        table: "project_work_checkpoints",
        column: "checkpoint_id",
        next: state.checkpoints,
        allNext: nextState.checkpoints,
        prior: previous.checkpoints,
        key: (value) => String(value.checkpointId),
      });
      yield* synchronize({
        table: "project_work_activity",
        column: "activity_id",
        kind: "activity",
        next: state.activities,
        allNext: nextState.activities,
        prior: previous.activities,
        key: (value) => String(value.activityId),
      });
      yield* synchronize({
        table: "project_work_knowledge",
        column: "knowledge_id",
        kind: "knowledge",
        next: state.knowledge,
        allNext: nextState.knowledge,
        prior: previous.knowledge,
        key: (value) => String(value.knowledgeId),
      });
      yield* synchronize({
        table: "project_work_decisions",
        column: "decision_id",
        kind: "decision",
        next: state.decisions,
        allNext: nextState.decisions,
        prior: previous.decisions,
        key: (value) => String(value.decisionId),
      });
      yield* synchronize({
        table: "project_work_comments",
        column: "comment_id",
        kind: "comment",
        next: state.comments,
        allNext: nextState.comments,
        prior: previous.comments,
        key: (value) => String(value.commentId),
      });
      yield* Effect.forEach(
        [
          ...state.attention,
          ...removed(
            nextState.attention,
            previous.attention,
            (value) => `${value.taskId}\u0000${value.reason}`,
          ),
        ],
        (value) =>
          sql`DELETE FROM project_work_attention WHERE project_id = ${projectId} AND task_id = ${value.taskId} AND reason = ${value.reason}`,
        { discard: true },
      );
      yield* sql`DELETE FROM project_work_search_fts WHERE project_id = ${projectId} AND EXISTS (SELECT 1 FROM project_work_changed_fts changed WHERE changed.record_kind = project_work_search_fts.record_kind AND changed.record_id = project_work_search_fts.record_id)`;
    } else {
      yield* sql`DELETE FROM project_work_tasks WHERE project_id = ${projectId}`;
      yield* sql`DELETE FROM project_work_attempts WHERE project_id = ${projectId}`;
      yield* sql`DELETE FROM project_work_criteria WHERE project_id = ${projectId}`;
      yield* sql`DELETE FROM project_work_evidence WHERE project_id = ${projectId}`;
      yield* sql`DELETE FROM project_work_relationships WHERE project_id = ${projectId}`;
      yield* sql`DELETE FROM project_work_blockers WHERE project_id = ${projectId}`;
      yield* sql`DELETE FROM project_work_knowledge WHERE project_id = ${projectId}`;
      yield* sql`DELETE FROM project_work_decisions WHERE project_id = ${projectId}`;
      yield* sql`DELETE FROM project_work_comments WHERE project_id = ${projectId}`;
      yield* sql`DELETE FROM project_work_attention WHERE project_id = ${projectId}`;
      yield* sql`DELETE FROM project_work_activity WHERE project_id = ${projectId}`;
      yield* sql`DELETE FROM project_work_checkpoints WHERE project_id = ${projectId}`;
    }
    for (const task of state.tasks) {
      yield* sql`INSERT INTO project_work_tasks (task_id, project_id, title, summary, state, specification_json, assignee_json, watchers_json, approval_json, revision, spec_revision, active_attempt_id, failure_kind, blocker_id, created_at, updated_at, completed_at, canceled_at, attribution_json) VALUES (${task.taskId}, ${projectId}, ${task.title}, ${task.summary ?? null}, ${task.state}, ${task.specification === undefined ? null : json(task.specification)}, ${task.assignee === undefined ? null : json(task.assignee)}, ${json(task.watchers ?? [])}, ${task.approval === undefined ? null : json(task.approval)}, ${task.revision}, ${task.specRevision}, ${task.activeAttemptId ?? null}, ${task.failureKind ?? null}, ${task.blockerId ?? null}, ${task.createdAt}, ${task.updatedAt}, ${task.completedAt ?? null}, ${task.canceledAt ?? null}, ${task.attribution === undefined ? null : json(task.attribution)})`;
    }
    for (const attempt of state.attempts)
      yield* sql`INSERT INTO project_work_attempts (attempt_id, project_id, task_id, state, lease_token, leased_until, started_at, ended_at, failure_kind, failure_reason, failure_evidence_ids_json, failure_resolved_at, failure_resolution_reason, failure_resolution_evidence_ids_json, failure_resolution_attribution_json, checkpoint_ids_json, revision, updated_at, attribution_json) VALUES (${attempt.attemptId}, ${projectId}, ${attempt.taskId}, ${attempt.state}, ${attempt.leaseToken ?? null}, ${attempt.leasedUntil ?? null}, ${attempt.startedAt ?? null}, ${attempt.endedAt ?? null}, ${attempt.failureKind ?? null}, ${attempt.failureReason ?? null}, ${json(attempt.failureEvidenceIds ?? [])}, ${attempt.failureResolvedAt ?? null}, ${attempt.failureResolutionReason ?? null}, ${json(attempt.failureResolutionEvidenceIds ?? [])}, ${attempt.failureResolutionAttribution === undefined ? null : json(attempt.failureResolutionAttribution)}, ${json(attempt.checkpointIds)}, ${attempt.revision}, ${attempt.endedAt ?? attempt.startedAt ?? ""}, ${attempt.attribution === undefined ? null : json(attempt.attribution)})`;
    for (const criterion of state.criteria) {
      yield* sql`INSERT INTO project_work_criteria (criterion_id, project_id, task_id, description, required, status, satisfied_by_evidence_ids_json, waiver_json, revision, updated_at) VALUES (${criterion.criterionId}, ${projectId}, ${criterion.taskId}, ${criterion.description}, ${criterion.required ? 1 : 0}, ${criterion.status}, ${json(criterion.satisfiedByEvidenceIds)}, ${criterion.waiver === undefined ? null : json(criterion.waiver)}, ${criterion.revision}, ${criterion.updatedAt})`;
    }
    for (const evidence of state.evidence)
      yield* sql`INSERT INTO project_work_evidence (evidence_id, project_id, task_id, criterion_id, kind, summary, detail, uri, recorded_at, revision, attribution_json) VALUES (${evidence.evidenceId}, ${projectId}, ${evidence.taskId ?? null}, ${evidence.criterionId ?? null}, ${evidence.kind}, ${evidence.summary}, ${evidence.detail ?? null}, ${evidence.uri ?? null}, ${evidence.recordedAt}, ${evidence.revision}, ${evidence.attribution === undefined ? null : json(evidence.attribution)})`;
    for (const relationship of state.relationships)
      yield* sql`INSERT INTO project_work_relationships (relationship_id, project_id, from_task_id, to_task_id, kind, revision, created_at, attribution_json) VALUES (${relationship.relationshipId}, ${projectId}, ${relationship.fromTaskId}, ${relationship.toTaskId}, ${relationship.kind}, ${relationship.revision}, ${relationship.createdAt}, ${relationship.attribution === undefined ? null : json(relationship.attribution)})`;
    for (const blocker of state.blockers)
      yield* sql`INSERT INTO project_work_blockers (blocker_id, project_id, task_id, reason, resolver, reference_ids_json, attention, resolved_at, revision, attribution_json) VALUES (${blocker.blockerId}, ${projectId}, ${blocker.taskId}, ${blocker.reason}, ${blocker.resolver}, ${json(blocker.referenceIds)}, ${blocker.attention ? 1 : 0}, ${blocker.resolvedAt ?? null}, ${blocker.revision}, ${blocker.attribution === undefined ? null : json(blocker.attribution)})`;
    for (const checkpoint of state.checkpoints)
      yield* sql`INSERT INTO project_work_checkpoints (checkpoint_id, project_id, task_id, attempt_id, ref, captured_at, revision, attribution_json) VALUES (${checkpoint.checkpointId}, ${projectId}, ${checkpoint.taskId}, ${checkpoint.attemptId}, ${checkpoint.ref ?? null}, ${checkpoint.capturedAt}, ${checkpoint.revision}, ${checkpoint.attribution === undefined ? null : json(checkpoint.attribution)})`;
    for (const activity of state.activities)
      yield* sql`INSERT INTO project_work_activity (activity_id, project_id, task_id, attempt_id, kind, summary, detail, occurred_at, revision, attribution_json) VALUES (${activity.activityId}, ${projectId}, ${activity.taskId ?? null}, ${activity.attemptId ?? null}, ${activity.kind}, ${activity.summary}, ${activity.detail ?? null}, ${activity.occurredAt}, ${activity.revision}, ${activity.attribution === undefined ? null : json(activity.attribution)})`;
    for (const knowledge of state.knowledge)
      yield* sql`INSERT INTO project_work_knowledge (knowledge_id, project_id, title, body, source_kind, source_id, revision, supersedes_knowledge_id, created_at, updated_at, attribution_json) VALUES (${knowledge.knowledgeId}, ${projectId}, ${knowledge.title}, ${knowledge.body}, ${knowledge.sourceKind}, ${knowledge.sourceId}, ${knowledge.revision}, ${knowledge.supersedesKnowledgeId ?? null}, ${knowledge.createdAt}, ${knowledge.updatedAt}, ${knowledge.attribution === undefined ? null : json(knowledge.attribution)})`;
    for (const decision of state.decisions)
      yield* sql`INSERT INTO project_work_decisions (decision_id, project_id, title, body, state, supersedes_decision_id, rejection_reason, rejected_at, state_transition_attribution_json, revision, created_at, updated_at, attribution_json) VALUES (${decision.decisionId}, ${projectId}, ${decision.title}, ${decision.body}, ${decision.state}, ${decision.supersedesDecisionId ?? null}, ${decision.rejectionReason ?? null}, ${decision.rejectedAt ?? null}, ${decision.stateTransitionAttribution === undefined ? null : json(decision.stateTransitionAttribution)}, ${decision.revision}, ${decision.createdAt}, ${decision.updatedAt}, ${decision.attribution === undefined ? null : json(decision.attribution)})`;
    for (const comment of state.comments)
      yield* sql`INSERT INTO project_work_comments (comment_id, project_id, task_id, body, created_at, revision, attribution_json) VALUES (${comment.commentId}, ${projectId}, ${comment.taskId ?? null}, ${comment.body}, ${comment.createdAt}, ${comment.revision}, ${comment.attribution === undefined ? null : json(comment.attribution)})`;
    for (const attention of state.attention)
      yield* sql`INSERT INTO project_work_attention (project_id, task_id, reason, detail, seen_at, resolved_at, revision) VALUES (${projectId}, ${attention.taskId}, ${attention.reason}, ${attention.detail ?? null}, ${attention.seenAt ?? null}, ${attention.resolvedAt ?? null}, ${attention.revision})`;

    // FTS is a derived read model. Rebuild just this project while the
    // normalized projection is being replaced so a committed command and a
    // projection rebuild expose the same searchable snapshot. Provenance is
    // JSON rather than a flattened string because clients need the source and
    // revision information alongside bounded snippets.
    if (previous === undefined)
      yield* sql`DELETE FROM project_work_search_fts WHERE project_id = ${projectId}`;
    yield* sql`
      INSERT INTO project_work_search_fts
        (project_id, record_kind, record_id, title, body, provenance_json, revision)
      SELECT project_id, 'task', task_id, title,
        COALESCE(summary, '') || CASE WHEN specification_json IS NULL THEN '' ELSE ' ' || specification_json END,
        CASE WHEN attribution_json IS NULL
          THEN json_object('taskId', task_id, 'state', state)
          ELSE json_set(json(attribution_json), '$.taskId', task_id, '$.state', state)
        END,
        revision
      FROM project_work_tasks WHERE project_id = ${projectId}
        ${previous === undefined ? sql`` : sql`AND EXISTS (SELECT 1 FROM project_work_changed_fts changed WHERE changed.record_kind = 'task' AND changed.record_id = task_id)`}
    `;
    yield* sql`
      INSERT INTO project_work_search_fts
        (project_id, record_kind, record_id, title, body, provenance_json, revision)
      SELECT project_id, 'criterion', criterion_id, 'Criterion ' || criterion_id, description,
        json_object('taskId', task_id), revision
      FROM project_work_criteria WHERE project_id = ${projectId}
        ${previous === undefined ? sql`` : sql`AND EXISTS (SELECT 1 FROM project_work_changed_fts changed WHERE changed.record_kind = 'criterion' AND changed.record_id = criterion_id)`}
    `;
    yield* sql`
      INSERT INTO project_work_search_fts
        (project_id, record_kind, record_id, title, body, provenance_json, revision)
      SELECT project_id, 'evidence', evidence_id, kind, summary || CASE WHEN detail IS NULL THEN '' ELSE ' ' || detail END,
        CASE WHEN attribution_json IS NULL
          THEN json_object('taskId', task_id, 'criterionId', criterion_id)
          ELSE json_set(json(attribution_json), '$.taskId', task_id, '$.criterionId', criterion_id)
        END,
        revision
      FROM project_work_evidence WHERE project_id = ${projectId}
        ${previous === undefined ? sql`` : sql`AND EXISTS (SELECT 1 FROM project_work_changed_fts changed WHERE changed.record_kind = 'evidence' AND changed.record_id = evidence_id)`}
    `;
    yield* sql`
      INSERT INTO project_work_search_fts
        (project_id, record_kind, record_id, title, body, provenance_json, revision)
      SELECT project_id, 'blocker', blocker_id, resolver, reason,
        CASE WHEN attribution_json IS NULL
          THEN json_object('taskId', task_id, 'attention', attention)
          ELSE json_set(json(attribution_json), '$.taskId', task_id, '$.attention', attention)
        END,
        revision
      FROM project_work_blockers WHERE project_id = ${projectId}
        ${previous === undefined ? sql`` : sql`AND EXISTS (SELECT 1 FROM project_work_changed_fts changed WHERE changed.record_kind = 'blocker' AND changed.record_id = blocker_id)`}
    `;
    yield* sql`
      INSERT INTO project_work_search_fts
        (project_id, record_kind, record_id, title, body, provenance_json, revision)
      SELECT project_id, 'knowledge', knowledge_id, title, body,
        CASE WHEN attribution_json IS NULL
          THEN json_object('sourceKind', source_kind, 'sourceId', source_id)
          ELSE json_set(json(attribution_json), '$.sourceKind', source_kind, '$.sourceId', source_id)
        END,
        revision
      FROM project_work_knowledge WHERE project_id = ${projectId}
        ${previous === undefined ? sql`` : sql`AND EXISTS (SELECT 1 FROM project_work_changed_fts changed WHERE changed.record_kind = 'knowledge' AND changed.record_id = knowledge_id)`}
    `;
    yield* sql`
      INSERT INTO project_work_search_fts
        (project_id, record_kind, record_id, title, body, provenance_json, revision)
      SELECT project_id, 'decision', decision_id, title, body,
        CASE WHEN attribution_json IS NULL
          THEN json_object('state', state)
          ELSE json_set(json(attribution_json), '$.state', state)
        END,
        revision
      FROM project_work_decisions WHERE project_id = ${projectId}
        ${previous === undefined ? sql`` : sql`AND EXISTS (SELECT 1 FROM project_work_changed_fts changed WHERE changed.record_kind = 'decision' AND changed.record_id = decision_id)`}
    `;
    yield* sql`
      INSERT INTO project_work_search_fts
        (project_id, record_kind, record_id, title, body, provenance_json, revision)
      SELECT project_id, 'comment', comment_id, 'Comment', body,
        CASE WHEN attribution_json IS NULL
          THEN json_object('taskId', task_id)
          ELSE json_set(json(attribution_json), '$.taskId', task_id)
        END,
        revision
      FROM project_work_comments WHERE project_id = ${projectId}
        ${previous === undefined ? sql`` : sql`AND EXISTS (SELECT 1 FROM project_work_changed_fts changed WHERE changed.record_kind = 'comment' AND changed.record_id = comment_id)`}
    `;
    yield* sql`
      INSERT INTO project_work_search_fts
        (project_id, record_kind, record_id, title, body, provenance_json, revision)
      SELECT project_id, 'activity', activity_id, kind, summary || CASE WHEN detail IS NULL THEN '' ELSE ' ' || detail END,
        CASE WHEN attribution_json IS NULL
          THEN json_object('taskId', task_id, 'attemptId', attempt_id)
          ELSE json_set(json_set(json(attribution_json), '$.taskId', task_id), '$.attemptId', attempt_id)
        END,
        revision
      FROM project_work_activity WHERE project_id = ${projectId}
        ${previous === undefined ? sql`` : sql`AND EXISTS (SELECT 1 FROM project_work_changed_fts changed WHERE changed.record_kind = 'activity' AND changed.record_id = activity_id)`}
    `;
    yield* sql`INSERT INTO project_work_projection_state (projector, last_applied_sequence, rebuild_generation, updated_at) VALUES (${"project-work:" + projectId}, ${options.lastAppliedSequence ?? state.revision}, 0, ${options.updatedAt ?? state.history?.at(-1)?.occurredAt ?? "1970-01-01T00:00:00.000Z"}) ON CONFLICT(projector) DO UPDATE SET last_applied_sequence = excluded.last_applied_sequence, updated_at = excluded.updated_at`;
    // @effect-diagnostics-next-line preferSchemaOverJson:off -- state is produced by the typed reducer.
    const stateJson = JSON.stringify(nextState);
    yield* sql`
      INSERT INTO project_work_reducer_checkpoints
        (project_id, last_sequence, state_json, updated_at)
      VALUES
        (${projectId}, ${options.lastAppliedSequence ?? state.revision}, ${stateJson},
          ${options.updatedAt ?? state.history?.at(-1)?.occurredAt ?? "1970-01-01T00:00:00.000Z"})
      ON CONFLICT(project_id) DO UPDATE SET
        last_sequence = excluded.last_sequence,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `;
  });

const decodeProjectWorkEventRow = (
  row: Record<string, unknown>,
  projectId: string,
): ProjectWorkProjectionEvent => {
  let value: unknown;
  try {
    value = JSON.parse(String(row.payloadJson));
  } catch (cause) {
    throw new ProjectWorkProjectionDecodeError({
      detail: `Invalid project-work event payload: ${String(cause)}`,
    });
  }
  if (value === null || typeof value !== "object")
    throw new ProjectWorkProjectionDecodeError({
      detail: "Project-work event payload must be an object.",
    });
  const event = value as Record<string, unknown>;
  if (
    typeof event.eventId !== "string" ||
    typeof event.projectId !== "string" ||
    typeof event.type !== "string" ||
    typeof event.occurredAt !== "string" ||
    typeof event.revision !== "number" ||
    !Number.isSafeInteger(event.revision)
  )
    throw new ProjectWorkProjectionDecodeError({
      detail: "Project-work event payload is missing metadata.",
    });
  // Validate both the requested aggregate and the denormalized SQL metadata
  // before reducing any projection rows.
  if (
    String(row.projectId) !== projectId ||
    event.projectId !== projectId ||
    event.eventId !== String(row.eventId) ||
    event.type !== String(row.eventType) ||
    event.occurredAt !== String(row.occurredAt)
  )
    throw new ProjectWorkProjectionDecodeError({
      detail: "Project-work event metadata does not match its aggregate row.",
    });
  return event as unknown as ProjectWorkProjectionEvent;
};

export interface ProjectWorkProjectionShape {
  readonly rebuild: (projectId: string) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly state: (
    projectId: string,
  ) => Effect.Effect<ProjectWorkProjectionState, ProjectionRepositoryError>;
}

export class ProjectWorkProjection extends Context.Service<
  ProjectWorkProjection,
  ProjectWorkProjectionShape
>()("t3/projectWork/ProjectWorkProjection") {}

const makeProjectWorkProjection = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const state = (projectId: string) =>
    ensureProjectWorkTables(sql).pipe(
      Effect.flatMap(() => readProjectWorkState(sql, projectId)),
      Effect.mapError(toPersistenceSqlError("ProjectWorkProjection.state")),
    );
  const rebuild = (projectId: string) =>
    Effect.gen(function* () {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* ensureProjectWorkTables(sql);
            // A rebuild only consumes the append-only repository log. Read it
            // in this transaction so the rows projected below are one exact
            // authoritative snapshot, never caller-supplied input.
            const rows = yield* sql<Record<string, unknown>>`
              SELECT sequence, event_id AS eventId, project_id AS projectId,
                event_type AS eventType, occurred_at AS occurredAt, payload_json AS payloadJson
              FROM project_work_events
              WHERE project_id = ${projectId}
              ORDER BY sequence ASC
            `;
            const events = yield* Effect.forEach(rows, (row) =>
              Effect.try({
                try: () => decodeProjectWorkEventRow(row, projectId),
                catch: (cause) =>
                  isProjectWorkProjectionDecodeError(cause)
                    ? cause
                    : new ProjectWorkProjectionDecodeError({ detail: String(cause) }),
              }),
            );
            const next = applyProjectWorkProjectionEvents(
              emptyProjectWorkProjectionState(projectId),
              events,
            );
            const lastRow = rows.at(-1);
            const lastAppliedSequence = lastRow === undefined ? 0 : Number(lastRow.sequence);
            const updatedAt = events.at(-1)?.occurredAt ?? "1970-01-01T00:00:00.000Z";
            const cursorRows = yield* sql<Record<string, unknown>>`
              SELECT rebuild_generation AS rebuildGeneration
              FROM project_work_projection_state
              WHERE projector = ${"project-work:" + projectId}
            `;
            const rebuildGeneration =
              (cursorRows[0] === undefined ? 0 : Number(cursorRows[0].rebuildGeneration)) + 1;
            yield* persistProjectWorkState(sql, next, projectId, {
              lastAppliedSequence,
              updatedAt,
            });
            yield* sql`
              INSERT INTO project_work_projection_state
                (projector, last_applied_sequence, rebuild_generation, updated_at)
              VALUES
                (${"project-work:" + projectId}, ${lastAppliedSequence}, ${rebuildGeneration}, ${updatedAt})
              ON CONFLICT(projector) DO UPDATE SET
                last_applied_sequence = excluded.last_applied_sequence,
                rebuild_generation = excluded.rebuild_generation,
                updated_at = excluded.updated_at
            `;
          }),
        )
        .pipe(Effect.mapError(toPersistenceSqlError("ProjectWorkProjection.rebuild")));
    });
  return {
    rebuild,
    state,
  } satisfies ProjectWorkProjectionShape;
});

export const ProjectWorkProjectionLive = Layer.effect(
  ProjectWorkProjection,
  makeProjectWorkProjection,
);
