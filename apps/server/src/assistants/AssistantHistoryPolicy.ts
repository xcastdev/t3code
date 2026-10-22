import { readRetainedMemoryFacts } from "../projectWork/memory/ProjectMemoryRetainedFacts.ts";
import {
  ProjectMemorySource,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { AssistantRepository } from "./AssistantRepository.ts";
import { AssistantError } from "./AssistantRepository.ts";
import { assistantMemoryContextHash } from "./AssistantResources.ts";
import { makeAssistantMemoryContext } from "./AssistantMemory.ts";
import { ProjectMemoryService } from "../projectWork/memory/ProjectMemoryService.ts";
import { ProjectMemoryFactPolicy } from "../projectWork/memory/ProjectMemoryFactPolicy.ts";
import { memoryHash, sourceTuple } from "../projectWork/memory/ProjectMemoryRepository.ts";
const decodeSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      snapshot: Schema.Struct({
        memoryEpoch: Schema.Number,
        memoryContextHash: Schema.optional(Schema.String),
      }),
    }),
  ),
);
const decodeSource = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectMemorySource));
const emptyMemoryHash = assistantMemoryContextHash("");

export const makeAssistantHistoryPolicy = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* AssistantRepository;
  const memory = yield* ProjectMemoryService;
  const factPolicy = yield* ProjectMemoryFactPolicy;
  const context = yield* makeAssistantMemoryContext;
  return Effect.fn("AssistantHistoryPolicy.capture")(
    function* (input: { threadId: ThreadId; items: ReadonlyArray<OrchestrationV2TurnItem> }) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const record = yield* repository.findByThread(input.threadId);
          if (record === null) return { items: input.items, omittedItems: 0 };
          const current = yield* context(record);
          const stamp = {
            memoryEpoch: current.memoryEpoch,
            memoryContextHash: assistantMemoryContextHash(current.text),
          };
          const scope = {
            environmentId: record.detail.summary.environmentId,
            owner: { kind: "assistant" as const, assistantId: record.detail.summary.assistantId },
            ownerRevision: record.ownerRevision,
          };
          let changed =
            (yield* sql`SELECT 1 FROM t3_workflow_v2_memory_sources s WHERE s.environment_id=${scope.environmentId} AND ((s.owner_kind='assistant' AND s.owner_id=${scope.owner.assistantId}) OR EXISTS(SELECT 1 FROM t3_workflow_v2_memory_grants g WHERE g.environment_id=s.environment_id AND g.owner_kind=s.owner_kind AND g.owner_id=s.owner_id AND g.source_id=s.source_id AND g.recipient_kind='assistant' AND g.recipient_id=${scope.owner.assistantId})) AND s.status<>'current' LIMIT 1`)
              .length > 0 ||
            (yield* sql`SELECT 1 FROM t3_workflow_v2_memory_grants WHERE environment_id=${scope.environmentId} AND recipient_kind='assistant' AND recipient_id=${scope.owner.assistantId} AND revoked_at IS NOT NULL LIMIT 1`)
              .length > 0;
          const items = input.items.slice(-512);
          const kept: OrchestrationV2TurnItem[] = [];
          const snapshots = new Map<
            string,
            { memoryEpoch: number; memoryContextHash?: string | undefined } | null
          >();
          const allowedUsers = new Set<string>();
          const blockedRuns = new Set<string>();
          for (const item of items) {
            if (item.type !== "user_message") continue;
            if (item.type === "user_message") {
              const receipt = (yield* sql<{
                source_json: string;
              }>`SELECT source_json FROM t3_workflow_v2_assistant_memory_receipts WHERE environment_id=${scope.environmentId} AND assistant_id=${scope.owner.assistantId} AND message_id=${item.messageId} ORDER BY revision DESC LIMIT 1`)[0];
              if (receipt === undefined) {
                const message = (yield* sql<{
                  created_by: string | null;
                }>`SELECT json_extract(payload_json,'$.createdBy') AS created_by FROM orchestration_v2_projection_messages WHERE thread_id=${input.threadId} AND message_id=${item.messageId}`)[0];
                if (message?.created_by === "user") allowedUsers.add(item.id);
                continue;
              }
              const source = yield* decodeSource(receipt.source_json);
              const tuple = sourceTuple(scope, source);
              const valid = yield* memory.readSource(tuple);
              if (valid === undefined || memoryHash(item.text) !== valid.contentHash) {
                changed = true;
                if (item.runId !== null) blockedRuns.add(item.runId);
                continue;
              }
              if (changed) {
                const facts = yield* readRetainedMemoryFacts(tuple).pipe(
                  Effect.provideService(SqlClient.SqlClient, sql),
                );
                const allowed =
                  facts === undefined
                    ? factPolicy.allowRecall === undefined
                      ? false
                      : yield* factPolicy.allowRecall(tuple)
                    : (yield* factPolicy.filter(tuple, facts)).length === facts.length;
                if (!allowed) {
                  if (item.runId !== null) blockedRuns.add(item.runId);
                  continue;
                }
              }
              allowedUsers.add(item.id);
              continue;
            }
          }
          for (const item of items) {
            if (item.type === "user_message") {
              if (allowedUsers.has(item.id)) {
                kept.push(item);
                continue;
              }
              const receipt =
                (yield* sql`SELECT 1 FROM t3_workflow_v2_assistant_memory_receipts WHERE environment_id=${scope.environmentId} AND assistant_id=${scope.owner.assistantId} AND message_id=${item.messageId} LIMIT 1`)[0];
              if (receipt !== undefined) continue;
              // Server and agent authored user-role messages are derived continuity, not fresh human intent.
              if (item.runId === null) continue;
            }
            if (item.runId !== null && blockedRuns.has(item.runId)) continue;
            // Shared source authority can change without mutating this assistant's memory rows.
            if (item.runId !== null) {
              if (!snapshots.has(item.runId)) {
                const row = (yield* sql<{
                  configuration_json: string;
                }>`SELECT configuration_json FROM t3_workflow_v2_assistant_admissions WHERE thread_id=${input.threadId} AND run_id=${item.runId} AND assistant_id=${scope.owner.assistantId}`)[0];
                const decoded =
                  row === undefined ? null : yield* decodeSnapshot(row.configuration_json);
                snapshots.set(item.runId, decoded?.snapshot ?? null);
              }
              const snapshot = snapshots.get(item.runId);
              if (
                (item.type === "user_message" && snapshot == null) ||
                (changed &&
                  (snapshot?.memoryEpoch !== stamp.memoryEpoch ||
                    snapshot.memoryContextHash !== stamp.memoryContextHash)) ||
                (snapshot?.memoryContextHash !== undefined &&
                  snapshot.memoryContextHash !== emptyMemoryHash &&
                  snapshot.memoryContextHash !== stamp.memoryContextHash)
              )
                continue;
            } else if (changed) continue;
            kept.push(item);
          }
          return { items: kept, ...stamp, omittedItems: input.items.length - kept.length };
        }),
      );
    },
    Effect.mapError((cause) => new AssistantError({ reason: "unavailable", cause })),
  );
});
