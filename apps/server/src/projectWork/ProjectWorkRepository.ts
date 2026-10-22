import { makeProjectWorkProjectGuard } from "./ProjectWorkProjectGuard.ts";
import { EventId, type ProjectTeamRecord, ProjectId } from "@t3tools/contracts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { decodeProjectWorkEvent, readProjectWorkEvents } from "./ProjectWorkEventStore.ts";
const PROJECT_WORK_CHECKPOINT_VERSION = 1;
import {
  type ProjectWorkMutationDelta,
  type ProjectWorkWriteResult,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import {
  applyProjectWorkEvents,
  decideProjectWorkCommand,
  emptyProjectWorkReducerState,
  type ProjectWorkEvent,
  type ProjectWorkReducerState,
} from "./ProjectWorkDecider.ts";
import {
  emptyProjectWorkProjectionState,
  persistProjectWorkState,
  type ProjectWorkProjectionState,
} from "./ProjectWorkProjection.ts";
import { ProjectWorkPolicyError, projectWorkCommandFingerprint } from "./ProjectWorkPolicy.ts";
import * as ProjectWorkEventBus from "./ProjectWorkEventBus.ts";
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
      readonly state: ProjectWorkReducerState;
    }) => Effect.Effect<ProjectWorkCommand, E>,
    liveValidate?: (input: {
      readonly duplicate: boolean;
      readonly state: ProjectWorkReducerState;
      readonly events: ReadonlyArray<ProjectWorkEvent>;
    }) => Effect.Effect<void, L>,
    receiptFingerprint?: string,
  ) => Effect.Effect<ProjectWorkCommandResult, ProjectWorkRepositoryError | E | L>;
  /** A private SQL reservation commits with the Work receipt, before after-commit wake hints. */
  readonly executeReserved: <E>(
    command: ProjectWorkCommand,
    reserve: (result: ProjectWorkCommandResult) => Effect.Effect<void, E>,
    fingerprint: string,
  ) => Effect.Effect<ProjectWorkCommandResult, ProjectWorkRepositoryError | E>;
  readonly executeCommand: ProjectWorkRepositoryShape["execute"];
  readonly replay: (
    projectId: string,
  ) => Effect.Effect<ReadonlyArray<ProjectWorkEvent>, ProjectionRepositoryError>;
  readonly replayAll: () => Effect.Effect<
    ReadonlyArray<ProjectWorkEvent>,
    ProjectionRepositoryError
  >;
}

export class ProjectWorkRepository extends Context.Service<
  ProjectWorkRepository,
  ProjectWorkRepositoryShape
>()("t3/projectWork/ProjectWorkRepository") {}

/** Complete internal authority loader; never a bounded public projection read. */
export const readCurrentState = Effect.fn("ProjectWorkRepository.readCurrentState")(function* (
  sql: SqlClient.SqlClient,
  projectId: string,
) {
  const rows = yield* sql<Record<string, unknown>>`
      SELECT last_sequence AS lastSequence, state_json AS stateJson
      FROM t3_workflow_v2_work_reducer_checkpoints
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

const makeProjectWorkRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStoreV2;
  const assertProject = yield* makeProjectWorkProjectGuard;
  const contentGuard = yield* Effect.serviceOption(ProjectWorkContentGuard.ProjectWorkContentGuard);
  const eventBus = yield* Effect.serviceOption(ProjectWorkEventBus.ProjectWorkEventBus);

  const replay: ProjectWorkRepositoryShape["replay"] = (projectId) =>
    assertProject(projectId).pipe(
      Effect.andThen(readProjectWorkEvents(sql, projectId)),
      Effect.mapError(toPersistenceSqlError("ProjectWorkRepository.replay")),
    );
  const replayAll: ProjectWorkRepositoryShape["replayAll"] = () =>
    readProjectWorkEvents(sql).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectWorkRepository.replayAll")),
    );
  const executeUnpublished = <E, L = never>(
    command: ProjectWorkCommand,
    authorize: (input: {
      readonly commandFingerprint: string;
      readonly state: ProjectWorkReducerState;
    }) => Effect.Effect<ProjectWorkCommand, E>,
    liveValidate?: (input: {
      readonly duplicate: boolean;
      readonly state: ProjectWorkReducerState;
      readonly events: ReadonlyArray<ProjectWorkEvent>;
    }) => Effect.Effect<void, L>,
    receiptFingerprint?: string,
    reserve?: (result: ProjectWorkCommandResult) => Effect.Effect<void, E>,
  ) => {
    const projectId = String(command.projectId);
    const authorizationFailures = new Set<unknown>();
    const isAuthorizationFailure = (error: unknown): error is E | L =>
      authorizationFailures.has(error);
    const captureAuthorizationFailure = (error: unknown) =>
      Effect.sync(() => {
        authorizationFailures.add(error);
      });
    return sql
      .withTransaction(
        Effect.gen(function* () {
          yield* assertProject(projectId);
          if (Option.isNone(yield* projects.get(ProjectId.make(projectId))))
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
            receiptFingerprint ?? projectWorkCommandFingerprint(commandForFingerprint);
          const attribution = commandForDecision.attribution;
          const priorReceiptRows = yield* sql<Record<string, unknown>>`
            SELECT payload_fingerprint AS payloadFingerprint,
              actor_kind AS actorKind, actor_id AS actorId,
              source_kind AS sourceKind, source_id AS sourceId,
              result_json AS resultJson
            FROM t3_workflow_v2_work_command_receipts
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
            FROM t3_workflow_v2_work_events
            WHERE project_id = ${projectId} AND command_id = ${command.commandId}
            ORDER BY sequence ASC
          `;
          const duplicate = priorReceipt !== undefined || priorCommandRows.length > 0;
          if (liveValidate !== undefined)
            yield* liveValidate({
              duplicate,
              state: current,
              events: priorCommandRows.map((row) =>
                decodeProjectWorkEvent(JSON.parse(String(row.payloadJson))),
              ),
            }).pipe(Effect.tapError(captureAuthorizationFailure));
          if (duplicate) {
            const priorEvents = priorCommandRows.map((row) =>
              decodeProjectWorkEvent(JSON.parse(String(row.payloadJson))),
            );
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
            const result = {
              projectId,
              revision: writeResult.revision,
              events: priorEvents,
              state: normalized,
              delta: writeResult.delta,
              writeResult,
              duplicate: true,
            } satisfies ProjectWorkCommandResult;
            if (reserve !== undefined)
              yield* reserve(result).pipe(Effect.tapError(captureAuthorizationFailure));
            return result;
          }
          const authorizedCommand = yield* authorize({ commandFingerprint, state: current }).pipe(
            Effect.tapError(captureAuthorizationFailure),
          );
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
                ...cause.details,
                changedFields,
              });
            },
          });
          for (const event of events) {
            // @effect-diagnostics-next-line preferSchemaOverJson:off -- events are already validated reducer payloads.
            const payloadJson = JSON.stringify(event);
            yield* sql`
            INSERT INTO t3_workflow_v2_work_events (
              event_id, project_id, event_type, occurred_at, command_id, payload_json
            ) VALUES (
              ${event.eventId}, ${projectId}, ${event.type}, ${event.occurredAt},
              ${command.commandId}, ${payloadJson}
            )
          `;
          }
          const next = applyProjectWorkEvents(current, events);
          const normalized = project(next);
          const latestSequenceRows = yield* sql<Record<string, unknown>>`
            SELECT MAX(sequence) AS sequence
            FROM t3_workflow_v2_work_events
            WHERE project_id = ${projectId}
          `;
          const lastAppliedSequence = Number(latestSequenceRows[0]?.sequence ?? 0);
          yield* persistProjectWorkState(sql, normalized, projectId, {
            lastAppliedSequence,
            previousState: project(current),
            ...(events.at(-1) === undefined ? {} : { updatedAt: events.at(-1)!.occurredAt }),
          });
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
            INSERT INTO t3_workflow_v2_work_command_receipts (
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
          const result = {
            projectId,
            revision: normalized.revision,
            events,
            state: normalized,
            delta,
            writeResult,
          } satisfies ProjectWorkCommandResult;
          if (reserve !== undefined)
            yield* reserve(result).pipe(Effect.tapError(captureAuthorizationFailure));
          return result;
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
              !uncertain &&
              (error instanceof ProjectWorkPolicyError || isAuthorizationFailure(error))
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
                    FROM t3_workflow_v2_work_events
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
    Effect.serviceOption(sql.transactionService).pipe(
      Effect.flatMap((transaction) =>
        Option.isSome(transaction)
          ? Effect.fail(
              new ProjectWorkPolicyError(
                "invalid-state",
                "Work commands must own their transaction",
              ),
            )
          : executeUnpublished(...args).pipe(Effect.tap(publishCommitted)),
      ),
    );
  return {
    execute: (command) => executeAuthorized(command, () => Effect.succeed(command)),
    executeAuthorized,
    executeReserved: (command, reserve, fingerprint) =>
      Effect.serviceOption(sql.transactionService).pipe(
        Effect.flatMap((transaction) =>
          Option.isSome(transaction)
            ? Effect.fail(
                new ProjectWorkPolicyError(
                  "invalid-state",
                  "Work reservations must own their transaction",
                ),
              )
            : executeUnpublished(
                command,
                () => Effect.succeed(command),
                undefined,
                fingerprint,
                reserve,
              ).pipe(Effect.tap(publishCommitted)),
        ),
      ),
    executeCommand: (command) => executeAuthorized(command, () => Effect.succeed(command)),
    replay,
    replayAll,
  } satisfies ProjectWorkRepositoryShape;
});

export const ProjectWorkRepositoryLive = Layer.effect(
  ProjectWorkRepository,
  makeProjectWorkRepository,
);

/** Alias for callers that refer to the command gateway rather than repository. */
export const ProjectWorkCommandRepositoryLive = ProjectWorkRepositoryLive;

const encodeAdmissionJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Private admission writes share the V2 transaction; hints are published by its owner after commit. */
export const appendAdmissionFoundationRecords = Effect.fn(
  "ProjectWorkRepository.appendAdmissionFoundationRecords",
)(function* (
  sql: SqlClient.SqlClient,
  projectId: string,
  commandId: string,
  records: ReadonlyArray<ProjectTeamRecord>,
  now: string,
) {
  const transaction = yield* Effect.serviceOption(sql.transactionService);
  if (Option.isNone(transaction))
    return yield* Effect.fail(
      new ProjectWorkPolicyError("invalid-state", "Admission requires an existing transaction"),
    );
  const current = yield* readCurrentState(sql, projectId);
  const priorEvents = yield* sql<{
    event_id: string;
  }>`SELECT event_id FROM t3_workflow_v2_work_events WHERE project_id=${projectId} AND command_id=${`admission:${commandId}`} ORDER BY sequence`;
  const events: Array<ProjectWorkEvent> = records.map((record, index) => ({
    type: "project-work.foundation.recorded",
    eventId: EventId.make(`admission:${projectId}:${commandId}:${priorEvents.length + index}`),
    projectId,
    revision: current.revision + index + 1,
    occurredAt: now,
    record,
  }));
  const next = applyProjectWorkEvents(current, events);
  for (const event of events) {
    const payloadJson = yield* encodeAdmissionJson(event);
    yield* sql`INSERT INTO t3_workflow_v2_work_events(event_id,project_id,event_type,occurred_at,command_id,payload_json)
      VALUES (${event.eventId},${projectId},${event.type},${now},${`admission:${commandId}`},${payloadJson})`;
  }
  const rows = yield* sql<{
    sequence: number;
  }>`SELECT MAX(sequence) AS sequence FROM t3_workflow_v2_work_events WHERE project_id = ${projectId}`;
  yield* persistProjectWorkState(sql, project(next), projectId, {
    lastAppliedSequence: Number(rows[0]?.sequence ?? 0),
    previousState: project(current),
    updatedAt: now,
  });
  const eventIdsJson = yield* encodeAdmissionJson([
    ...priorEvents.map((event) => event.event_id),
    ...events.map((event) => event.eventId),
  ]);
  const resultJson = yield* encodeAdmissionJson({ revision: next.revision });
  yield* sql`INSERT INTO t3_workflow_v2_work_command_receipts(project_id,command_id,payload_fingerprint,event_ids_json,created_at,result_json)
    VALUES (${projectId},${`admission:${commandId}`},${projectWorkCommandFingerprint(records)},${eventIdsJson},${now},${resultJson}) ON CONFLICT(project_id,command_id) DO UPDATE SET event_ids_json=excluded.event_ids_json,result_json=excluded.result_json`;
});
