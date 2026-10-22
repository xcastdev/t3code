import {
  OrchestrationV2InstructionSnapshot,
  type OrchestrationV2ProviderCapabilities,
  type ProviderSessionId,
  type ProviderThreadId,
  type RunAttemptId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { sameInstructionSnapshot } from "@t3tools/provider-core/server/instructionSnapshot";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SkillCatalogService } from "../skills/SkillCatalogService.ts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";

export function instructionDeliveryDecision(input: {
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly previousSnapshot: OrchestrationV2InstructionSnapshot | undefined;
  readonly requestedSnapshot: OrchestrationV2InstructionSnapshot | undefined;
  readonly sessionHasOtherThreads: boolean;
}): "unchanged" | "per-turn" | "replace" | "blocked" {
  if (sameInstructionSnapshot(input.previousSnapshot, input.requestedSnapshot)) return "unchanged";
  const delivery = input.capabilities.instructionDelivery;
  if (delivery?.mode === "turn") return "per-turn";
  if (
    delivery?.mode !== "session" ||
    !delivery.supportsSessionReplacement ||
    input.sessionHasOtherThreads
  )
    return "blocked";
  return "replace";
}

export interface InstructionTarget {
  readonly runtimeId?: string;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly runAttemptId: RunAttemptId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly runOrdinal: number;
  readonly snapshot: OrchestrationV2InstructionSnapshot;
}

export class InstructionDeliveryError extends Schema.TaggedError<InstructionDeliveryError>()(
  "InstructionDeliveryError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Provider instruction delivery could not be recorded.";
  }
}

export class InstructionDelivery extends Context.Service<
  InstructionDelivery,
  {
    readonly prepare: (input: InstructionTarget) => Effect.Effect<void, InstructionDeliveryError>;
    readonly recordApplied: (
      input: InstructionTarget,
      applied: OrchestrationV2InstructionSnapshot,
    ) => Effect.Effect<void, InstructionDeliveryError>;
    readonly query: (input: { readonly runAttemptId: RunAttemptId }) => Effect.Effect<
      | {
          readonly state: "pending" | "applied" | "blocked";
          readonly requested: OrchestrationV2InstructionSnapshot;
          readonly applied: OrchestrationV2InstructionSnapshot | undefined;
        }
      | undefined,
      InstructionDeliveryError
    >;
  }
>()("t3/orchestration-v2/InstructionDelivery") {}

const isInstructionDeliveryError = Schema.is(InstructionDeliveryError);

const snapshotJson = Schema.fromJsonString(OrchestrationV2InstructionSnapshot);
const encodeSnapshot = Schema.encodeEffect(snapshotJson);
const decodeSnapshot = Schema.decodeUnknownEffect(snapshotJson);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const skills = yield* Effect.serviceOption(SkillCatalogService);
  const eventSink = yield* EventSink.EventSinkV2;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const prepare = Effect.fn("InstructionDelivery.prepare")(
    function* (input: InstructionTarget) {
      const encoded = yield* encodeSnapshot(input.snapshot);
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`INSERT INTO t3_workflow_v2_instruction_deliveries
      (run_attempt_id,thread_id,run_id,provider_thread_id,provider_session_id,run_ordinal,requested_snapshot_json,state,created_at)
      VALUES (${input.runAttemptId},${input.threadId},${input.runId},${input.providerThreadId},${input.providerSessionId},${input.runOrdinal},${encoded},'pending',${now})
      ON CONFLICT(run_attempt_id) DO NOTHING`;
      const rows = yield* sql<{
        requested_snapshot_json: string;
        provider_thread_id: string;
        provider_session_id: string;
        run_id: string;
        thread_id: string;
      }>`SELECT * FROM t3_workflow_v2_instruction_deliveries WHERE run_attempt_id=${input.runAttemptId}`;
      const row = rows[0];
      if (
        row === undefined ||
        row.thread_id !== input.threadId ||
        row.run_id !== input.runId ||
        row.provider_thread_id !== input.providerThreadId ||
        row.provider_session_id !== input.providerSessionId ||
        !sameInstructionSnapshot(yield* decodeSnapshot(row.requested_snapshot_json), input.snapshot)
      ) {
        return yield* new InstructionDeliveryError({ cause: "Instruction target changed." });
      }
      if (Option.isSome(skills)) {
        const projection = yield* projectionStore.getThreadRecords(input.threadId, ["runs"], {
          runIds: [input.runId],
        });
        const run = projection.runs.find((candidate) => candidate.id === input.runId);
        if (run !== undefined)
          yield* skills.value.notifyApplicationChanged({
            threadId: input.threadId,
            providerInstanceId: run.providerInstanceId,
          });
      }
    },
    Effect.mapError((cause) =>
      isInstructionDeliveryError(cause) ? cause : new InstructionDeliveryError({ cause }),
    ),
  );
  const recordApplied = Effect.fn("InstructionDelivery.recordApplied")(
    function* (input: InstructionTarget, applied: OrchestrationV2InstructionSnapshot) {
      if (!sameInstructionSnapshot(input.snapshot, applied)) return;
      const projection = yield* projectionStore.getThreadRecords(input.threadId, [
        "runs",
        "providerSessions",
        "providerThreads",
      ]);
      const run = projection.runs.find((candidate) => candidate.id === input.runId);
      const session = projection.providerSessions.find(
        (candidate) => candidate.id === input.providerSessionId,
      );
      if (run === undefined) return;
      const now = yield* DateTime.now;
      const effectiveInstructions = {
        configurationHash: applied.configurationHash,
        resourceRevision: applied.resourceRevision,
        memoryEpoch: applied.memoryEpoch,
      };
      const committed = yield* eventSink.writeWithEffects({
        instructionReceipt: {
          ...input,
          snapshotJson: yield* encodeSnapshot(applied),
          appliedAt: DateTime.formatIso(now),
        },
        effects: [],
        events: [
          {
            id: yield* ids.allocate.event({ threadId: input.threadId }),
            type: "run.updated",
            threadId: input.threadId,
            runId: input.runId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...run, effectiveInstructions },
          },
          ...(session === undefined
            ? []
            : [
                {
                  id: yield* ids.allocate.event({ threadId: input.threadId }),
                  type: "provider-session.updated" as const,
                  threadId: input.threadId,
                  runId: input.runId,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: now,
                  payload: { ...session, effectiveInstructions },
                },
              ]),
        ],
      });
      if (committed.length > 0 && Option.isSome(skills))
        yield* skills.value.notifyApplicationChanged({
          threadId: input.threadId,
          providerInstanceId: run.providerInstanceId,
        });
    },
    Effect.mapError((cause) => new InstructionDeliveryError({ cause })),
  );
  const query = Effect.fn("InstructionDelivery.query")(
    function* (input: { readonly runAttemptId: RunAttemptId }) {
      const rows = yield* sql<{
        state: "pending" | "applied" | "blocked";
        requested_snapshot_json: string;
        applied_snapshot_json: string | null;
      }>`SELECT state,requested_snapshot_json,applied_snapshot_json FROM t3_workflow_v2_instruction_deliveries WHERE run_attempt_id=${input.runAttemptId}`;
      const row = rows[0];
      return row === undefined
        ? undefined
        : {
            state: row.state,
            requested: yield* decodeSnapshot(row.requested_snapshot_json),
            applied:
              row.applied_snapshot_json === null
                ? undefined
                : yield* decodeSnapshot(row.applied_snapshot_json),
          };
    },
    Effect.mapError((cause) => new InstructionDeliveryError({ cause })),
  );
  return InstructionDelivery.of({ prepare, recordApplied, query });
});
export const layer = Layer.effect(InstructionDelivery, make);
