import { modelSelectionsEqual } from "@t3tools/shared/model";
import {
  CommandId,
  type OrchestrationV2Run,
  OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  OrchestrationV2StoredEvent,
  ProviderThreadId,
  type ProviderSessionId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  NodeId,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { validateHistoryArchiveCommit } from "./ThreadHistoryArchiveCommitGuard.ts";
import { replayAndBufferProjectedLiveEvents } from "./LiveStreamBudget.ts";
import type { UnsequencedProjectEvent } from "../persistence/OrchestrationEventStore.ts";
import { projectDomainEventForWire } from "./WireProjection.ts";
import { makeRunOutcomeRecorder, type RunOutcome } from "./RunMetrics.ts";

import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RunAdmission from "./RunAdmission.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

export class EventSinkWriteError extends Schema.TaggedError<EventSinkWriteError>()(
  "EventSinkWriteError",
  {
    eventCount: Schema.Number,
    commandId: Schema.optional(CommandId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to write ${this.eventCount} orchestration V2 event(s).`;
  }
}

export class EventSinkStreamError extends Schema.TaggedError<EventSinkStreamError>()(
  "EventSinkStreamError",
  {
    threadId: Schema.optional(ThreadId),
    afterSequence: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.threadId === undefined
      ? "Failed to stream orchestration V2 events."
      : `Failed to stream orchestration V2 events for thread ${this.threadId}.`;
  }
}

export const EventSinkV2Error = Schema.Union([EventSinkWriteError, EventSinkStreamError]);
export type EventSinkV2Error = typeof EventSinkV2Error.Type;

interface ProviderEventOrigin {
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly runId?: RunId;
}

export interface ExactRunStopTarget {
  readonly runId: RunId;
  readonly runAttemptId: RunAttemptId;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerSessionId: ProviderSessionId;
}

export interface EventSinkV2Shape {
  readonly write: (input: {
    readonly advanceProviderSessionRuntime?: ProviderSessionId;
    readonly expectedProviderSessionRuntime?: {
      readonly providerSessionId: ProviderSessionId;
      readonly runtimeId: string;
    };
    /** Return no events if another thread owns this native session at commit time. */
    readonly unlessNativeThreadOwned?: Pick<
      OrchestrationV2ProviderThread,
      "driver" | "providerInstanceId" | "appThreadId" | "nativeThreadRef"
    >;
    readonly guardPendingUserInputCancellations?: boolean;
    readonly providerEventOrigin?: ProviderEventOrigin;
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly writeWithEffects: (input: {
    readonly advanceProviderSessionRuntime?: ProviderSessionId;
    readonly expectedProviderSessionRuntime?: {
      readonly providerSessionId: ProviderSessionId;
      readonly runtimeId: string;
    };
    readonly instructionReceipt?: {
      readonly runtimeId?: string;
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly runAttemptId: RunAttemptId;
      readonly providerThreadId: ProviderThreadId;
      readonly providerSessionId: ProviderSessionId;
      readonly snapshotJson: string;
      readonly appliedAt: string;
    };
    /**
     * Rebuilds each run.updated from the stored row with only its delegatedCompletion replaced.
     * The batch must not also change that run's lifecycle.
     */
    readonly updateDelegatedCompletionOnly?: boolean;
    readonly unlessNativeThreadOwned?: Pick<
      OrchestrationV2ProviderThread,
      "driver" | "providerInstanceId" | "appThreadId" | "nativeThreadRef"
    >;
    readonly guardPendingUserInputCancellations?: boolean;
    readonly providerEventOrigin?: ProviderEventOrigin;
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly writeIfRunCurrent: (input: {
    readonly guardPendingUserInputCancellations?: boolean;
    readonly providerEventOrigin?: ProviderEventOrigin;
    readonly commandId?: CommandId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly expectedStatus: OrchestrationV2Run["status"];
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects?: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  /**
   * Atomically commit only when the provider thread is still owned by the
   * expected run attempt and ordinal. Used for late post-terminal
   * provider_thread updates so a completed or superseded attempt cannot clobber
   * a newer attempt that already claimed the thread.
   */
  readonly writeIfProviderThreadOwner: (input: {
    readonly guardPendingUserInputCancellations?: boolean;
    readonly providerEventOrigin?: ProviderEventOrigin;
    readonly commandId?: CommandId;
    readonly providerThreadId: ProviderThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly expectedLastRunOrdinal: number;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  /**
   * Atomically commit only while the stored provider thread still equals
   * `expected`, the row its writer read, so a read-modify-write of the row
   * cannot overwrite an update published in between. The whole row is
   * compared because not every writer moves `updatedAt`.
   */
  readonly writeIfProviderThreadUnchanged: (input: {
    readonly expected: OrchestrationV2ProviderThread;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  readonly commitCommand: (input: {
    readonly retainedOwner?: RunAdmission.RetainedOwnerConstraint | null;
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly ownerDeadline?: RunAdmission.OwnerDeadlineControl;
    readonly exactRunStop?: ExactRunStopTarget;
    readonly acceptedAt: DateTime.Utc;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
    readonly cancelUnsettledEffects?: {
      readonly effectTypes: ReadonlyArray<EffectOutbox.OrchestrationEffectRequestV2["type"]>;
      readonly reason: string;
    };
  }) => Effect.Effect<
    {
      readonly receipt: CommandReceiptStore.CommandReceiptV2;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
      readonly committed: boolean;
      readonly cancelledEffectCount: number;
    },
    EventSinkV2Error
  >;
  readonly commitRejectedCommand: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly rejectedAt: DateTime.Utc;
    readonly error: string;
  }) => Effect.Effect<CommandReceiptStore.CommandReceiptV2, EventSinkV2Error>;
  readonly assertProjectCommand: (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly commandType: string;
  }) => Effect.Effect<void, EventSinkV2Error>;
  readonly commitProjectCommand: (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly commandType: string;
    readonly acceptedAt: DateTime.Utc;
    readonly event: UnsequencedProjectEvent;
  }) => Effect.Effect<
    { readonly receipt: CommandReceiptStore.ProjectCommandReceiptV2; readonly committed: boolean },
    EventSinkV2Error
  >;
  readonly commitRejectedProjectCommand: (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly commandType: string;
    readonly rejectedAt: DateTime.Utc;
    readonly error: string;
  }) => Effect.Effect<CommandReceiptStore.ProjectCommandReceiptV2, EventSinkV2Error>;
  readonly stream: (input?: {
    readonly threadId?: ThreadId;
    readonly afterSequence?: number;
    readonly eventType?: OrchestrationV2DomainEvent["type"];
    /** Bound RPC subscribers; internal workers must not drop their subscription under load. */
    readonly bounded?: boolean;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
  readonly latestSequence: (input?: {
    readonly threadId?: ThreadId;
  }) => Effect.Effect<number, EventSinkV2Error>;
  readonly readByCommandId: (input: {
    readonly commandId: CommandId;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
}

export class EventSinkV2 extends Context.Service<EventSinkV2, EventSinkV2Shape>()(
  "t3/orchestration-v2/EventSink/EventSinkV2",
) {}

// Cancellation notifications are deferred until the surrounding SQL transaction commits.
class CommitCancellations extends Context.Reference<Array<string> | undefined>(
  "t3/orchestration-v2/EventSink/CommitCancellations",
  { defaultValue: () => undefined },
) {}

class AdmissionDenied extends Schema.TaggedError<AdmissionDenied>()("AdmissionDenied", {
  reason: Schema.String,
}) {}

const layerBase: Layer.Layer<
  EventSinkV2,
  never,
  | RunAdmission.RunAdmission
  | CommandReceiptStore.CommandReceiptStoreV2
  | EffectOutbox.EffectOutboxV2
  | EventStore.EventStoreV2
  | ProjectionStore.ProjectionStoreV2
  | ProjectStore.ProjectStoreV2
  | SqlClient.SqlClient
  | TurnItemPositionStore.TurnItemPositionStoreV2
> = Layer.effect(
  EventSinkV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runAdmission = yield* RunAdmission.RunAdmission;
    const commandReceipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const effectOutbox = yield* EffectOutbox.EffectOutboxV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const turnItemPositions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const liveEvents = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
    const liveEventsByType = new Map<
      OrchestrationV2DomainEvent["type"],
      PubSub.PubSub<OrchestrationV2StoredEvent>
    >();
    const publishLiveEvents =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (events: ReadonlyArray<OrchestrationV2StoredEvent>) {
        yield* PubSub.publishAll(liveEvents, events);
        for (const [type, pubsub] of liveEventsByType) {
          yield* PubSub.publishAll(
            pubsub,
            events.filter((stored) => stored.event.type === type),
          );
        }
      });
    const runOutcomes = makeRunOutcomeRecorder((threadId) =>
      // One payload row; unlike the shell, it still resolves a deleted child thread.
      projectionStore
        .getThread(threadId)
        .pipe(Effect.map((thread) => thread.lineage.relationshipToParent === "subagent")),
    );
    // Recorded before publication, so an interrupted publish cannot lose a committed outcome.
    const publishStoredEvents = (
      events: ReadonlyArray<OrchestrationV2StoredEvent>,
      outcomes: ReadonlyArray<RunOutcome>,
    ) =>
      runOutcomes
        .record(outcomes)
        .pipe(
          Effect.andThen(eventStore.publishCommitted(events)),
          Effect.andThen(publishLiveEvents(events)),
          Effect.andThen(
            events.some((stored) => stored.event.type === "provider-turn.updated")
              ? effectOutbox.notifyAvailable()
              : Effect.void,
          ),
        );

    // Transactions commit one at a time, but each writer publishes after its
    // commit. If a writer is descheduled in between, a later commit reaches
    // subscribers first, and clients drop any event at or below the newest
    // sequence they have applied.
    const publishLane = yield* Semaphore.make(1);
    const commitThenPublish = <A, E, R>(
      transaction: Effect.Effect<A, E, R>,
      publish: (committed: A) => Effect.Effect<void>,
    ) =>
      Effect.suspend(() => {
        let holdsLane = false;
        const cancellations: Array<string> = [];
        const takeLane = publishLane.take(1).pipe(
          Effect.andThen(
            Effect.sync(() => {
              holdsLane = true;
            }),
          ),
          Effect.uninterruptible,
        );
        return sql.withTransaction(Effect.tap(transaction, () => takeLane)).pipe(
          Effect.provideService(CommitCancellations, cancellations),
          Effect.tap(() => effectOutbox.signalCancellations(cancellations)),
          Effect.tap(publish),
          Effect.ensuring(Effect.suspend(() => (holdsLane ? publishLane.release(1) : Effect.void))),
        );
      });

    // A user can answer after terminal normalization reads the pending request.
    // Recheck inside the write transaction so stale cleanup cannot erase answers.
    const guardUserInputCancellations =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (events: ReadonlyArray<OrchestrationV2DomainEvent>) {
        const staleRequests = new Set<RuntimeRequestId>();
        const staleNodes = new Set<NodeId>();
        for (const event of events) {
          if (
            event.type !== "runtime-request.updated" ||
            event.payload.kind !== "user_input" ||
            event.payload.status !== "cancelled"
          )
            continue;
          const current = yield* projectionStore.getRuntimeRequest(
            event.threadId,
            event.payload.id,
          );
          if (
            current?.status !== "pending" ||
            current.kind !== "user_input" ||
            current.providerTurnId !== event.payload.providerTurnId ||
            current.responseCapability.type === "message"
          ) {
            staleRequests.add(event.payload.id);
            staleNodes.add(event.payload.nodeId);
          }
        }
        return events.filter((event) => {
          switch (event.type) {
            case "runtime-request.updated":
              return event.payload.status !== "cancelled" || !staleRequests.has(event.payload.id);
            case "node.updated":
              return event.payload.status !== "cancelled" || !staleNodes.has(event.payload.id);
            case "turn-item.updated":
              return (
                event.payload.type !== "user_input_request" ||
                event.payload.status !== "cancelled" ||
                !staleRequests.has(event.payload.requestId)
              );
            default:
              return true;
          }
        });
      });

    const matchesProviderSessionRuntimes = Effect.fn("EventSink.matchesProviderSessionRuntimes")(
      function* (events: ReadonlyArray<OrchestrationV2DomainEvent>, advance?: ProviderSessionId) {
        for (const event of events) {
          if (
            (event.type !== "provider-session.attached" &&
              event.type !== "provider-session.updated") ||
            event.payload.instructionRuntimeId === undefined
          )
            continue;
          if (event.type === "provider-session.attached" && event.payload.id === advance) continue;
          const rows = yield* sql<{
            runtime_id: string | null;
          }>`SELECT json_extract(payload_json,'$.instructionRuntimeId') AS runtime_id FROM orchestration_v2_projection_provider_sessions WHERE provider_session_id=${event.payload.id}`;
          if (rows[0]?.runtime_id !== event.payload.instructionRuntimeId) return false;
        }
        return true;
      },
    );

    const normalizeEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) => {
      const runOrdinals = new Map(
        events.flatMap((event) =>
          event.type === "run.created" || event.type === "run.updated"
            ? [[event.payload.id, event.payload.ordinal] as const]
            : [],
        ),
      );
      return Effect.forEach(
        events,
        (event): Effect.Effect<OrchestrationV2DomainEvent, unknown> =>
          event.type === "turn-item.updated"
            ? turnItemPositions
                .normalize(
                  event.payload,
                  event.payload.runId === null ? undefined : runOrdinals.get(event.payload.runId),
                )
                .pipe(Effect.map((payload) => ({ ...event, payload })))
            : event.type === "run.updated"
              ? projectionStore
                  .getThreadRecords(event.threadId, ["runs"], { runIds: [event.payload.id] })
                  .pipe(
                    Effect.map(({ runs }) => {
                      const current = runs[0];
                      if (
                        current !== undefined &&
                        current.activeAttemptId !== event.payload.activeAttemptId
                      ) {
                        const { effectiveInstructions: _previousInstructions, ...payload } =
                          event.payload;
                        return { ...event, payload };
                      }
                      return current?.effectiveInstructions !== undefined &&
                        event.payload.effectiveInstructions === undefined
                        ? {
                            ...event,
                            payload: {
                              ...event.payload,
                              effectiveInstructions: current.effectiveInstructions,
                            },
                          }
                        : event;
                    }),
                  )
              : event.type === "provider-session.updated"
                ? projectionStore.getThreadRecords(event.threadId, ["providerSessions"]).pipe(
                    Effect.map(({ providerSessions }) => {
                      const current = providerSessions.find(
                        (session) => session.id === event.payload.id,
                      );
                      return current === undefined
                        ? event
                        : {
                            ...event,
                            payload: {
                              ...event.payload,
                              ...(event.payload.effectiveInstructions === undefined &&
                              current.effectiveInstructions !== undefined
                                ? { effectiveInstructions: current.effectiveInstructions }
                                : {}),
                              ...(event.payload.instructionRuntimeId !== undefined ||
                              current.instructionRuntimeId === undefined
                                ? {}
                                : { instructionRuntimeId: current.instructionRuntimeId }),
                            },
                          };
                    }),
                  )
                : Effect.succeed(event),
        { concurrency: 1 },
      );
    };

    const applyStoredEvents =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (
        storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>,
        origin?: ProviderEventOrigin,
      ) {
        yield* Effect.forEach(storedEvents, (stored) => projectionStore.apply(stored.event), {
          concurrency: 1,
        });
        // Native acceptance can arrive after V2 cancelled a start. Keep recording
        // the old turn, and stop that exact native destination without touching a successor.
        for (const { event } of storedEvents) {
          if (
            event.type !== "provider-turn.updated" ||
            origin === undefined ||
            event.threadId !== origin.threadId ||
            event.payload.runAttemptId === null
          )
            continue;
          const { attempts } = yield* projectionStore.getThreadRecords(event.threadId, [
            "attempts",
          ]);
          const attempt = attempts.find((candidate) => candidate.id === event.payload.runAttemptId);
          if (
            attempt === undefined ||
            attempt.providerThreadId !== event.payload.providerThreadId ||
            attempt.rootNodeId !== event.payload.nodeId ||
            (origin.runId !== undefined && origin.runId !== attempt.runId) ||
            (event.runId !== undefined && event.runId !== attempt.runId)
          )
            continue;
          const now = DateTime.formatIso(yield* DateTime.now);
          const terminal = ["completed", "interrupted", "failed", "cancelled"].includes(
            event.payload.status,
          );
          if (
            terminal &&
            (event.payload.completedAt === null || event.payload.nativeTurnRef?.nativeId == null)
          )
            continue;
          const observed = yield* runAdmission.observeNativeTurn({
            threadId: event.threadId,
            runId: attempt.runId,
            runAttemptId: attempt.id,
            now,
            terminal,
          });
          if (observed.cancelControlIds.length > 0) {
            const cancelled = yield* effectOutbox.cancelByIds({
              effectIds: observed.cancelControlIds,
              reason: "Owned native turn settled.",
            });
            (yield* CommitCancellations)?.push(...cancelled);
          }
          if (observed.stop && !terminal) {
            const commandId = CommandId.make(
              `command:owner-native-stop:${attempt.id}:${event.payload.id}`,
            );
            yield* effectOutbox.enqueue([
              {
                id: `effect:${commandId}`,
                commandId,
                threadId: event.threadId,
                request: {
                  type: "provider-turn.interrupt",
                  providerSessionId: origin.providerSessionId,
                  providerThreadId: event.payload.providerThreadId,
                  providerTurnId: event.payload.id,
                },
              },
            ]);
          }
        }
        for (const { event } of storedEvents) {
          if (
            event.type !== "run.updated" ||
            !["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
              event.payload.status,
            )
          )
            continue;
          const controlIds = yield* runAdmission.settle({
            threadId: event.threadId,
            runId: event.payload.id,
            now: DateTime.formatIso(yield* DateTime.now),
          });
          if (controlIds.length > 0) {
            const cancelled = yield* effectOutbox.cancelByIds({
              effectIds: controlIds,
              reason: "Owned run settled.",
            });
            (yield* CommitCancellations)?.push(...cancelled);
          }
        }
        const sequence = storedEvents.at(-1)?.sequence;
        if (sequence !== undefined) {
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name,
              schema_version,
              last_sequence,
              updated_at
            )
            VALUES (
              'thread-projections',
              ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
              ${sequence},
              ${now}
            )
            ON CONFLICT(projection_name)
            DO UPDATE SET
              schema_version = excluded.schema_version,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
        }
        // Read lineage here, on the connection this transaction holds; see makeRunOutcomeRecorder.
        return yield* runOutcomes.prepare(storedEvents);
      });

    const writeEffect = Effect.fn("orchestrationV2.EventSink.write")(function* (
      input: Parameters<EventSinkV2Shape["writeWithEffects"]>[0],
    ) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId ?? null,
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.thread_id": input.events[0]?.threadId ?? null,
      });

      const { committed } = yield* commitThenPublish(
        Effect.gen(function* () {
          const expectedRuntime = input.expectedProviderSessionRuntime;
          if (expectedRuntime !== undefined) {
            const sessions = yield* sql<{
              runtime_id: string | null;
            }>`SELECT json_extract(payload_json,'$.instructionRuntimeId') AS runtime_id FROM orchestration_v2_projection_provider_sessions WHERE provider_session_id=${expectedRuntime.providerSessionId}`;
            if (sessions[0]?.runtime_id !== expectedRuntime.runtimeId)
              return { committed: [], outcomes: [] };
          }
          // Check ownership in the same transaction that claims the native session.
          const imported = input.unlessNativeThreadOwned;
          if (imported?.nativeThreadRef != null) {
            const owners = yield* sql`
              SELECT provider_thread_id
              FROM orchestration_v2_projection_provider_threads
              WHERE driver = ${imported.driver}
                AND provider_instance_id = ${imported.providerInstanceId}
                AND thread_id IS NOT ${imported.appThreadId}
                AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${imported.nativeThreadRef.nativeId}
              LIMIT 1
            `;
            if (owners.length > 0) return { committed: [], outcomes: [] };
          }
          // Checkpoint capture can finish after a cohort writer reads its parent run.
          // Merge in this transaction so the event log and projection keep that completion.
          const events = input.updateDelegatedCompletionOnly
            ? yield* Effect.forEach(input.events, (event) =>
                Effect.gen(function* () {
                  if (event.type !== "run.updated") return event;
                  const { runs } = yield* projectionStore.getThreadRecords(
                    event.threadId,
                    ["runs"],
                    { runIds: [event.payload.id] },
                  );
                  const current = runs[0];
                  return current === undefined
                    ? event
                    : {
                        ...event,
                        payload: {
                          ...current,
                          delegatedCompletion: event.payload.delegatedCompletion,
                        },
                      };
                }),
              )
            : input.events;
          let instructionEvents = events;
          if (input.instructionReceipt !== undefined) {
            const receipt = input.instructionReceipt;
            const rows = yield* sql<{
              requested_snapshot_json: string;
              applied_snapshot_json: string | null;
            }>`
              SELECT requested_snapshot_json,applied_snapshot_json FROM t3_workflow_v2_instruction_deliveries
              WHERE run_attempt_id=${receipt.runAttemptId} AND thread_id=${receipt.threadId}
              AND run_id=${receipt.runId} AND provider_thread_id=${receipt.providerThreadId}
              AND provider_session_id=${receipt.providerSessionId}`;
            const retained = rows[0];
            if (
              retained === undefined ||
              retained.requested_snapshot_json !== receipt.snapshotJson ||
              retained.applied_snapshot_json !== null
            )
              return { committed: [], outcomes: [] };
            yield* sql`UPDATE t3_workflow_v2_instruction_deliveries SET applied_snapshot_json=${receipt.snapshotJson},state='applied',applied_at=${receipt.appliedAt}
              WHERE run_attempt_id=${receipt.runAttemptId}`;
            const records = yield* projectionStore.getThreadRecords(receipt.threadId, [
              "runs",
              "providerSessions",
              "providerThreads",
            ]);
            const currentRun = records.runs.find((run) => run.id === receipt.runId);
            const currentSession = records.providerSessions.find(
              (session) => session.id === receipt.providerSessionId,
            );
            const currentThread = records.providerThreads.find(
              (thread) => thread.id === receipt.providerThreadId,
            );
            const latest = yield* sql<{
              run_attempt_id: string;
            }>`SELECT run_attempt_id FROM t3_workflow_v2_instruction_deliveries WHERE provider_session_id=${receipt.providerSessionId} ORDER BY rowid DESC LIMIT 1`;
            instructionEvents = events.flatMap(
              (event): ReadonlyArray<OrchestrationV2DomainEvent> => {
                if (event.type === "run.updated") {
                  return currentRun?.activeAttemptId === receipt.runAttemptId
                    ? [
                        {
                          ...event,
                          payload: {
                            ...currentRun,
                            effectiveInstructions: event.payload.effectiveInstructions,
                          },
                        },
                      ]
                    : [];
                }
                if (event.type === "provider-session.updated") {
                  return currentSession !== undefined &&
                    currentSession.instructionRuntimeId === receipt.runtimeId &&
                    currentThread?.providerSessionId === receipt.providerSessionId &&
                    latest[0]?.run_attempt_id === receipt.runAttemptId
                    ? [
                        {
                          ...event,
                          payload: {
                            ...currentSession,
                            effectiveInstructions: event.payload.effectiveInstructions,
                          },
                        },
                      ]
                    : [];
                }
                return [];
              },
            );
          }
          if (
            !(yield* matchesProviderSessionRuntimes(
              instructionEvents,
              input.advanceProviderSessionRuntime,
            ))
          )
            return { committed: [], outcomes: [] };
          const normalized = yield* normalizeEvents(
            input.guardPendingUserInputCancellations === true
              ? yield* guardUserInputCancellations(instructionEvents)
              : instructionEvents,
          );
          const committed = yield* eventStore.append({
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            events: normalized,
          });
          const outcomes = yield* applyStoredEvents(committed, input.providerEventOrigin);
          yield* effectOutbox.enqueue(input.effects);
          return { committed, outcomes };
        }).pipe(Effect.withTracerEnabled(false)),
        ({ committed, outcomes }) =>
          Effect.gen(function* () {
            if (input.effects.length > 0) {
              yield* effectOutbox.notifyAvailable(input.effects.length);
            }
            yield* publishStoredEvents(committed, outcomes);
          }),
      );
      return committed;
    });

    const writeIfRunCurrentEffect = Effect.fn("orchestrationV2.EventSink.writeIfRunCurrent")(
      function* (input: Parameters<EventSinkV2Shape["writeIfRunCurrent"]>[0]) {
        yield* Effect.annotateCurrentSpan({
          "orchestration_v2.command_id": input.commandId ?? null,
          "orchestration_v2.event_count": input.events.length,
          "orchestration_v2.run_id": input.runId,
          "orchestration_v2.thread_id": input.threadId,
        });

        return yield* commitThenPublish(
          Effect.gen(function* () {
            const rows = yield* sql<{
              readonly status: string;
              readonly active_attempt_id: string | null;
            }>`
            SELECT
              status,
              json_extract(payload_json, '$.activeAttemptId') AS active_attempt_id
            FROM orchestration_v2_projection_runs
            WHERE run_id = ${input.runId}
              AND thread_id = ${input.threadId}
            LIMIT 1
          `;
            const current = rows[0];
            if (
              !(yield* matchesProviderSessionRuntimes(input.events)) ||
              current === undefined ||
              current.status !== input.expectedStatus ||
              current.active_attempt_id !== input.activeAttemptId
            ) {
              return {
                committed: false as const,
                storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
              };
            }

            const normalized = yield* normalizeEvents(
              input.guardPendingUserInputCancellations === true
                ? yield* guardUserInputCancellations(input.events)
                : input.events,
            );
            const storedEvents = yield* eventStore.append({
              ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
              events: normalized,
            });
            const outcomes = yield* applyStoredEvents(storedEvents, input.providerEventOrigin);
            yield* effectOutbox.enqueue(input.effects ?? []);
            return { committed: true as const, storedEvents, outcomes };
          }),
          (result) =>
            Effect.gen(function* () {
              if (!result.committed) return;
              if (input.effects !== undefined && input.effects.length > 0) {
                yield* effectOutbox.notifyAvailable(input.effects.length);
              }
              yield* publishStoredEvents(result.storedEvents, result.outcomes);
            }),
        );
      },
    );

    const writeIfProviderThreadOwnerEffect = Effect.fn(
      "orchestrationV2.EventSink.writeIfProviderThreadOwner",
    )(function* (input: Parameters<EventSinkV2Shape["writeIfProviderThreadOwner"]>[0]) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId ?? null,
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.provider_thread_id": input.providerThreadId,
        "orchestration_v2.run_id": input.runId,
        "orchestration_v2.active_attempt_id": input.activeAttemptId,
        "orchestration_v2.expected_last_run_ordinal": input.expectedLastRunOrdinal,
      });

      return yield* commitThenPublish(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly active_attempt_id: string | null;
            readonly last_run_ordinal: number | null;
          }>`
            SELECT
              json_extract(r.payload_json, '$.activeAttemptId') AS active_attempt_id,
              p.last_run_ordinal
            FROM orchestration_v2_projection_provider_threads p
            JOIN orchestration_v2_projection_runs r
              ON r.run_id = ${input.runId}
             AND r.thread_id = p.thread_id
            WHERE p.provider_thread_id = ${input.providerThreadId}
            LIMIT 1
          `;
          const current = rows[0];
          if (
            current === undefined ||
            current.active_attempt_id !== input.activeAttemptId ||
            current.last_run_ordinal !== input.expectedLastRunOrdinal
          ) {
            return {
              committed: false as const,
              storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
            };
          }

          const normalized = yield* normalizeEvents(
            input.guardPendingUserInputCancellations === true
              ? yield* guardUserInputCancellations(input.events)
              : input.events,
          );
          const storedEvents = yield* eventStore.append({
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            events: normalized,
          });
          const outcomes = yield* applyStoredEvents(storedEvents, input.providerEventOrigin);
          return { committed: true as const, storedEvents, outcomes };
        }),
        (result) =>
          result.committed
            ? publishStoredEvents(result.storedEvents, result.outcomes)
            : Effect.void,
      );
    });

    const writeIfProviderThreadUnchangedEffect = Effect.fn(
      "orchestrationV2.EventSink.writeIfProviderThreadUnchanged",
    )(function* (input: Parameters<EventSinkV2Shape["writeIfProviderThreadUnchanged"]>[0]) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.provider_thread_id": input.expected.id,
      });
      const expectedJson = yield* ProjectionStore.encodeProviderThreadPayload(input.expected);

      return yield* commitThenPublish(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly payload_json: string }>`
            SELECT payload_json
            FROM orchestration_v2_projection_provider_threads
            WHERE provider_thread_id = ${input.expected.id}
            LIMIT 1
          `;
          if (rows[0]?.payload_json !== expectedJson) {
            return {
              committed: false as const,
              storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
            };
          }

          const normalized = yield* normalizeEvents(input.events);
          const storedEvents = yield* eventStore.append({ events: normalized });
          const outcomes = yield* applyStoredEvents(storedEvents);
          return { committed: true as const, storedEvents, outcomes };
        }),
        (result) =>
          result.committed
            ? publishStoredEvents(result.storedEvents, result.outcomes)
            : Effect.void,
      );
    });

    const existingCommandResult =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (commandId: CommandId) {
        const existing = yield* commandReceipts.getByCommandId(commandId);
        if (Option.isNone(existing)) {
          return yield* Effect.die(
            new Error(`Command receipt ${commandId} disappeared during its transaction.`),
          );
        }
        const storedEvents = yield* eventStore.readByCommandId({ commandId }).pipe(
          Stream.runCollect,
          Effect.map((events): ReadonlyArray<OrchestrationV2StoredEvent> => Array.from(events)),
        );
        return { receipt: existing.value, storedEvents };
      });

    // Derive inference from the planned V2 facts, including internal wake commands.
    const admitCommand = Effect.fn("EventSink.admitCommand")(function* (
      input: Parameters<EventSinkV2Shape["commitCommand"]>[0],
      authorityNow: DateTime.Utc,
      resources?: {
        readonly preparing: boolean;
        readonly candidates: Map<string, RunAdmission.PreparedResourceInstructions>;
      },
    ) {
      const controls: Array<EffectOutbox.PendingOrchestrationEffectV2> = [];
      if (input.retainedOwner !== undefined && resources?.preparing !== true) {
        const retained = yield* runAdmission.check({
          threadId: input.threadId,
          ...(input.retainedOwner === null ? {} : { runId: input.retainedOwner.runId }),
          now: DateTime.formatIso(authorityNow),
          operation: "completion",
          retainedOwner: input.retainedOwner,
        });
        if (retained._tag !== (input.retainedOwner === null ? "ordinary" : "admitted"))
          return yield* new AdmissionDenied({
            reason: "Retained completion owner changed or expired.",
          });
      }
      const origins = new Map<ThreadId, ThreadId>();
      const proposedWorktrees = new Map<ThreadId, string | null>();
      const admittedRuns = new Set<RunId>();
      const admit = Effect.fn("EventSink.admitOperation")(function* (
        facts: Omit<RunAdmission.CommitInput, "commandId" | "now">,
        run?: OrchestrationV2Run,
      ) {
        const resourceKey = `${facts.operation}:${facts.threadId}:${facts.runId ?? ""}`;
        if (resources?.preparing === true) {
          const prepared = yield* (
            runAdmission.prepareResources?.({
              ...facts,
              ...(input.retainedOwner === undefined ? {} : { retainedOwner: input.retainedOwner }),
              commandId: input.commandId,
              now: DateTime.formatIso(authorityNow),
            }) ?? Effect.succeed(undefined)
          );
          if (prepared !== undefined) resources.candidates.set(resourceKey, prepared);
          return;
        }
        const preparedResources = resources?.candidates.get(resourceKey);
        const result = yield* runAdmission.commit({
          ...facts,
          ...(input.retainedOwner === undefined ? {} : { retainedOwner: input.retainedOwner }),
          ...(preparedResources === undefined ? {} : { preparedResources }),
          commandId: input.commandId,
          now: DateTime.formatIso(authorityNow),
        });
        if (result._tag === "denied" || result._tag === "expired") {
          return yield* new AdmissionDenied({
            reason: result._tag === "denied" ? result.reason : "Run owner deadline expired.",
          });
        }
        if (result._tag !== "admitted") return;
        if (
          run !== undefined &&
          (result.owner.configuration.providerInstanceId !== run.providerInstanceId ||
            result.owner.configuration.model !== run.modelSelection.model ||
            !modelSelectionsEqual(
              { ...run.modelSelection, options: result.owner.configuration.options ?? [] },
              run.modelSelection,
            ))
        ) {
          return yield* new AdmissionDenied({
            reason: "Run configuration differs from its retained owner configuration.",
          });
        }
        if (result.control !== undefined) {
          controls.push({
            id: result.control.controlId,
            commandId: input.commandId,
            threadId: result.control.controlThreadId,
            availableAt: DateTime.makeUnsafe(result.control.expiresAt),
            request: { type: "owner-deadline.expire", control: result.control },
          });
        }
      });
      for (const event of input.events) {
        if (event.type !== "thread.created") continue;
        const origin = event.payload.lineage.parentThreadId;
        proposedWorktrees.set(event.threadId, event.payload.worktreePath);
        if (origin !== null) origins.set(event.threadId, origin);
        yield* admit({
          operation: "bind-thread",
          threadId: event.threadId,
          projectId: event.payload.projectId,
          proposedWorktreePath: event.payload.worktreePath,
          ...(origin === null ? {} : { originThreadId: origin }),
        });
      }
      for (const event of input.events) {
        if (event.type !== "run.created" && event.type !== "run.updated") continue;
        const run = event.payload;
        const current =
          event.type === "run.created"
            ? undefined
            : (yield* projectionStore.getThreadRecords(event.threadId, ["runs"], {
                runIds: [run.id],
              })).runs[0];
        const operation =
          event.type === "run.created"
            ? "create"
            : run.status === "starting" && current?.activeAttemptId !== run.activeAttemptId
              ? "restart"
              : run.status === "starting" && current?.status !== "starting"
                ? "promote"
                : undefined;
        if (operation === undefined || admittedRuns.has(run.id)) continue;
        admittedRuns.add(run.id);
        const originThreadId = origins.get(event.threadId);
        const proposedWorktreePath = proposedWorktrees.get(event.threadId);
        yield* admit(
          {
            operation,
            threadId: event.threadId,
            ...(proposedWorktreePath === undefined ? {} : { proposedWorktreePath }),
            runId: run.id,
            ...(run.activeAttemptId === null ? {} : { runAttemptId: run.activeAttemptId }),
            queued: run.status === "queued" || run.status === "preparing",
            ...(originThreadId === undefined ? {} : { originThreadId }),
          },
          run,
        );
      }
      for (const effect of input.effects) {
        if (
          effect.request.type === "provider-turn.steer" ||
          (effect.request.type === "runtime-request.respond" &&
            effect.request.decision !== "cancel" &&
            effect.request.decision !== "decline")
        ) {
          let runId: RunId | undefined;
          let runAttemptId: RunAttemptId | undefined;
          if (effect.request.type === "provider-turn.steer") {
            const target = yield* projectionStore.getProviderControlContext(
              effect.threadId,
              effect.request,
            );
            runId = target.run?.id;
            runAttemptId = target.providerTurn?.runAttemptId ?? undefined;
          } else {
            const target = yield* projectionStore.getRuntimeResponseContext(
              effect.threadId,
              effect.request.requestId,
            );
            runId = target.node?.runId ?? undefined;
            if (target.request?.providerTurnId != null) {
              const { providerTurns } = yield* projectionStore.getThreadRecords(effect.threadId, [
                "providerTurns",
              ]);
              runAttemptId =
                providerTurns.find((turn) => turn.id === target.request?.providerTurnId)
                  ?.runAttemptId ?? undefined;
            }
          }
          yield* admit({
            threadId: effect.threadId,
            operation: effect.request.type === "provider-turn.steer" ? "steer" : "runtime-answer",
            ...(runId === undefined ? {} : { runId }),
            ...(runAttemptId === undefined ? {} : { runAttemptId }),
          });
        }
      }
      return controls;
    });

    const commitCommandEffect = Effect.fn("orchestrationV2.EventSink.commitCommand")(function* (
      input: Parameters<EventSinkV2Shape["commitCommand"]>[0],
    ) {
      const resourceCandidates = new Map<string, RunAdmission.PreparedResourceInstructions>();
      if (
        runAdmission.prepareResources !== undefined &&
        Option.isNone(yield* commandReceipts.getByCommandId(input.commandId)) &&
        input.events.some(
          (event) =>
            event.type === "thread.created" ||
            event.type === "run.created" ||
            (event.type === "run.updated" && event.payload.status === "starting"),
        )
      )
        yield* admitCommand(input, yield* DateTime.now, {
          preparing: true,
          candidates: resourceCandidates,
        });
      const result = yield* commitThenPublish(
        Effect.gen(function* () {
          const reserved = yield* commandReceipts.insertIfAbsent({
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.acceptedAt,
            resultSequence: 0,
            status: "accepted",
            error: null,
          });
          if (!reserved) {
            const existing = yield* existingCommandResult(input.commandId);
            return { ...existing, committed: false as const, cancelledEffectIds: [] };
          }

          const authorityNow = yield* DateTime.now;
          if (input.exactRunStop !== undefined) {
            const expected = input.exactRunStop;
            const projection = yield* projectionStore.getThreadRecords(
              input.threadId,
              ["runs", "providerThreads"],
              { runIds: [expected.runId] },
            );
            const run = projection.runs.find((candidate) => candidate.id === expected.runId);
            const providerThread = projection.providerThreads.find(
              (candidate) => candidate.id === expected.providerThreadId,
            );
            if (
              run?.activeAttemptId !== expected.runAttemptId ||
              run.rootNodeId !== expected.rootNodeId ||
              run.providerThreadId !== expected.providerThreadId ||
              providerThread?.providerSessionId !== expected.providerSessionId ||
              providerThread.ownerNodeId !== expected.rootNodeId
            ) {
              const receipt: CommandReceiptStore.CommandReceiptV2 = {
                commandId: input.commandId,
                threadId: input.threadId,
                commandType: input.commandType,
                acceptedAt: input.acceptedAt,
                resultSequence: yield* eventStore.latestSequence({ threadId: input.threadId }),
                status: "rejected",
                error: "Native continuation target is stale.",
              };
              yield* commandReceipts.upsert(receipt);
              return {
                receipt,
                storedEvents: [],
                committed: true as const,
                cancelledEffectIds: [],
              };
            }
          }
          if (
            input.ownerDeadline !== undefined &&
            !(yield* runAdmission.validateDeadlineStop({
              ...input.ownerDeadline,
              now: DateTime.formatIso(authorityNow),
            }))
          ) {
            const receipt: CommandReceiptStore.CommandReceiptV2 = {
              commandId: input.commandId,
              threadId: input.threadId,
              commandType: input.commandType,
              acceptedAt: input.acceptedAt,
              resultSequence: yield* eventStore.latestSequence({ threadId: input.threadId }),
              status: "rejected",
              error: "Owner deadline target is stale.",
            };
            yield* commandReceipts.upsert(receipt);
            return { receipt, storedEvents: [], committed: true as const, cancelledEffectIds: [] };
          }
          // The savepoint rolls back earlier bindings if a later child/run is denied,
          // while the outer transaction retains the rejected command receipt.
          const admission = yield* sql
            .withTransaction(
              admitCommand(input, authorityNow, {
                preparing: false,
                candidates: resourceCandidates,
              }),
            )
            .pipe(
              Effect.map((controls) => ({ _tag: "accepted" as const, controls })),
              Effect.catchTags({
                AdmissionDenied: (denial) =>
                  Effect.succeed({ _tag: "rejected" as const, reason: denial.reason }),
              }),
            );
          if (admission._tag === "rejected") {
            const receipt: CommandReceiptStore.CommandReceiptV2 = {
              commandId: input.commandId,
              threadId: input.threadId,
              commandType: input.commandType,
              acceptedAt: input.acceptedAt,
              resultSequence: yield* eventStore.latestSequence({ threadId: input.threadId }),
              status: "rejected",
              error: admission.reason,
            };
            yield* commandReceipts.upsert(receipt);
            return { receipt, storedEvents: [], committed: true as const, cancelledEffectIds: [] };
          }
          yield* runAdmission.guardEvents?.(input) ?? Effect.void;
          yield* validateHistoryArchiveCommit().pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          const normalized = yield* normalizeEvents(input.events);
          const storedEvents = yield* eventStore.append({
            commandId: input.commandId,
            events: normalized,
          });
          const sequence = storedEvents.at(-1)?.sequence;
          if (sequence === undefined) {
            return yield* Effect.die(
              new Error(`Command ${input.commandId} produced no orchestration events.`),
            );
          }
          const outcomes = yield* applyStoredEvents(storedEvents);
          yield* effectOutbox.enqueue([...input.effects, ...admission.controls]);
          const receipt: CommandReceiptStore.CommandReceiptV2 = {
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.acceptedAt,
            resultSequence: sequence,
            status: "accepted",
            error: null,
          };
          yield* commandReceipts.upsert(receipt);
          const cancelledEffectIds =
            input.cancelUnsettledEffects === undefined
              ? []
              : yield* effectOutbox.cancelUnsettled({
                  threadId: input.threadId,
                  ...input.cancelUnsettledEffects,
                });
          return { receipt, storedEvents, outcomes, committed: true as const, cancelledEffectIds };
        }),
        (result) =>
          Effect.gen(function* () {
            yield* effectOutbox.signalCancellations(result.cancelledEffectIds);
            if (result.committed && result.receipt.status === "accepted") {
              yield* effectOutbox.notifyAvailable(Math.max(1, input.effects.length));
            }
            if (result.committed) {
              yield* runAdmission.publishCommitted(input.commandId);
              yield* publishStoredEvents(result.storedEvents, result.outcomes ?? []);
            }
          }),
      );
      return {
        receipt: result.receipt,
        storedEvents: result.storedEvents,
        committed: result.committed,
        cancelledEffectCount: result.cancelledEffectIds.length,
      };
    });

    const commitRejectedCommandEffect = Effect.fn(
      "orchestrationV2.EventSink.commitRejectedCommand",
    )(function* (input: Parameters<EventSinkV2Shape["commitRejectedCommand"]>[0]) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const sequence = yield* eventStore.latestSequence({ threadId: input.threadId });
          const receipt: CommandReceiptStore.CommandReceiptV2 = {
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.rejectedAt,
            resultSequence: sequence,
            status: "rejected",
            error: input.error,
          };
          const inserted = yield* commandReceipts.insertIfAbsent(receipt);
          if (inserted) {
            return receipt;
          }
          const existing = yield* commandReceipts.getByCommandId(input.commandId);
          return Option.getOrElse(existing, () => receipt);
        }),
      );
    });

    const existingProjectReceipt = (commandId: CommandId) =>
      commandReceipts.getProjectByCommandId(commandId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(`Command ${commandId} was already used by a thread command.` as const),
            onSome: Effect.succeed,
          }),
        ),
      );

    const commitProjectCommandEffect = Effect.fn("orchestrationV2.EventSink.commitProjectCommand")(
      function* (input: Parameters<EventSinkV2Shape["commitProjectCommand"]>[0]) {
        const result = yield* commitThenPublish(
          Effect.gen(function* () {
            const reserved: CommandReceiptStore.ProjectCommandReceiptV2 = {
              commandId: input.commandId,
              projectId: input.projectId,
              commandType: input.commandType,
              acceptedAt: input.acceptedAt,
              resultSequence: 0,
              status: "accepted",
              error: null,
            };
            if (!(yield* commandReceipts.insertIfAbsent(reserved))) {
              return { receipt: yield* existingProjectReceipt(input.commandId), event: undefined };
            }
            yield* runAdmission.guardProject?.(input) ?? Effect.void;
            const event = yield* eventStore.appendProjectEvent(input.event);
            yield* projectStore.apply(event);
            const receipt = { ...reserved, resultSequence: event.sequence };
            yield* commandReceipts.upsert(receipt);
            return { receipt, event };
          }),
          (result) =>
            result.event === undefined ? Effect.void : eventStore.publishCommitted([result.event]),
        );
        return { receipt: result.receipt, committed: result.event !== undefined };
      },
    );

    const commitRejectedProjectCommandEffect = Effect.fn(
      "orchestrationV2.EventSink.commitRejectedProjectCommand",
    )(function* (input: Parameters<EventSinkV2Shape["commitRejectedProjectCommand"]>[0]) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const receipt: CommandReceiptStore.ProjectCommandReceiptV2 = {
            commandId: input.commandId,
            projectId: input.projectId,
            commandType: input.commandType,
            acceptedAt: input.rejectedAt,
            resultSequence: yield* eventStore.latestApplicationSequence,
            status: "rejected",
            error: input.error,
          };
          return (yield* commandReceipts.insertIfAbsent(receipt))
            ? receipt
            : yield* existingProjectReceipt(input.commandId);
        }),
      );
    });

    const catchUp = (input: {
      readonly afterSequence: number;
      readonly throughSequence: number;
      readonly threadId?: ThreadId;
      readonly eventType?: OrchestrationV2DomainEvent["type"];
    }): Stream.Stream<OrchestrationV2StoredEvent, unknown> => {
      const pageSize = 256;
      const loop = (afterSequence: number): Stream.Stream<OrchestrationV2StoredEvent, unknown> =>
        Stream.unwrap(
          eventStore
            .read({
              afterSequence,
              throughSequence: input.throughSequence,
              ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
              ...(input.eventType === undefined ? {} : { eventType: input.eventType }),
              limit: pageSize,
            })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.map((events) => {
                if (events.length === 0) {
                  return Stream.empty;
                }
                const current = Stream.fromIterable(events);
                const last = events.at(-1)?.sequence ?? input.throughSequence;
                return events.length < pageSize || last >= input.throughSequence
                  ? current
                  : Stream.concat(current, loop(last));
              }),
            ),
        );
      return loop(input.afterSequence);
    };

    const stream = (input?: Parameters<EventSinkV2Shape["stream"]>[0]) => {
      const afterSequence = input?.afterSequence ?? 0;
      const matches = (stored: OrchestrationV2StoredEvent) =>
        (input?.threadId === undefined || stored.event.threadId === input.threadId) &&
        (input?.eventType === undefined || stored.event.type === input.eventType);
      const replay = (throughSequence: number) =>
        catchUp({
          afterSequence,
          throughSequence,
          ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
          ...(input?.eventType === undefined ? {} : { eventType: input.eventType }),
        }).pipe(Stream.filter(matches));
      return Stream.unwrap(
        Effect.gen(function* () {
          let pubsub = liveEvents;
          if (input?.eventType !== undefined) {
            const existing = liveEventsByType.get(input.eventType);
            if (existing !== undefined) {
              pubsub = existing;
            } else {
              const created = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
              pubsub = liveEventsByType.get(input.eventType) ?? created;
              liveEventsByType.set(input.eventType, pubsub);
            }
          }
          if (input?.bounded === true) {
            return replayAndBufferProjectedLiveEvents({
              subscribe: PubSub.subscribe(pubsub),
              latestSequence: eventStore.latestSequence(),
              afterSequence,
              filter: matches,
              replay,
              project: (stored) => ({ ...stored, event: projectDomainEventForWire(stored.event) }),
            });
          }
          const subscription = yield* PubSub.subscribe(pubsub);
          const highWater = yield* eventStore.latestSequence();
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.filter((stored) => stored.sequence > Math.max(highWater, afterSequence)),
            Stream.filter(matches),
          );
          return Stream.concat(replay(highWater), live);
        }),
      );
    };

    return EventSinkV2.of({
      write: (input) =>
        writeEffect({ ...input, effects: [] }).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeWithEffects: (input) =>
        writeEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfRunCurrent: (input) =>
        writeIfRunCurrentEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfProviderThreadOwner: (input) =>
        writeIfProviderThreadOwnerEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfProviderThreadUnchanged: (input) =>
        writeIfProviderThreadUnchangedEffect(input).pipe(
          Effect.mapError(
            (cause) => new EventSinkWriteError({ eventCount: input.events.length, cause }),
          ),
        ),
      commitCommand: (input) =>
        commitCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
                cause,
              }),
          ),
        ),
      commitRejectedCommand: (input) =>
        commitRejectedCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: 0,
                cause,
              }),
          ),
        ),
      assertProjectCommand: (input) =>
        (runAdmission.guardProject?.(input) ?? Effect.void).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({ eventCount: 0, commandId: input.commandId, cause }),
          ),
        ),
      commitProjectCommand: (input) =>
        commitProjectCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({ commandId: input.commandId, eventCount: 1, cause }),
          ),
        ),
      commitRejectedProjectCommand: (input) =>
        commitRejectedProjectCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({ commandId: input.commandId, eventCount: 0, cause }),
          ),
        ),
      stream: (input) =>
        stream(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input?.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                cause,
              }),
          ),
        ),
      latestSequence: (input) =>
        eventStore.latestSequence(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                cause,
              }),
          ),
        ),
      readByCommandId: (input) =>
        eventStore.readByCommandId(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                cause,
              }),
          ),
        ),
    } satisfies EventSinkV2Shape);
  }),
);

/**
 * Keeping the outbox instance shared with the worker is important because enqueue notifications
 * are in-memory wakeups backed by the durable SQL queue.
 */
export const layerWithAdmission = layerBase;
export const layerFromStores = layerBase.pipe(Layer.provide(RunAdmission.layerOrdinary));

export const layer: Layer.Layer<
  EventSinkV2,
  never,
  EventStore.EventStoreV2 | ProjectionStore.ProjectionStoreV2 | SqlClient.SqlClient
> = layerFromStores.pipe(
  Layer.provide(
    Layer.mergeAll(
      CommandReceiptStore.layer,
      EffectOutbox.layer,
      ProjectStore.layer,
      TurnItemPositionStore.layer,
    ),
  ),
);
