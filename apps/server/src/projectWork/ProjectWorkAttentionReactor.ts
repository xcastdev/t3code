import {
  EnvironmentId,
  ProjectWorkTaskId,
  ThreadId,
  type ProjectWorkAttention,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ExternalNotificationDispatcher from "../notifications/ExternalNotificationDispatcher.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  ensureProjectWorkTables,
  type ProjectWorkProjectionState,
} from "./ProjectWorkProjection.ts";
import { deriveProjectWorkTaskPolicy } from "./ProjectWorkPolicy.ts";
import type { ProjectWorkEvent } from "./ProjectWorkDecider.ts";

const CLAIM_TTL_MS = 30_000;
const CLAIM_HEARTBEAT_MS = 10_000;
const RETRY_MS = 15_000;
const BATCH_SIZE = 16;

export interface ProjectWorkAttentionCommit {
  readonly projectId: string;
  readonly state: ProjectWorkProjectionState;
  readonly events: ReadonlyArray<ProjectWorkEvent>;
}

export interface ProjectWorkAttentionDrainResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly partial: number;
  readonly retried: number;
}

export interface ProjectWorkAttentionReactorShape {
  /** Wake the one scoped worker after the repository transaction commits. */
  readonly onCommitted: (input: ProjectWorkAttentionCommit) => Effect.Effect<void>;
  /** Reconcile a projection snapshot and wake the worker. */
  readonly reconcile: (
    projectId: string,
    state: ProjectWorkProjectionState,
  ) => Effect.Effect<ReadonlyArray<ProjectWorkAttention>>;
  /** Deterministic seam for startup/recovery and focused tests. */
  readonly drain: Effect.Effect<ProjectWorkAttentionDrainResult>;
}

export class ProjectWorkAttentionReactor extends Context.Service<
  ProjectWorkAttentionReactor,
  ProjectWorkAttentionReactorShape
>()("t3/projectWork/ProjectWorkAttentionReactor") {}

const timestamp = (state: ProjectWorkProjectionState): string =>
  state.history?.at(-1)?.occurredAt ?? DateTime.formatIso(DateTime.nowUnsafe());

const activeAttention = (
  state: ProjectWorkProjectionState,
  taskId: ProjectWorkTaskId,
): ProjectWorkAttention | undefined =>
  state.attention.find((entry) => entry.taskId === taskId && entry.resolvedAt === undefined);

export const deriveProjectWorkAttention = (
  state: ProjectWorkProjectionState,
): ReadonlyArray<ProjectWorkAttention> =>
  state.tasks.flatMap((task) =>
    deriveProjectWorkTaskPolicy(state, task.taskId, task.updatedAt).attention.slice(0, 1),
  );

type AttentionSemantic = Pick<ProjectWorkAttention, "taskId" | "reason" | "detail" | "revision">;

const publicationIdFor = (projectId: string, occurrenceId: string): string =>
  `project-work-notification:${projectId}:${occurrenceId}`;

const occurrenceIdFor = (projectId: string, attention: AttentionSemantic): string =>
  `${projectId}\u0000${attention.taskId}\u0000${attention.reason}\u0000${attention.revision}`;

const json = (value: unknown): string => JSON.stringify(value);
const parseIds = (value: unknown): Array<string> => {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
};

/**
 * Called by the repository while its command transaction is still open. The
 * semantic comparison happens against the reduced state, so a retry or an
 * unrelated revision cannot enqueue a duplicate occurrence.
 */
export const enqueueProjectWorkAttentionPublication = (
  sql: SqlClient.SqlClient,
  projectId: string,
  previous: ProjectWorkProjectionState,
  next: ProjectWorkProjectionState,
  occurredAt: string,
) =>
  Effect.gen(function* () {
    yield* ensureProjectWorkTables(sql);
    const previousActive = new Map(
      previous.attention
        .filter((entry) => entry.resolvedAt === undefined)
        .map((entry) => [String(entry.taskId), entry]),
    );
    const nextActive = next.attention.filter((entry) => entry.resolvedAt === undefined);
    for (const attention of nextActive) {
      const old = previousActive.get(String(attention.taskId));
      if (old?.reason === attention.reason && old.detail === attention.detail) continue;
      const occurrenceId = occurrenceIdFor(projectId, attention);
      const publicationId = publicationIdFor(projectId, occurrenceId);
      const task = next.tasks.find((entry) => entry.taskId === attention.taskId);
      yield* sql`
        UPDATE project_work_attention_occurrences
        SET resolved_at = COALESCE(resolved_at, ${occurredAt})
        WHERE project_id = ${projectId}
          AND task_id = ${attention.taskId}
          AND resolved_at IS NULL
          AND occurrence_id <> ${occurrenceId}
      `;
      yield* sql`
        INSERT INTO project_work_attention_occurrences
          (occurrence_id, project_id, task_id, reason, detail, revision, occurred_at)
        VALUES
          (${occurrenceId}, ${projectId}, ${attention.taskId}, ${attention.reason},
           ${attention.detail ?? null}, ${attention.revision}, ${occurredAt})
        ON CONFLICT(occurrence_id) DO NOTHING
      `;
      yield* sql`
        INSERT INTO project_work_notification_publications
          (publication_id, occurrence_id, project_id, task_id, reason, detail, task_state,
           revision, payload_json, status, available_at, created_at)
        VALUES
          (${publicationId}, ${occurrenceId}, ${projectId}, ${attention.taskId},
           ${attention.reason}, ${attention.detail ?? null}, ${task?.state ?? "unknown"},
           ${attention.revision}, ${json({
             projectId,
             taskId: attention.taskId,
             reason: attention.reason,
             detail: attention.detail,
             state: task?.state ?? "unknown",
             revision: attention.revision,
           })}, 'pending', ${occurredAt}, ${occurredAt})
        ON CONFLICT(occurrence_id) DO NOTHING
      `;
    }
    for (const old of previous.attention.filter((entry) => entry.resolvedAt === undefined)) {
      if (nextActive.some((entry) => String(entry.taskId) === String(old.taskId))) continue;
      yield* sql`
        UPDATE project_work_attention_occurrences
        SET resolved_at = COALESCE(resolved_at, ${occurredAt})
        WHERE project_id = ${projectId} AND task_id = ${old.taskId} AND resolved_at IS NULL
      `;
    }
  }).pipe(Effect.catch(() => Effect.succeed({ claimed: 0, delivered: 0, partial: 0, retried: 0 })));

interface PublicationRow {
  readonly publicationId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly reason: string;
  readonly detail: string | null;
  readonly state: string;
  readonly revision: number;
  readonly deliveredDestinationIds: Array<string>;
  readonly failedDestinationIds: Array<string>;
  readonly ownerId: string;
  readonly claimToken: string;
}

const makeProjectWorkAttentionReactor = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const dispatcherOption = yield* Effect.serviceOption(
    ExternalNotificationDispatcher.ExternalNotificationDispatcher,
  );
  const environmentOption = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  const ownerId = `project-work-reactor:${yield* Random.nextInt}`;
  const wakeQueue = yield* Queue.unbounded<void>();

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const plusMs = (ms: number) =>
    DateTime.now.pipe(
      Effect.map((current) => DateTime.formatIso(DateTime.add(current, { milliseconds: ms }))),
    );

  const reconcileExpiredClaims = Effect.gen(function* () {
    const current = yield* now;
    yield* sql`
      UPDATE project_work_notification_publications
      SET status = 'pending', owner_id = NULL, claim_token = NULL, claimed_until = NULL,
          available_at = MIN(available_at, ${current})
      WHERE status IN ('reserved', 'sending')
        AND claimed_until IS NOT NULL
        AND claimed_until <= ${current}
    `;
  });

  const reconcilePersistedAttention = Effect.gen(function* () {
    const rows = yield* sql<Record<string, unknown>>`
      SELECT attention.project_id AS projectId, attention.task_id AS taskId,
        attention.reason, attention.detail, attention.revision, tasks.state
      FROM project_work_attention AS attention
      LEFT JOIN project_work_tasks AS tasks
        ON tasks.project_id = attention.project_id AND tasks.task_id = attention.task_id
      WHERE attention.resolved_at IS NULL
    `;
    for (const row of rows) {
      const attention: AttentionSemantic = {
        taskId: ProjectWorkTaskId.make(String(row.taskId)),
        reason: String(row.reason) as ProjectWorkAttention["reason"],
        ...(row.detail == null ? {} : { detail: String(row.detail) }),
        revision: Number(row.revision),
      };
      const currentOccurrenceId = occurrenceIdFor(String(row.projectId), attention);
      const activeOccurrence = yield* sql<Record<string, unknown>>`
        SELECT occurrence_id AS occurrenceId
        FROM project_work_attention_occurrences
        WHERE project_id = ${row.projectId} AND task_id = ${row.taskId}
          AND reason = ${row.reason} AND detail IS ${row.detail ?? null}
          AND resolved_at IS NULL
        ORDER BY occurred_at DESC
        LIMIT 1
      `;
      // A projection revision can advance for an unrelated event while the
      // semantic attention remains active. Reuse its occurrence across a
      // restart instead of turning that revision bump into another notice.
      const occurrenceId = String(activeOccurrence[0]?.occurrenceId ?? currentOccurrenceId);
      const occurredAt = yield* now;
      yield* sql`
        INSERT INTO project_work_attention_occurrences
          (occurrence_id, project_id, task_id, reason, detail, revision, occurred_at)
        VALUES (${occurrenceId}, ${row.projectId}, ${row.taskId}, ${row.reason},
          ${row.detail ?? null}, ${row.revision}, ${occurredAt})
        ON CONFLICT(occurrence_id) DO NOTHING
      `;
      yield* sql`
        INSERT INTO project_work_notification_publications
          (publication_id, occurrence_id, project_id, task_id, reason, detail, task_state,
           revision, payload_json, status, available_at, created_at)
        VALUES (${publicationIdFor(String(row.projectId), occurrenceId)}, ${occurrenceId},
          ${row.projectId}, ${row.taskId}, ${row.reason}, ${row.detail ?? null},
          ${row.state ?? "unknown"}, ${row.revision}, ${json({
            projectId: row.projectId,
            taskId: row.taskId,
            reason: row.reason,
            detail: row.detail,
            state: row.state ?? "unknown",
            revision: row.revision,
          })}, 'pending', ${occurredAt}, ${occurredAt})
        ON CONFLICT(occurrence_id) DO NOTHING
      `;
    }
  });

  const reserveBatch = Effect.gen(function* () {
    const reservedUntil = yield* plusMs(CLAIM_TTL_MS);
    const token = `${ownerId}:${yield* Random.nextInt}`;
    const current = yield* now;
    const rows = yield* sql<Record<string, unknown>>`
      SELECT publication_id AS publicationId, project_id AS projectId, task_id AS taskId,
        reason, detail, task_state AS state, revision,
        delivered_destination_ids_json AS deliveredDestinationIdsJson,
        failed_destination_ids_json AS failedDestinationIdsJson
      FROM project_work_notification_publications
      WHERE (status IN ('pending', 'partial', 'failed') AND available_at <= ${current})
         OR (status IN ('reserved', 'sending') AND claimed_until <= ${current})
      ORDER BY revision ASC, publication_id ASC
      LIMIT ${BATCH_SIZE}
    `;
    const claimed: Array<PublicationRow> = [];
    for (const row of rows) {
      const changed = yield* sql`
        UPDATE project_work_notification_publications
        SET status = 'reserved', owner_id = ${ownerId}, claim_token = ${token},
            claimed_until = ${reservedUntil}, attempt_count = attempt_count + 1
        WHERE publication_id = ${String(row.publicationId)}
          AND ((status IN ('pending', 'partial', 'failed') AND available_at <= ${current})
            OR (status IN ('reserved', 'sending') AND claimed_until <= ${current}))
        RETURNING publication_id
      `;
      if (changed.length === 0) continue;
      yield* sql`
        UPDATE project_work_notification_publications
        SET status = 'sending'
        WHERE publication_id = ${String(row.publicationId)}
          AND owner_id = ${ownerId} AND claim_token = ${token} AND status = 'reserved'
      `;
      claimed.push({
        publicationId: String(row.publicationId),
        projectId: String(row.projectId),
        taskId: String(row.taskId),
        reason: String(row.reason),
        detail: row.detail == null ? null : String(row.detail),
        state: String(row.state),
        revision: Number(row.revision),
        deliveredDestinationIds: parseIds(row.deliveredDestinationIdsJson),
        failedDestinationIds: parseIds(row.failedDestinationIdsJson),
        ownerId,
        claimToken: token,
      });
    }
    return claimed;
  });

  const renew = (publication: PublicationRow) =>
    Effect.gen(function* () {
      // RETURNING gives us the affected-row ownership signal. Read the row
      // once more before allowing an external side effect so a concurrent
      // takeover that lands in the same SQLite statement window is fenced.
      const claimedUntil = yield* plusMs(CLAIM_TTL_MS);
      const updated = yield* sql<Record<string, unknown>>`
        UPDATE project_work_notification_publications
        SET claimed_until = ${claimedUntil}
        WHERE publication_id = ${publication.publicationId}
          AND owner_id = ${publication.ownerId} AND claim_token = ${publication.claimToken}
          AND status = 'sending'
        RETURNING publication_id
      `;
      if (updated.length === 0) return false;
      const owned = yield* sql<Record<string, unknown>>`
        SELECT publication_id
        FROM project_work_notification_publications
        WHERE publication_id = ${publication.publicationId}
          AND owner_id = ${publication.ownerId} AND claim_token = ${publication.claimToken}
          AND status = 'sending'
      `;
      return owned.length > 0;
    });

  const processPublication = (publication: PublicationRow) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (dispatcherOption._tag === "None") return "retry" as const;
        const environmentId =
          environmentOption._tag === "Some"
            ? yield* environmentOption.value.getEnvironmentId
            : EnvironmentId.make("unknown");
        // Check ownership before any external side effect. Every subsequent
        // heartbeat uses the affected-row result as a fencing signal; a
        // competing worker can therefore interrupt this dispatch as soon as
        // it takes over the expired claim.
        const initiallyOwned = yield* renew(publication);
        if (!initiallyOwned) return "lost" as const;

        const ownerLost = yield* Deferred.make<void>();
        const signalOwnerLost = Deferred.succeed(ownerLost, undefined).pipe(
          Effect.andThen(Effect.never),
        );
        const renewFiber = yield* Effect.forkScoped(
          Effect.forever(
            Effect.sleep(`${CLAIM_HEARTBEAT_MS} millis`).pipe(
              Effect.andThen(renew(publication)),
              Effect.flatMap((owned) => (owned ? Effect.void : signalOwnerLost)),
              Effect.catch(() => signalOwnerLost),
            ),
          ),
        );
        const dispatch = dispatcherOption.value.dispatchDetailed({
          environmentId,
          threadId: ThreadId.make(`project-work:${publication.projectId}`),
          state: null,
          reason: `project-work:${publication.reason}`,
          projectWork: {
            projectId: publication.projectId,
            taskId: publication.taskId,
            state: publication.state,
            reason: publication.reason,
            revision: publication.revision,
          },
          bypassMemoryDedup: true,
          ...(publication.failedDestinationIds.length === 0
            ? {}
            : { destinationIds: publication.failedDestinationIds }),
        });
        const raced = yield* Effect.raceFirst(
          dispatch.pipe(Effect.map((result) => ({ _tag: "delivered" as const, result }))),
          Deferred.await(ownerLost).pipe(Effect.as({ _tag: "lost" as const })),
        );
        yield* Fiber.interrupt(renewFiber);
        if (raced._tag === "lost") return "lost" as const;
        const result = raced.result;
        const delivered = [
          ...new Set([...publication.deliveredDestinationIds, ...result.deliveredDestinationIds]),
        ];
        const failed = result.failedDestinationIds;
        const attempted = result.attemptedDestinationIds;
        const status =
          attempted.length > 0 && failed.length === 0
            ? "sent"
            : attempted.length === 0
              ? "pending"
              : "partial";
        const error =
          result.outcomes.find((outcome) => outcome.status === "failed")?.reason ?? null;
        const availableAt = status === "sent" ? yield* now : yield* plusMs(RETRY_MS);
        const deliveredAt = status === "sent" ? yield* now : null;
        const fenced = yield* sql<Record<string, unknown>>`
        UPDATE project_work_notification_publications
        SET status = ${status}, available_at = ${availableAt},
            owner_id = NULL, claim_token = NULL, claimed_until = NULL,
            delivered_destination_ids_json = ${json(delivered)},
            failed_destination_ids_json = ${json(failed)}, last_error = ${error},
            outcome_json = ${json(result)}, delivered_at = ${deliveredAt}
        WHERE publication_id = ${publication.publicationId}
          AND owner_id = ${publication.ownerId} AND claim_token = ${publication.claimToken}
          AND status = 'sending'
        RETURNING publication_id
      `;
        if (fenced.length === 0) return "lost" as const;
        return status === "sent"
          ? ("sent" as const)
          : status === "partial"
            ? ("partial" as const)
            : ("retry" as const);
      }).pipe(Effect.catch(() => Effect.succeed("retry" as const))),
    );

  const drain: ProjectWorkAttentionReactorShape["drain"] = Effect.gen(function* () {
    yield* ensureProjectWorkTables(sql);
    yield* reconcilePersistedAttention;
    yield* reconcileExpiredClaims;
    const batch = yield* reserveBatch;
    const outcomes = yield* Effect.forEach(batch, processPublication, {
      concurrency: BATCH_SIZE,
    });
    const delivered = outcomes.filter((outcome) => outcome === "sent").length;
    const partial = outcomes.filter((outcome) => outcome === "partial").length;
    const retried = outcomes.filter((outcome) => outcome === "retry" || outcome === "lost").length;
    return { claimed: batch.length, delivered, partial, retried };
  }).pipe(Effect.catch(() => Effect.succeed({ claimed: 0, delivered: 0, partial: 0, retried: 0 })));

  const onCommitted: ProjectWorkAttentionReactorShape["onCommitted"] = () =>
    Queue.offer(wakeQueue, undefined).pipe(Effect.asVoid);

  const reconcile: ProjectWorkAttentionReactorShape["reconcile"] = (projectId, state) =>
    Effect.gen(function* () {
      yield* ensureProjectWorkTables(sql);
      const desired = deriveProjectWorkAttention(state);
      const desiredByTask = new Map(desired.map((entry) => [String(entry.taskId), entry]));
      const previousRows = yield* sql<Record<string, unknown>>`
        SELECT task_id AS taskId, reason, detail, seen_at AS seenAt, resolved_at AS resolvedAt, revision
        FROM project_work_attention WHERE project_id = ${projectId}
      `;
      const previousAttention: Array<ProjectWorkAttention> = previousRows.map((row) => ({
        taskId: ProjectWorkTaskId.make(String(row.taskId)),
        reason: String(row.reason) as ProjectWorkAttention["reason"],
        ...(row.detail == null ? {} : { detail: String(row.detail) }),
        ...(row.seenAt == null ? {} : { seenAt: String(row.seenAt) }),
        ...(row.resolvedAt == null ? {} : { resolvedAt: String(row.resolvedAt) }),
        revision: Number(row.revision),
      }));
      const changedAt = timestamp(state);
      for (const attention of desired) {
        const existing = activeAttention(
          { ...state, attention: previousAttention },
          attention.taskId,
        );
        yield* sql`
          INSERT INTO project_work_attention
            (project_id, task_id, reason, detail, seen_at, resolved_at, revision)
          VALUES
            (${projectId}, ${attention.taskId}, ${attention.reason}, ${attention.detail ?? null},
             ${existing?.seenAt ?? null}, NULL, ${Math.max(existing?.revision ?? 0, attention.revision)})
          ON CONFLICT(project_id, task_id) DO UPDATE SET
            reason = excluded.reason, detail = excluded.detail,
            seen_at = CASE WHEN project_work_attention.resolved_at IS NULL
              THEN COALESCE(project_work_attention.seen_at, excluded.seen_at)
              ELSE excluded.seen_at END,
            resolved_at = NULL,
            revision = MAX(project_work_attention.revision, excluded.revision)
        `;
      }
      for (const existing of previousAttention) {
        if (existing.resolvedAt === undefined && !desiredByTask.has(String(existing.taskId))) {
          yield* sql`
            UPDATE project_work_attention
            SET resolved_at = COALESCE(resolved_at, ${changedAt}), revision = revision + 1
            WHERE project_id = ${projectId} AND task_id = ${existing.taskId} AND resolved_at IS NULL
          `;
        }
      }
      yield* enqueueProjectWorkAttentionPublication(
        sql,
        projectId,
        { ...state, attention: previousAttention },
        { ...state, attention: [...desired] },
        changedAt,
      );
      yield* onCommitted({ projectId, state, events: [] });
      return desired;
    }).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<ProjectWorkAttention>)));

  const service = { onCommitted, reconcile, drain } satisfies ProjectWorkAttentionReactorShape;
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      yield* onCommitted({
        projectId: "startup",
        state: {} as ProjectWorkProjectionState,
        events: [],
      });
      while (true) {
        yield* Effect.raceFirst(Queue.take(wakeQueue), Effect.sleep("30 seconds"));
        yield* drain.pipe(Effect.ignore);
      }
    }).pipe(Effect.catch(() => Effect.void)),
  );
  return service;
});

export const layer = Layer.effect(ProjectWorkAttentionReactor, makeProjectWorkAttentionReactor);

export const layerTest = Layer.succeed(ProjectWorkAttentionReactor, {
  onCommitted: () => Effect.void,
  reconcile: (_projectId, state) => Effect.succeed(state.attention),
  drain: Effect.succeed({ claimed: 0, delivered: 0, partial: 0, retried: 0 }),
} satisfies ProjectWorkAttentionReactorShape);

export const isProjectWorkPublicationStatus = Schema.Literals([
  "pending",
  "reserved",
  "sending",
  "partial",
  "failed",
  "sent",
]);
