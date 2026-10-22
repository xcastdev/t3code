import type {
  AssistantId,
  EnvironmentId,
  OrchestrationV2TurnItem,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { AssistantRepository, type AssistantRecord } from "../assistants/AssistantRepository.ts";
import { ContextHandoffEpoch } from "./ContextHandoffEpoch.ts";

export class AssistantArchiveRecoveryError extends Schema.TaggedError<AssistantArchiveRecoveryError>()(
  "AssistantArchiveRecoveryError",
  {
    reason: Schema.Literals(["forbidden", "stale", "unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
export interface AssistantArchiveRecoveryStamp {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly assistantId: AssistantId;
  readonly ownerRevision: number;
  readonly configurationRevision: number;
  readonly memoryEpoch: number;
  readonly memoryContextHash: string;
}
export class ThreadHistoryRecoveryAssistantPolicy extends Context.Service<
  ThreadHistoryRecoveryAssistantPolicy,
  {
    readonly capture: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly archiveId: string;
      readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
    }) => Effect.Effect<
      {
        readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
        readonly omittedItems: number;
        readonly stamp: AssistantArchiveRecoveryStamp;
      },
      AssistantArchiveRecoveryError
    >;
    readonly assertCurrent: (
      stamp: AssistantArchiveRecoveryStamp,
    ) => Effect.Effect<void, AssistantArchiveRecoveryError>;
  }
>()("t3/orchestration-v2/ThreadHistoryRecoveryAssistantPolicy") {}
const isPolicyError = Schema.is(AssistantArchiveRecoveryError);
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* AssistantRepository;
  const policy = yield* ContextHandoffEpoch;
  const canonical = Effect.fn("AssistantArchiveRecovery.canonical")(function* (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
  }) {
    const record = yield* repository.findByThread(input.threadId);
    if (record === null) return yield* new AssistantArchiveRecoveryError({ reason: "forbidden" });
    const summary = record.detail.summary;
    if (
      summary.binding.canonicalThreadId !== input.threadId ||
      summary.binding.backingProjectId !== input.projectId ||
      summary.lifecycle !== "active" ||
      summary.provisioningState !== "ready"
    )
      return yield* new AssistantArchiveRecoveryError({ reason: "forbidden" });
    return record;
  });
  const stampFor = (
    record: AssistantRecord,
    current: { readonly memoryEpoch: number; readonly memoryContextHash: string },
  ): AssistantArchiveRecoveryStamp => ({
    threadId: record.detail.summary.binding.canonicalThreadId,
    projectId: record.detail.summary.binding.backingProjectId,
    environmentId: record.detail.summary.environmentId,
    assistantId: record.detail.summary.assistantId,
    ownerRevision: record.ownerRevision,
    configurationRevision: record.detail.configuration.revision,
    ...current,
  });
  const protect = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isPolicyError(cause)
          ? cause
          : new AssistantArchiveRecoveryError({ reason: "unavailable", cause }),
      ),
    );
  return ThreadHistoryRecoveryAssistantPolicy.of({
    capture: Effect.fn("AssistantArchiveRecovery.capture")((input) =>
      protect(
        sql.withTransaction(
          Effect.gen(function* () {
            const record = yield* canonical(input);
            const summary = record.detail.summary;
            const known: OrchestrationV2TurnItem[] = [];
            const candidateRuns = [
              ...new Set(input.items.flatMap((item) => (item.runId === null ? [] : [item.runId]))),
            ];
            // SQL classifies complete immutable prompt metadata; only the bounded candidate runs leave SQL.
            const provenance = yield* sql<{ run_id: string; verified: number }>`
              SELECT r.run_id,min(CASE WHEN EXISTS (
                SELECT 1 FROM t3_workflow_v2_assistant_memory_receipts m
                WHERE m.environment_id=${summary.environmentId} AND m.assistant_id=${summary.assistantId}
                  AND m.message_id=r.message_id
              ) THEN 1 ELSE 0 END) AS verified
              FROM t3_workflow_v2_history_archive_rows r
              WHERE r.archive_id=${input.archiveId} AND r.kind='turn_items' AND r.fragment=0
                AND r.item_type='user_message' AND ${sql.in("r.run_id", candidateRuns)}
              GROUP BY r.run_id
            `;
            const verifiedRuns = new Set(
              provenance.filter((row) => row.verified === 1).map((row) => row.run_id),
            );
            for (const item of input.items) {
              if (item.type !== "user_message") continue;
              const receipt =
                yield* sql`SELECT 1 FROM t3_workflow_v2_assistant_memory_receipts WHERE environment_id=${summary.environmentId} AND assistant_id=${summary.assistantId} AND message_id=${item.messageId} LIMIT 1`;
              if (receipt.length) known.push(item);
            }
            for (const item of input.items) {
              if (
                item.type === "user_message" ||
                item.runId === null ||
                !verifiedRuns.has(item.runId)
              )
                continue;
              const admission =
                yield* sql`SELECT 1 FROM t3_workflow_v2_assistant_admissions WHERE thread_id=${input.threadId} AND assistant_id=${summary.assistantId} AND run_id=${item.runId} AND json_type(configuration_json,'$.snapshot.memoryEpoch')='integer' AND json_type(configuration_json,'$.snapshot.memoryContextHash')='text' LIMIT 1`;
              if (admission.length) known.push(item);
            }
            const selected = new Set(known.map((item) => item.id));
            const filtered = yield* policy.capture({
              threadId: input.threadId,
              items: input.items.filter((item) => selected.has(item.id)),
            });
            if (filtered.memoryEpoch === undefined || filtered.memoryContextHash === undefined)
              return yield* new AssistantArchiveRecoveryError({ reason: "unavailable" });
            return {
              items: filtered.items,
              omittedItems: input.items.length - filtered.items.length,
              stamp: stampFor(record, {
                memoryEpoch: filtered.memoryEpoch,
                memoryContextHash: filtered.memoryContextHash,
              }),
            };
          }),
        ),
      ),
    ),
    // This adapter composes the SQL-only current history policy; no provider, model, or file work runs at commit.
    assertCurrent: Effect.fn("AssistantArchiveRecovery.assertCurrent")((stamp) =>
      protect(
        Effect.gen(function* () {
          const record = yield* canonical(stamp);
          const current = yield* policy.current(stamp.threadId);
          if (
            current === undefined ||
            record.detail.summary.environmentId !== stamp.environmentId ||
            record.detail.summary.assistantId !== stamp.assistantId ||
            record.ownerRevision !== stamp.ownerRevision ||
            record.detail.configuration.revision !== stamp.configurationRevision ||
            current.memoryEpoch !== stamp.memoryEpoch ||
            current.memoryContextHash !== stamp.memoryContextHash
          )
            return yield* new AssistantArchiveRecoveryError({ reason: "stale" });
        }),
      ),
    ),
  });
});
export const layer = Layer.effect(ThreadHistoryRecoveryAssistantPolicy, make);
