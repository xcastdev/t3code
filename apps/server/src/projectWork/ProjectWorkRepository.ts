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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
  readonly executeAuthorized: <E>(
    command: ProjectWorkCommand,
    authorize: (input: {
      readonly commandFingerprint: string;
    }) => Effect.Effect<ProjectWorkCommand, E>,
  ) => Effect.Effect<ProjectWorkCommandResult, ProjectWorkRepositoryError | E>;
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

const decodeEvent = (value: unknown): ProjectWorkEvent => {
  if (value === null || typeof value !== "object")
    throw new Error("project-work event is not an object");
  const event = value as Record<string, unknown>;
  if (
    typeof event.eventId !== "string" ||
    typeof event.projectId !== "string" ||
    typeof event.type !== "string"
  )
    throw new Error("project-work event is missing metadata");
  return event as unknown as ProjectWorkEvent;
};

const readEvents = (sql: SqlClient.SqlClient, projectId?: string, afterSequence = 0) =>
  Effect.gen(function* () {
    const rows = yield* sql<Record<string, unknown>>`
    SELECT payload_json AS payloadJson
    FROM project_work_events
    ${
      projectId === undefined
        ? afterSequence === 0
          ? sql``
          : sql`WHERE sequence > ${afterSequence}`
        : sql`WHERE project_id = ${projectId} AND sequence > ${afterSequence}`
    }
    ORDER BY sequence ASC
  `;
    return rows.map((row) => decodeEvent(JSON.parse(String(row.payloadJson))));
  });

const readCurrentState = (sql: SqlClient.SqlClient, projectId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<Record<string, unknown>>`
      SELECT last_sequence AS lastSequence, state_json AS stateJson
      FROM project_work_reducer_checkpoints
      WHERE project_id = ${projectId}
      LIMIT 1
    `;
    const checkpoint = rows[0];
    if (checkpoint === undefined) {
      const events = yield* readEvents(sql, projectId);
      return applyProjectWorkEvents(emptyProjectWorkReducerState(projectId), events);
    }
    let state: ProjectWorkReducerState;
    try {
      // @effect-diagnostics-next-line preferSchemaOverJson:off -- validated derived checkpoint with event-log fallback.
      state = JSON.parse(String(checkpoint.stateJson)) as ProjectWorkReducerState;
    } catch {
      const events = yield* readEvents(sql, projectId);
      return applyProjectWorkEvents(emptyProjectWorkReducerState(projectId), events);
    }
    if (state.projectId !== projectId || !Array.isArray(state.tasks)) {
      const events = yield* readEvents(sql, projectId);
      return applyProjectWorkEvents(emptyProjectWorkReducerState(projectId), events);
    }
    const tail = yield* readEvents(sql, projectId, Number(checkpoint.lastSequence));
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
      Effect.flatMap(() => readEvents(sql, projectId)),
      Effect.mapError(toPersistenceSqlError("ProjectWorkRepository.replay")),
    );
  const replayAll: ProjectWorkRepositoryShape["replayAll"] = () =>
    ensureProjectWorkTables(sql).pipe(
      Effect.flatMap(() => readEvents(sql)),
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

  const executeAuthorized: ProjectWorkRepositoryShape["executeAuthorized"] = (
    command,
    authorize,
  ) => {
    const projectId = String(command.projectId);
    return sql
      .withTransaction(
        Effect.gen(function* () {
          yield* ensureProjectWorkTables(sql);
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
          const commandFingerprint = projectWorkPayloadFingerprint(
            withoutAttributionTimestamps(commandForFingerprint),
          );
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
          if (priorCommandRows.length > 0) {
            const priorEvents = priorCommandRows.map((row) =>
              decodeEvent(JSON.parse(String(row.payloadJson))),
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
        Effect.tap((result) =>
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
              }).pipe(Effect.ignore),
        ),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof ProjectWorkPolicyError
            ? cause
            : toPersistenceSqlError("ProjectWorkRepository.executeAuthorized")(cause),
        ),
      );
  };
  return {
    execute: (command) => executeAuthorized(command, () => Effect.succeed(command)),
    executeAuthorized,
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
