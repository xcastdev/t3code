import { decodeProjectWorkEvent, readProjectWorkEvents } from "./ProjectWorkEventStore.ts";
import { isProjectWorkTombstoned } from "./ProjectTeamsPersistence.ts";
import {
  commitProjectTeamAuthority,
  PROJECT_WORK_CHECKPOINT_VERSION,
} from "./ProjectTeamsPersistence.ts";
import {
  type ProjectWorkMutationDelta,
  type ProjectWorkWriteResult,
  projectWorkPayloadFingerprint,
  type ProjectWorkCommand,
  type ProjectWorkAttempt,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";

import {
  applyProjectWorkEvents,
  decideProjectWorkCommand,
  emptyProjectWorkReducerState,
  type ProjectWorkEvent,
  type ProjectWorkReducerState,
} from "./ProjectWorkDecider.ts";
import {
  emptyProjectWorkProjectionState,
  ensureProjectWorkTables,
  persistProjectWorkState,
  type ProjectWorkProjectionState,
} from "./ProjectWorkProjection.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { assertProjectTeamGuidedReplayCurrent } from "./ProjectTeamGuidedLifecycle.ts";
import * as ProjectWorkEventBus from "./ProjectWorkEventBus.ts";
import { enqueueProjectWorkAttentionPublication } from "./ProjectWorkAttentionReactor.ts";
import * as ProjectWorkContentGuard from "./ProjectWorkContentGuard.ts";
import { toPersistenceSqlError, type ProjectionRepositoryError } from "../persistence/Errors.ts";

export type ProjectWorkRepositoryError = ProjectionRepositoryError | ProjectWorkPolicyError;

export interface ProjectWorkCommandResult {
  readonly projectId: string;
  readonly revision: number;
  readonly events: ReadonlyArray<ProjectWorkEvent>;
  /** The reduced state is returned only after the transaction commits. */
  readonly state: ProjectWorkProjectionState;
  /** Public mutation result persisted with the command receipt. */
  readonly delta: ProjectWorkMutationDelta;
  /** Exact public result committed with the command receipt. */
  readonly writeResult: ProjectWorkWriteResult;
  /** True when the command id was already committed. */
  readonly duplicate?: boolean;
}

export interface ProjectWorkRepositoryShape {
  /** Replay, decide, append and project in one SQL transaction. */
  readonly execute: (
    command: ProjectWorkCommand,
  ) => Effect.Effect<ProjectWorkCommandResult, ProjectWorkRepositoryError>;
  /**
   * The authorization hook runs after the durable duplicate check and before
   * the decider, inside the same SQL transaction. This is what lets a retry
   * return the original receipt without consuming a one-shot approval again.
   */
  readonly executeAuthorized: <E, L = never>(
    command: ProjectWorkCommand,
    authorize: (input: {
      readonly commandFingerprint: string;
    }) => Effect.Effect<ProjectWorkCommand, E>,
    liveValidate?: (input: { readonly duplicate: boolean }) => Effect.Effect<void, L>,
    receiptFingerprint?: string,
  ) => Effect.Effect<ProjectWorkCommandResult, ProjectWorkRepositoryError | E | L>;
  /** Trusted multi-project writes and auxiliary SQL share one outer commit. No publication escapes rollback. */
  readonly executeAtomic: <E, R, V = never, VR = never>(
    prepare: Effect.Effect<ReadonlyArray<ProjectWorkCommand>, E, R>,
    /** Runs after every command receipt, before commit or publication. */
    finalValidate?: Effect.Effect<void, V, VR>,
  ) => Effect.Effect<
    ReadonlyArray<ProjectWorkCommandResult>,
    E | V | ProjectWorkRepositoryError,
    R | VR
  >;
  readonly executeCommand: ProjectWorkRepositoryShape["execute"];
  readonly replay: (
    projectId: string,
  ) => Effect.Effect<ReadonlyArray<ProjectWorkEvent>, ProjectionRepositoryError>;
  readonly replayAll: () => Effect.Effect<
    ReadonlyArray<ProjectWorkEvent>,
    ProjectionRepositoryError
  >;
  readonly getAttempt: (
    attemptId: string,
  ) => Effect.Effect<ProjectWorkAttempt | undefined, ProjectionRepositoryError>;
}

export class ProjectWorkRepository extends Context.Service<
  ProjectWorkRepository,
  ProjectWorkRepositoryShape
>()("t3/projectWork/ProjectWorkRepository") {}

/** Complete internal authority loader; never a bounded public projection read. */
export const readCurrentState = (sql: SqlClient.SqlClient, projectId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<Record<string, unknown>>`
      SELECT last_sequence AS lastSequence, state_json AS stateJson
      FROM project_work_reducer_checkpoints
      WHERE project_id = ${projectId}
      LIMIT 1
    `;
    const checkpoint = rows[0];
    if (checkpoint === undefined) {
      const events = yield* readProjectWorkEvents(sql, projectId);
      return applyProjectWorkEvents(emptyProjectWorkReducerState(projectId), events);
    }
    let state: ProjectWorkReducerState;
    try {
      // @effect-diagnostics-next-line preferSchemaOverJson:off -- validated derived checkpoint with event-log fallback.
      state = JSON.parse(String(checkpoint.stateJson)) as ProjectWorkReducerState;
    } catch {
      const events = yield* readProjectWorkEvents(sql, projectId);
      return applyProjectWorkEvents(emptyProjectWorkReducerState(projectId), events);
    }
    if (
      (state as ProjectWorkReducerState & { checkpointVersion?: number }).checkpointVersion !==
        PROJECT_WORK_CHECKPOINT_VERSION ||
      state.projectId !== projectId ||
      !Array.isArray(state.tasks)
    ) {
      const events = yield* readProjectWorkEvents(sql, projectId);
      return applyProjectWorkEvents(emptyProjectWorkReducerState(projectId), events);
    }
    const tail = yield* readProjectWorkEvents(sql, projectId, Number(checkpoint.lastSequence));
    return applyProjectWorkEvents(state, tail);
  });

const project = (state: ProjectWorkReducerState): ProjectWorkProjectionState => ({
  ...emptyProjectWorkProjectionState(state.projectId),
  ...state,
  checkpoints: state.checkpoints ?? [],
  activities: state.activities ?? [],
  knowledge: state.knowledge ?? [],
  decisions: state.decisions ?? [],
  comments: state.comments ?? [],
});

const changedFieldsForEvent = (type: string): ReadonlyArray<string> => {
  if (type.includes("foundation")) return ["foundationRecords"];
  if (type.includes("criterion")) return ["criteria", "tasks"];
  if (type.includes("evidence")) return ["evidence", "criteria", "tasks"];
  if (type.includes("relationship")) return ["relationships", "tasks"];
  if (type.includes("attempt") || type.includes("checkpoint")) {
    return ["attempts", "tasks", "checkpoints"];
  }
  if (type.includes("knowledge")) return ["knowledge"];
  if (type.includes("decision")) return ["decisions"];
  if (type.includes("comment")) return ["comments"];
  if (type.includes("attention")) return ["attention", "tasks"];
  return ["tasks"];
};

const mutationDeltaFor = (
  projectId: string,
  revision: number,
  events: ReadonlyArray<ProjectWorkEvent>,
): ProjectWorkMutationDelta => ({
  projectId: projectId as ProjectWorkMutationDelta["projectId"],
  revision,
  eventIds: events.map((event) => event.eventId).slice(0, 64),
  changedFields: [...new Set(events.flatMap((event) => changedFieldsForEvent(event.type)))].slice(
    0,
    64,
  ),
});

const decodeMutationDelta = (
  value: unknown,
  projectId: string,
  fallbackRevision: number,
  fallbackEvents: ReadonlyArray<ProjectWorkEvent>,
): ProjectWorkMutationDelta => {
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const eventIds = Array.isArray(record.eventIds)
      ? record.eventIds.filter((entry): entry is string => typeof entry === "string").slice(0, 64)
      : undefined;
    const changedFields = Array.isArray(record.changedFields)
      ? record.changedFields
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, 64)
      : undefined;
    const revision =
      typeof record.revision === "number" && Number.isSafeInteger(record.revision)
        ? record.revision
        : fallbackRevision;
    if (eventIds !== undefined && changedFields !== undefined) {
      return {
        projectId: projectId as ProjectWorkMutationDelta["projectId"],
        revision,
        eventIds: eventIds as unknown as ProjectWorkMutationDelta["eventIds"],
        changedFields,
      };
    }
  }
  return mutationDeltaFor(projectId, fallbackRevision, fallbackEvents);
};

/** Server-generated attribution timestamps must not make a retry look like a
 * different command. Actor and source are stored and compared separately. */
const withoutAttributionTimestamps = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutAttributionTimestamps);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const isAttribution = "actor" in record && "source" in record && "recordedAt" in record;
  const isActor =
    "kind" in record &&
    !("source" in record) &&
    !("uri" in record) &&
    ("id" in record || "displayName" in record);
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !(isAttribution && key === "recordedAt") &&
          !(isActor && key === "displayName") &&
          // approvalToken is bearer proof, not command intent. A renewed
          // session may present a different proof while retrying the same
          // command, and it must never be written to a receipt.
          !(key === "approvalToken"),
      )
      .map(([key, entry]) => {
        if (isAttribution && key === "source" && entry !== null && typeof entry === "object") {
          const source = entry as Record<string, unknown>;
          return [
            key,
            Object.fromEntries(
              Object.entries(source)
                .filter(([sourceKey]) => sourceKey !== "uri")
                .map(([sourceKey, sourceValue]) => [
                  sourceKey,
                  withoutAttributionTimestamps(sourceValue),
                ]),
            ),
          ];
        }
        return [key, withoutAttributionTimestamps(entry)];
      }),
  );
};

const makeProjectWorkRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const contentGuard = yield* Effect.serviceOption(ProjectWorkContentGuard.ProjectWorkContentGuard);
  const eventBus = yield* Effect.serviceOption(ProjectWorkEventBus.ProjectWorkEventBus);

  const replay: ProjectWorkRepositoryShape["replay"] = (projectId) =>
    ensureProjectWorkTables(sql).pipe(
      Effect.flatMap(() => readProjectWorkEvents(sql, projectId)),
      Effect.mapError(toPersistenceSqlError("ProjectWorkRepository.replay")),
    );
  const replayAll: ProjectWorkRepositoryShape["replayAll"] = () =>
    ensureProjectWorkTables(sql).pipe(
      Effect.flatMap(() => readProjectWorkEvents(sql)),
      Effect.mapError(toPersistenceSqlError("ProjectWorkRepository.replayAll")),
    );
  const getAttempt: ProjectWorkRepositoryShape["getAttempt"] = (attemptId) =>
    replayAll().pipe(
      Effect.map((events) => {
        const byProject = new Map<string, Array<ProjectWorkEvent>>();
        for (const event of events)
          byProject.set(event.projectId, [...(byProject.get(event.projectId) ?? []), event]);
        for (const [projectId, projectEvents] of byProject) {
          const state = applyProjectWorkEvents(
            emptyProjectWorkReducerState(projectId),
            projectEvents,
          );
          const attempt = state.attempts.find((entry) => String(entry.attemptId) === attemptId);
          if (attempt !== undefined) return attempt;
        }
        return undefined;
      }),
    );

  const executeUnpublished: ProjectWorkRepositoryShape["executeAuthorized"] = (
    command,
    authorize,
    liveValidate,
    receiptFingerprint,
  ) => {
    const projectId = String(command.projectId);
    return sql
      .withTransaction(
        Effect.gen(function* () {
          yield* ensureProjectWorkTables(sql);
          if (yield* isProjectWorkTombstoned(sql, projectId))
            return yield* Effect.fail(
              new ProjectWorkPolicyError("invalid-state", "Project is permanently deleted"),
            );
          const contentCheck =
            contentGuard._tag === "Some"
              ? contentGuard.value
                  .assertCommandSafe(command)
                  .pipe(
                    Effect.mapError(
                      (cause) => new ProjectWorkPolicyError("invalid-state", String(cause)),
                    ),
                  )
              : Effect.try({
                  try: () => ProjectWorkContentGuard.assertProjectWorkCommandContentSafe(command),
                  catch: (cause) => new ProjectWorkPolicyError("invalid-state", String(cause)),
                });
          yield* contentCheck;
          // Never use a public snapshot or a bounded read as command authority.
          const current = yield* readCurrentState(sql, projectId);
          const commandForDecision =
            command.type === "project-work.comment.add" && command.attribution === undefined
              ? {
                  ...command,
                  attribution: {
                    actor: { kind: "system" as const, id: "project-work-repository" },
                    source: { kind: "system" as const, id: "project-work-repository" },
                    recordedAt: "1970-01-01T00:00:00.000Z",
                  },
                }
              : command;
          // Human protected-revision fingerprints are minted after this
          // gateway normalizes request attribution. They are derived proof,
          // so exclude the field from the idempotency fingerprint; otherwise
          // each retry's fresh server timestamp would look like a new write.
          const commandForFingerprint =
            commandForDecision.type === "project-work.task.revise-protected-specification" &&
            commandForDecision.attribution.actor.kind !== "agent"
              ? {
                  ...commandForDecision,
                  approval: {
                    ...commandForDecision.approval,
                    payloadFingerprint: undefined,
                  },
                }
              : commandForDecision;
          const commandFingerprint =
            receiptFingerprint ??
            projectWorkPayloadFingerprint(withoutAttributionTimestamps(commandForFingerprint));
          const attribution = commandForDecision.attribution;
          const priorReceiptRows = yield* sql<Record<string, unknown>>`
            SELECT payload_fingerprint AS payloadFingerprint,
              actor_kind AS actorKind, actor_id AS actorId,
              source_kind AS sourceKind, source_id AS sourceId,
              result_json AS resultJson
            FROM project_work_command_receipts
            WHERE project_id = ${projectId} AND command_id = ${command.commandId}
          `;
          const priorReceipt = priorReceiptRows[0];
          if (priorReceipt !== undefined) {
            const metadataMatches =
              String(priorReceipt.payloadFingerprint) === commandFingerprint &&
              (priorReceipt.actorKind ?? null) === (attribution?.actor.kind ?? null) &&
              (priorReceipt.actorId ?? null) === (attribution?.actor.id ?? null) &&
              (priorReceipt.sourceKind ?? null) === (attribution?.source.kind ?? null) &&
              (priorReceipt.sourceId ?? null) === (attribution?.source.id ?? null);
            if (!metadataMatches) {
              return yield* Effect.fail(
                new ProjectWorkPolicyError(
                  "duplicate-record",
                  `Command '${command.commandId}' was already committed by a different actor or payload.`,
                  { commandId: command.commandId, projectId, actorBound: true },
                ),
              );
            }
          }
          const priorCommandRows = yield* sql<Record<string, unknown>>`
            SELECT payload_json AS payloadJson
            FROM project_work_events
            WHERE project_id = ${projectId} AND command_id = ${command.commandId}
            ORDER BY sequence ASC
          `;
          const duplicate = priorReceipt !== undefined || priorCommandRows.length > 0;
          if (liveValidate !== undefined) yield* liveValidate({ duplicate });
          if (duplicate) {
            const priorEvents = priorCommandRows.map((row) =>
              decodeProjectWorkEvent(JSON.parse(String(row.payloadJson))),
            );
            if (
              commandForDecision.type === "project-work.foundation.commit" &&
              commandForDecision.guided !== undefined
            )
              yield* Effect.try({
                try: () =>
                  assertProjectTeamGuidedReplayCurrent(
                    current,
                    commandForDecision.guided!.intent,
                    priorEvents,
                  ),
                catch: (cause) =>
                  cause instanceof ProjectWorkPolicyError
                    ? cause
                    : new ProjectWorkPolicyError("invalid-state", String(cause)),
              });
            const normalized = project(current);
            const priorResult =
              priorReceipt?.resultJson === null || priorReceipt?.resultJson === undefined
                ? undefined
                : (() => {
                    try {
                      return JSON.parse(String(priorReceipt.resultJson)) as unknown;
                    } catch {
                      return undefined;
                    }
                  })();
            const priorRevision =
              priorResult !== null &&
              typeof priorResult === "object" &&
              typeof (priorResult as Record<string, unknown>).revision === "number"
                ? Number((priorResult as Record<string, unknown>).revision)
                : priorResult !== null &&
                    typeof priorResult === "object" &&
                    (priorResult as Record<string, unknown>).receipt !== null &&
                    typeof (priorResult as Record<string, unknown>).receipt === "object" &&
                    typeof (
                      (priorResult as Record<string, unknown>).receipt as Record<string, unknown>
                    ).revision === "number"
                  ? Number(
                      ((priorResult as Record<string, unknown>).receipt as Record<string, unknown>)
                        .revision,
                    )
                  : (priorEvents.at(-1)?.revision ?? normalized.revision);
            const priorDelta =
              priorResult !== null && typeof priorResult === "object" && "delta" in priorResult
                ? (priorResult as Record<string, unknown>).delta
                : priorResult;
            const delta = decodeMutationDelta(priorDelta, projectId, priorRevision, priorEvents);
            const writeResult =
              priorResult !== null &&
              typeof priorResult === "object" &&
              "receipt" in priorResult &&
              "delta" in priorResult
                ? (priorResult as ProjectWorkWriteResult)
                : ({
                    projectId,
                    revision: delta.revision,
                    receipt: {
                      commandId: command.commandId,
                      status: "accepted",
                      projectId,
                      revision: delta.revision,
                      eventCount: priorEvents.length,
                    },
                    delta,
                  } as ProjectWorkWriteResult);
            return {
              projectId,
              revision: writeResult.revision,
              events: priorEvents,
              state: normalized,
              delta: writeResult.delta,
              writeResult,
              duplicate: true,
            } satisfies ProjectWorkCommandResult;
          }
          const authorizedCommand = yield* authorize({ commandFingerprint });
          if (authorizedCommand !== command)
            yield* contentGuard._tag === "Some"
              ? contentGuard.value
                  .assertCommandSafe(authorizedCommand)
                  .pipe(
                    Effect.mapError(
                      (cause) => new ProjectWorkPolicyError("invalid-state", String(cause)),
                    ),
                  )
              : Effect.try({
                  try: () =>
                    ProjectWorkContentGuard.assertProjectWorkCommandContentSafe(authorizedCommand),
                  catch: (cause) => new ProjectWorkPolicyError("invalid-state", String(cause)),
                });
          const events = yield* Effect.try({
            try: () => decideProjectWorkCommand(current, authorizedCommand),
            catch: (cause) => {
              if (!(cause instanceof ProjectWorkPolicyError))
                return new ProjectWorkPolicyError("invalid-state", String(cause));
              if (cause.code !== "stale-revision") return cause;
              const changedFields = [
                ...new Set(
                  (current.history ?? [])
                    .filter((event) => event.revision > Number(command.expectedRevision ?? -1))
                    .flatMap((event) => changedFieldsForEvent(event.type)),
                ),
              ];
              return new ProjectWorkPolicyError(cause.code, cause.message, {
                ...(cause.details ?? {}),
                changedFields,
              });
            },
          });
          for (const event of events) {
            // @effect-diagnostics-next-line preferSchemaOverJson:off -- events are already validated reducer payloads.
            const payloadJson = JSON.stringify(event);
            yield* sql`
            INSERT INTO project_work_events (
              event_id, project_id, event_type, occurred_at, command_id, payload_json
            ) VALUES (
              ${event.eventId}, ${projectId}, ${event.type}, ${event.occurredAt},
              ${command.commandId}, ${payloadJson}
            )
          `;
          }
          yield* commitProjectTeamAuthority(
            sql,
            events.flatMap((event) =>
              event.type === "project-work.foundation.recorded" ? [event.record] : [],
            ),
          );
          // Binding ownership and withdrawal commit together; rebuilds never revoke credentials.
          for (const event of events) {
            if (
              event.type !== "project-work.foundation.recorded" ||
              event.record.kind !== "run-binding"
            )
              continue;
            const binding = event.record;
            yield* sql`INSERT OR IGNORE INTO project_team_identity_fences
              (provider_instance_id,thread_id) VALUES (${binding.providerInstanceId},${binding.threadId})`;
            const revokedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
            yield* sql`UPDATE auth_sessions SET revoked_at=${revokedAt}
              WHERE subject=${`agent:mcp:${binding.providerInstanceId}:${binding.threadId}`}
                AND revoked_at IS NULL`;
          }
          const next = applyProjectWorkEvents(current, events);
          const normalized = project(next);
          const latestSequenceRows = yield* sql<Record<string, unknown>>`
            SELECT MAX(sequence) AS sequence
            FROM project_work_events
            WHERE project_id = ${projectId}
          `;
          const lastAppliedSequence = Number(latestSequenceRows[0]?.sequence ?? 0);
          yield* persistProjectWorkState(sql, normalized, projectId, {
            lastAppliedSequence,
            previousState: project(current),
            ...(events.at(-1) === undefined ? {} : { updatedAt: events.at(-1)!.occurredAt }),
          });
          // Attention occurrence and notification publication are part of the
          // same transaction as the event and projection. The reactor only
          // drains this committed queue; it never derives side effects from a
          // post-commit in-memory snapshot.
          yield* enqueueProjectWorkAttentionPublication(
            sql,
            projectId,
            project(current),
            normalized,
            events.at(-1)?.occurredAt ?? DateTime.formatIso(DateTime.nowUnsafe()),
          );
          const createdAt = events.at(-1)?.occurredAt ?? DateTime.formatIso(DateTime.nowUnsafe());
          const delta = mutationDeltaFor(projectId, normalized.revision, events);
          const writeResult = {
            projectId: command.projectId,
            revision: normalized.revision,
            receipt: {
              commandId: command.commandId,
              status: "accepted" as const,
              projectId: command.projectId,
              revision: normalized.revision,
              eventCount: events.length,
            },
            delta,
          } satisfies ProjectWorkWriteResult;
          // @effect-diagnostics-next-line preferSchemaOverJson:off -- event ids are already validated contract values.
          const eventIdsJson = JSON.stringify(events.map((event) => event.eventId));
          // @effect-diagnostics-next-line preferSchemaOverJson:off -- bounded receipt metadata.
          const resultJson = JSON.stringify(writeResult);
          yield* sql`
            INSERT INTO project_work_command_receipts (
              project_id, command_id, payload_fingerprint,
              actor_kind, actor_id, source_kind, source_id,
              event_ids_json, created_at, result_json
            ) VALUES (
              ${projectId}, ${command.commandId}, ${commandFingerprint},
              ${attribution?.actor.kind ?? null}, ${attribution?.actor.id ?? null},
              ${attribution?.source.kind ?? null}, ${attribution?.source.id ?? null},
              ${eventIdsJson}, ${createdAt}, ${resultJson}
            )
          `;
          return {
            projectId,
            revision: normalized.revision,
            events,
            state: normalized,
            delta,
            writeResult,
          } satisfies ProjectWorkCommandResult;
        }),
      )
      .pipe(
        Effect.catchCause((cause) => {
          // A rollback defect or interruption leaves the transaction outcome
          // uncertain. Keep every reason and prevent public typed-error selection
          // from treating the callback's denial as a completed rejection.
          const uncertain = Cause.hasDies(cause) || Cause.hasInterrupts(cause);
          return Effect.failCause(
            Cause.map(cause, (error) =>
              !uncertain && error instanceof ProjectWorkPolicyError
                ? error
                : toPersistenceSqlError("ProjectWorkRepository.executeAuthorized")(
                    uncertain ? cause : error,
                  ),
            ),
          );
        }),
      );
  };
  const publishCommitted = (result: ProjectWorkCommandResult) =>
    result.duplicate === true || Option.isNone(eventBus)
      ? Effect.void
      : Effect.gen(function* () {
          // Resolve cursors after commit.  The event payload intentionally
          // stays independent from storage sequence metadata, while the
          // stream retains a resume-safe cursor for every subscriber.
          const committed = yield* Effect.forEach(result.events, (event) =>
            sql<Record<string, unknown>>`
                    SELECT sequence
                    FROM project_work_events
                    WHERE event_id = ${event.eventId}
                    LIMIT 1
                  `.pipe(
              Effect.map((rows) => ({
                event,
                cursor: Number(rows[0]?.sequence ?? 0),
              })),
            ),
          );
          yield* eventBus.value.publish(committed);
        }).pipe(Effect.ignore);
  const executeAuthorized: ProjectWorkRepositoryShape["executeAuthorized"] = (...args) =>
    executeUnpublished(...args).pipe(Effect.tap(publishCommitted));
  const executeAtomic: ProjectWorkRepositoryShape["executeAtomic"] = (prepare, finalValidate) =>
    Effect.gen(function* () {
      const currentClient = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (Option.isSome(currentClient) && currentClient.value !== sql)
        return yield* Effect.fail(
          new ProjectWorkPolicyError(
            "invalid-state",
            "Atomic work must use its repository SQL client",
          ),
        );
      // An enclosing unmanaged SQL transaction cannot provide an after-commit receipt.
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
        return yield* Effect.fail(
          new ProjectWorkPolicyError("invalid-state", "Atomic work must own its SQL transaction"),
        );
      const committed = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // Preparation loads fresh authority and writes auxiliary rows under this same transaction.
            const commands = yield* prepare;
            if (commands.length > 16)
              return yield* Effect.fail(
                new ProjectWorkPolicyError("invalid-state", "Atomic work command limit exceeded"),
              );
            const results = yield* Effect.forEach(commands, (command) =>
              executeUnpublished(command, () => Effect.succeed(command)),
            );
            if (finalValidate !== undefined) yield* finalValidate;
            return results;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            SqlError.isSqlError(error)
              ? toPersistenceSqlError("ProjectWorkRepository.executeAtomic")(error)
              : error,
          ),
        );
      yield* Effect.forEach(committed, publishCommitted, { discard: true });
      return committed;
    });
  return {
    execute: (command) => executeAuthorized(command, () => Effect.succeed(command)),
    executeAuthorized,
    executeAtomic,
    executeCommand: (command) => executeAuthorized(command, () => Effect.succeed(command)),
    replay,
    replayAll,
    getAttempt,
  } satisfies ProjectWorkRepositoryShape;
});

export const ProjectWorkRepositoryLive = Layer.effect(
  ProjectWorkRepository,
  makeProjectWorkRepository,
);

/** Alias for callers that refer to the command gateway rather than repository. */
export const ProjectWorkCommandRepositoryLive = ProjectWorkRepositoryLive;
