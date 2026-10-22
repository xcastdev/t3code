import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import {
  CheckpointRef,
  CommandId,
  type MessageId,
  CheckpointId,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  ThreadId,
  OrchestrationV2TurnItemJson,
  OrchestrationV2RunJson,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { assertOrdinaryAssistantDestination } from "../assistants/AssistantGuards.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { isForkableSourceRunStatus } from "./ThreadForkService.ts";
import { isCheckpointRestoreIsolated } from "./CheckpointRestoreSafety.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as Archive from "./ThreadHistoryArchiveService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as AssistantPolicy from "./ThreadHistoryRecoveryAssistantPolicy.ts";
import { HistoryArchiveCommitGuard } from "./ThreadHistoryArchiveCommitGuard.ts";

export class HistoryRecoveryError extends Schema.TaggedError<HistoryRecoveryError>()(
  "HistoryRecoveryError",
  {
    reason: Schema.Literals([
      "unavailable",
      "forbidden",
      "shared-workspace",
      "busy",
      "invalid-target",
      "reconciliation-required",
      "execution",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `History recovery failed (${this.reason}).`;
  }
}
type Identity = { readonly threadId: ThreadId; readonly archiveId: string };
type RecoverInput = Identity & {
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly mode: "restore" | "fork";
  readonly targetThreadId?: ThreadId;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
};
type FileRestoreInput = Identity & {
  readonly checkpointId: CheckpointId;
  readonly commandId: CommandId;
};
type FileRestoreStatus = Identity & {
  readonly state: "preparing" | "ready" | "executing" | "completed" | "releasing" | "released";
};
export class ThreadHistoryRecoveryService extends Context.Service<
  ThreadHistoryRecoveryService,
  {
    readonly capabilities: (input: Identity) => Effect.Effect<
      {
        readonly owner: "ordinary" | "assistant-home";
        readonly contextRestore: boolean;
        readonly fork: boolean;
        readonly restoreFiles: boolean;
        readonly retainedCheckpointIds: ReadonlyArray<CheckpointId>;
      },
      HistoryRecoveryError
    >;
    readonly recover: (input: RecoverInput) => Effect.Effect<
      {
        readonly threadId: ThreadId;
        readonly archiveId: string;
        readonly continuity: "context-only";
        readonly partial: boolean;
        readonly filesRestored: false;
      },
      HistoryRecoveryError
    >;
    readonly restoreFiles: (
      input: FileRestoreInput,
    ) => Effect.Effect<Identity & { readonly state: "completed" }, HistoryRecoveryError>;
    readonly fileRestoreStatus: (
      input: FileRestoreInput,
    ) => Effect.Effect<
      FileRestoreStatus | (Identity & { readonly state: "not-started" }),
      HistoryRecoveryError
    >;
    readonly reconcileFiles: (
      input: Identity,
    ) => Effect.Effect<FileRestoreStatus, HistoryRecoveryError>;
  }
>()("t3/orchestration-v2/ThreadHistoryRecoveryService") {}
const decodeRow = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ payload_json: Schema.String })),
);
const decodeMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      role: Schema.String,
      text: Schema.String,
      createdAt: Schema.optional(Schema.String),
    }),
  ),
);
const decodeTurnItem = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJson),
);
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2RunJson));
const decodeFileOperation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("file-restore"),
      sourceArchiveId: Schema.String,
      checkpointId: Schema.String,
    }),
  ),
);
const isRecoveryError = Schema.is(HistoryRecoveryError);
const isArchiveError = Schema.is(Archive.HistoryArchiveError);
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const assistantPolicy = yield* Effect.serviceOption(
    AssistantPolicy.ThreadHistoryRecoveryAssistantPolicy,
  );
  const crypto = yield* Crypto.Crypto;
  const archives = yield* Archive.ThreadHistoryArchiveService;
  const projections = yield* ProjectionStoreV2;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const assertArchive = Effect.fn("ThreadHistoryRecovery.assertArchive")(function* (
    input: Identity,
  ) {
    const rows = yield* sql<{
      state: string;
    }>`SELECT state FROM t3_workflow_v2_history_archives WHERE archive_id=${input.archiveId} AND thread_id=${input.threadId}`;
    if (!rows[0] || !["ready", "executing", "completed"].includes(rows[0].state))
      return yield* new HistoryRecoveryError({ reason: "unavailable" });
  });
  const guard = Effect.fn("ThreadHistoryRecovery.guard")(function* (
    input: Identity,
    allowAssistant = false,
  ) {
    yield* assertArchive(input);
    const thread = yield* projections.getThread(input.threadId);
    if (!allowAssistant)
      yield* assertOrdinaryAssistantDestination({
        threadId: thread.id,
        projectId: thread.projectId,
      }).pipe(Effect.mapError((cause) => new HistoryRecoveryError({ reason: "forbidden", cause })));
    if (thread.deletedAt !== null)
      return yield* new HistoryRecoveryError({ reason: "unavailable" });
    const records = yield* projections.getThreadRecords(input.threadId, ["runs"]);
    if (
      records.runs.some(
        (run) =>
          !["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(run.status),
      )
    )
      return yield* new HistoryRecoveryError({ reason: "busy" });
    return thread;
  });
  const context = Effect.fn("ThreadHistoryRecovery.context")(function* (input: Identity) {
    const selected = yield* sql<{
      source_id: string;
      bytes: number;
    }>`SELECT source_id,sum(length(payload)) AS bytes FROM t3_workflow_v2_history_archive_rows WHERE archive_id=${input.archiveId} AND kind='messages' GROUP BY source_id HAVING sum(length(payload))<=8192 ORDER BY max(source_order) DESC,max(position) DESC LIMIT 20`;
    const count = yield* sql<{
      count: number;
    }>`SELECT count(DISTINCT source_id) AS count FROM t3_workflow_v2_history_archive_rows WHERE archive_id=${input.archiveId} AND kind='messages'`;
    const messages = [];
    for (const entry of selected) {
      const fragments = yield* sql<{
        payload: string;
      }>`SELECT payload FROM t3_workflow_v2_history_archive_rows WHERE archive_id=${input.archiveId} AND kind='messages' AND source_id=${entry.source_id} ORDER BY fragment`;
      const row = yield* decodeRow(fragments.map((value) => value.payload).join(""));
      messages.push(yield* decodeMessage(row.payload_json));
    }
    messages.sort(
      (a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id),
    );
    const partial = (count[0]?.count ?? 0) > messages.length;
    return {
      kind: "ordinary" as const,
      partial,
      text: `Recovered conversation context from archive ${input.archiveId}. This restores context only; the provider conversation has not been rewound and files have not been restored.${partial ? " Only a bounded selection is included; the complete conversation remains in the archive." : ""}\n\n${messages.map((message) => `[${message.role}; message ${message.id}]\n${message.text}`).join("\n\n")}`,
    };
  });
  const assistantContext = Effect.fn("ThreadHistoryRecovery.assistantContext")(function* (
    input: Identity,
    projectId: import("@t3tools/contracts").ProjectId,
  ) {
    if (Option.isNone(assistantPolicy))
      return yield* new HistoryRecoveryError({ reason: "forbidden" });
    const selected = yield* sql<{
      source_id: string;
    }>`SELECT source_id FROM t3_workflow_v2_history_archive_rows WHERE archive_id=${input.archiveId} AND kind='turn_items' GROUP BY source_id HAVING sum(length(payload))<=8192 ORDER BY max(CAST(source_order AS INTEGER)) DESC LIMIT 40`;
    const evidence: { kind: string; sourceId: string; payload: string }[] = [];
    const items = [];
    for (const source of selected) {
      const fragments = yield* sql<{
        payload: string;
      }>`SELECT payload FROM t3_workflow_v2_history_archive_rows WHERE archive_id=${input.archiveId} AND kind='turn_items' AND source_id=${source.source_id} ORDER BY fragment`;
      const payload = fragments.map((fragment) => fragment.payload).join("");
      const row = yield* decodeRow(payload);
      items.push(yield* decodeTurnItem(row.payload_json));
      evidence.push({
        kind: "turn_items",
        sourceId: source.source_id,
        payload,
      });
    }
    items.sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
    const filtered = yield* assistantPolicy.value.capture({
      threadId: input.threadId,
      projectId,
      archiveId: input.archiveId,
      items,
    });
    const text = filtered.items
      .flatMap((item) =>
        item.type === "user_message" || item.type === "assistant_message"
          ? [`[${item.type}; item ${item.id}]\n${item.text}`]
          : [],
      )
      .join("\n\n");
    return {
      kind: "assistant" as const,
      stamp: filtered.stamp,
      evidence,
      partial: true,
      text: `Recovered archived context permitted by the assistant's current memory policy. This is bounded context only; native provider history and files have not been restored. Older, unverified, or forgotten history is omitted.\n\n${text}`,
    };
  });
  const protect = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => {
    const scoped = effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));
    return (
      Option.isSome(assistantPolicy)
        ? scoped.pipe(
            Effect.provideService(
              AssistantPolicy.ThreadHistoryRecoveryAssistantPolicy,
              assistantPolicy.value,
            ),
          )
        : scoped
    ).pipe(
      Effect.mapError((cause) =>
        isRecoveryError(cause)
          ? cause
          : new HistoryRecoveryError({
              reason:
                isArchiveError(cause) && cause.reason === "reconciliation-required"
                  ? "reconciliation-required"
                  : "execution",
              cause,
            }),
      ),
    );
  };
  const operationFor = Effect.fn("ThreadHistoryRecovery.fileOperation")(function* (
    input: FileRestoreInput,
  ) {
    return {
      threadId: input.threadId,
      archiveId: Hex.encode(
        yield* crypto
          .digest("SHA-256", new TextEncoder().encode(`restore-files:${input.commandId}`))
          .pipe(Effect.orDie),
      ),
    };
  });
  const readFileOperation = Effect.fn("ThreadHistoryRecovery.readFileOperation")(function* (
    input: Identity,
  ) {
    const detail = yield* archives
      .detail(input)
      .pipe(Effect.mapError((cause) => new HistoryRecoveryError({ reason: "unavailable", cause })));
    const operation = yield* decodeFileOperation(detail.archive.operation_json).pipe(
      Effect.mapError(
        (cause) =>
          new HistoryRecoveryError({
            reason: "reconciliation-required",
            cause,
          }),
      ),
    );
    return { operation, state: detail.archive.state };
  });
  const archivedSourceRun = Effect.fn("ThreadHistoryRecovery.archivedSourceRun")(function* (
    input: Identity,
  ) {
    const candidates = yield* sql<{ source_id: string; payload: string }>`
      WITH eligible AS (
        SELECT source_id FROM t3_workflow_v2_history_archive_rows
        WHERE archive_id=${input.archiveId} AND kind='runs' GROUP BY source_id
        HAVING sum(length(payload))<=262144
      ), whole AS (
        SELECT source_id,group_concat(payload,'') AS payload,max(CAST(source_order AS INTEGER)) AS ordinal,max(position) AS position
        FROM (SELECT r.* FROM t3_workflow_v2_history_archive_rows r JOIN eligible e USING(source_id)
          WHERE r.archive_id=${input.archiveId} AND r.kind='runs' ORDER BY r.source_id,r.fragment)
        GROUP BY source_id
      ) SELECT source_id,payload FROM whole WHERE json_extract(payload,'$.thread_id')=${input.threadId}
        ORDER BY ordinal DESC,position DESC LIMIT 1
    `;
    const candidate = candidates[0];
    if (!candidate) return null;
    const run = yield* decodeRun((yield* decodeRow(candidate.payload)).payload_json);
    if (
      run.threadId !== input.threadId ||
      (!isForkableSourceRunStatus(run.status) && run.status !== "rolled_back")
    )
      return null;
    return candidate;
  });
  return ThreadHistoryRecoveryService.of({
    capabilities: Effect.fn("ThreadHistoryRecovery.capabilities")((input) =>
      protect(
        Effect.gen(function* () {
          const header = yield* sql<{
            state: string;
          }>`SELECT state FROM t3_workflow_v2_history_archives WHERE archive_id=${input.archiveId} AND thread_id=${input.threadId} AND state NOT IN ('released','releasing')`;
          if (!header[0]) return yield* new HistoryRecoveryError({ reason: "unavailable" });
          const owned =
            yield* sql`SELECT 1 FROM t3_workflow_v2_assistants WHERE thread_id=${input.threadId} OR project_id IN (SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id=${input.threadId}) LIMIT 1`;
          const owner = owned.length > 0 ? ("assistant-home" as const) : ("ordinary" as const);
          const unavailable = {
            owner,
            contextRestore: false,
            fork: false,
            restoreFiles: false,
            retainedCheckpointIds: [] as CheckpointId[],
          };
          // Eligibility is a read snapshot; mutation paths recheck the same current guards at commit.
          return yield* Effect.gen(function* () {
            const current = yield* guard(input, owner === "assistant-home");
            if (owner === "assistant-home") {
              if (Option.isNone(assistantPolicy)) return unavailable;
              yield* assistantPolicy.value.capture({
                threadId: input.threadId,
                projectId: current.projectId,
                archiveId: input.archiveId,
                items: [],
              });
              return { ...unavailable, contextRestore: true };
            }
            const retainedCheckpointIds: CheckpointId[] = [];
            const refs = yield* sql<{
              checkpoint_id: string;
              cwd: string;
              retained_ref: string;
            }>`SELECT checkpoint_id,cwd,retained_ref FROM t3_workflow_v2_history_archive_refs WHERE archive_id=${input.archiveId} AND commit_oid IS NOT NULL ORDER BY checkpoint_id`;
            for (const ref of refs) {
              const available = yield* Effect.gen(function* () {
                if (
                  !(yield* isCheckpointRestoreIsolated(
                    current,
                    { cwd: ref.cwd },
                    { fileSystem, path, projections, projects },
                  ))
                )
                  return false;
                return yield* checkpoints.hasCheckpointRef({
                  cwd: ref.cwd,
                  checkpointRef: CheckpointRef.make(ref.retained_ref),
                });
              }).pipe(Effect.catch(() => Effect.succeed(false)));
              if (available) retainedCheckpointIds.push(CheckpointId.make(ref.checkpoint_id));
            }
            const run = yield* archivedSourceRun(input);
            const executing =
              yield* sql`SELECT 1 FROM t3_workflow_v2_history_archives WHERE thread_id=${input.threadId} AND state='executing' LIMIT 1`;
            return {
              owner,
              contextRestore: true,
              fork: run !== null,
              restoreFiles: executing.length === 0 && retainedCheckpointIds.length > 0,
              retainedCheckpointIds,
            };
          }).pipe(Effect.catch(() => Effect.succeed(unavailable)));
        }),
      ),
    ),
    recover: Effect.fn("ThreadHistoryRecovery.recover")((input) =>
      protect(
        Effect.gen(function* () {
          const current = yield* projections.getThread(input.threadId);
          const owned =
            yield* sql`SELECT 1 FROM t3_workflow_v2_assistants WHERE thread_id=${input.threadId} OR project_id=${current.projectId} LIMIT 1`;
          const ownedRestore = owned.length > 0 && input.mode === "restore";
          const source = yield* guard(input, ownedRestore);
          const recovered = ownedRestore
            ? yield* assistantContext(input, source.projectId)
            : yield* context(input);
          if (input.mode === "fork") {
            if (!input.targetThreadId || input.targetThreadId === input.threadId)
              return yield* new HistoryRecoveryError({
                reason: "invalid-target",
              });
            yield* assertOrdinaryAssistantDestination({
              threadId: input.targetThreadId,
              projectId: source.projectId,
            }).pipe(
              Effect.mapError((cause) => new HistoryRecoveryError({ reason: "forbidden", cause })),
            );
            const sourceRows: {
              kind: string;
              sourceId: string;
              payload: string;
            }[] = [];
            const run = yield* archivedSourceRun(input);
            if (run === null) return yield* new HistoryRecoveryError({ reason: "unavailable" });
            for (const [kind, sourceId] of [
              ["threads", input.threadId],
              ["runs", run.source_id],
            ] as const) {
              const rows = yield* sql<{
                payload: string;
              }>`SELECT payload FROM t3_workflow_v2_history_archive_rows WHERE archive_id=${input.archiveId} AND kind=${kind} AND source_id=${sourceId} ORDER BY fragment`;
              sourceRows.push({
                kind,
                sourceId,
                payload: rows.map((row) => row.payload).join(""),
              });
            }
            yield* threads
              .dispatch({
                type: "thread.history.fork",
                commandId: input.commandId,
                sourceThreadId: input.threadId,
                targetThreadId: input.targetThreadId,
                archiveId: input.archiveId,
                createdBy: input.createdBy,
                creationSource: input.creationSource,
              })
              .pipe(
                Effect.provideService(HistoryArchiveCommitGuard, {
                  ...input,
                  rows: sourceRows,
                }),
              );
            yield* threads
              .sendToThread({
                projectId: source.projectId,
                commandId: CommandId.make(`${input.commandId}:archive-context`),
                threadId: input.targetThreadId,
                messageId: input.messageId,
                text: recovered.text,
                attachments: [],
                mode: "auto",
                createdBy: "system",
                creationSource: "server",
              })
              .pipe(
                Effect.provideService(HistoryArchiveCommitGuard, {
                  ...input,
                  rows: sourceRows,
                }),
              );
          } else {
            if (input.targetThreadId !== undefined && input.targetThreadId !== input.threadId)
              return yield* new HistoryRecoveryError({
                reason: "invalid-target",
              });
            yield* threads
              .sendToThread({
                projectId: source.projectId,
                commandId: input.commandId,
                threadId: source.id,
                messageId: input.messageId,
                text: recovered.text,
                attachments: [],
                mode: "auto",
                createdBy: "system",
                creationSource: "server",
              })
              .pipe(
                Effect.provideService(HistoryArchiveCommitGuard, {
                  ...input,
                  rows: recovered.kind === "assistant" ? recovered.evidence : [],
                  ...(recovered.kind === "assistant" ? { assistantStamp: recovered.stamp } : {}),
                }),
              );
          }
          return {
            threadId: input.mode === "fork" ? input.targetThreadId! : source.id,
            archiveId: input.archiveId,
            continuity: "context-only" as const,
            partial: recovered.partial,
            filesRestored: false as const,
          };
        }),
      ),
    ),
    fileRestoreStatus: Effect.fn("ThreadHistoryRecovery.fileRestoreStatus")((input) =>
      protect(
        Effect.gen(function* () {
          const identity = yield* operationFor(input);
          const exists =
            yield* sql`SELECT 1 FROM t3_workflow_v2_history_archives WHERE archive_id=${identity.archiveId}`;
          if (exists.length === 0) {
            yield* guard(input);
            const retained =
              yield* sql`SELECT 1 FROM t3_workflow_v2_history_archive_refs WHERE archive_id=${input.archiveId} AND checkpoint_id=${input.checkpointId} AND commit_oid IS NOT NULL LIMIT 1`;
            if (retained.length === 0)
              return yield* new HistoryRecoveryError({
                reason: "unavailable",
              });
            // Absence permits only the same request to be retried; it does not cancel a delayed sender.
            return { ...identity, state: "not-started" as const };
          }
          const { operation, state } = yield* readFileOperation(identity);
          if (
            operation.sourceArchiveId !== input.archiveId ||
            operation.checkpointId !== input.checkpointId
          )
            return yield* new HistoryRecoveryError({ reason: "unavailable" });
          if (state !== "completed")
            yield* guard({
              threadId: input.threadId,
              archiveId: operation.sourceArchiveId,
            });
          return { ...identity, state };
        }),
      ),
    ),
    reconcileFiles: Effect.fn("ThreadHistoryRecovery.reconcileFiles")((input) =>
      protect(
        Effect.gen(function* () {
          const initial = yield* readFileOperation(input);
          const source = {
            threadId: input.threadId,
            archiveId: initial.operation.sourceArchiveId,
          };
          yield* guard(source);
          const refs = yield* sql<{
            cwd: string;
            commit_oid: string;
          }>`SELECT cwd,commit_oid FROM t3_workflow_v2_history_archive_refs WHERE archive_id=${source.archiveId} AND checkpoint_id=${initial.operation.checkpointId} AND commit_oid IS NOT NULL`;
          const ref = refs[0];
          if (!ref || !checkpoints.matchesCheckpoint)
            return yield* new HistoryRecoveryError({
              reason: "reconciliation-required",
            });
          return yield* withWorkspaceLease(
            path.resolve(ref.cwd),
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`UPDATE t3_workflow_v2_history_archives SET state=state WHERE 0`;
                const { operation, state } = yield* readFileOperation(input);
                if (
                  operation.sourceArchiveId !== initial.operation.sourceArchiveId ||
                  operation.checkpointId !== initial.operation.checkpointId
                )
                  return yield* new HistoryRecoveryError({
                    reason: "reconciliation-required",
                  });
                const current = yield* guard(source);
                if (state === "completed") return { ...input, state };
                if (
                  state !== "executing" ||
                  !(yield* isCheckpointRestoreIsolated(
                    current,
                    { cwd: ref.cwd },
                    { fileSystem, path, projections, projects },
                  ))
                )
                  return yield* new HistoryRecoveryError({
                    reason: "reconciliation-required",
                  });
                if (
                  !(yield* checkpoints.matchesCheckpoint!({
                    cwd: ref.cwd,
                    checkpointRef: CheckpointRef.make(ref.commit_oid),
                  }))
                )
                  return yield* new HistoryRecoveryError({
                    reason: "reconciliation-required",
                  });
                yield* archives.completeExternal(input);
                return { ...input, state: "completed" as const };
              }),
            ),
          );
        }),
      ),
    ),
    restoreFiles: Effect.fn("ThreadHistoryRecovery.restoreFiles")((input) =>
      protect(
        Effect.gen(function* () {
          yield* guard(input);
          const refs = yield* sql<{
            cwd: string;
            retained_ref: string;
          }>`SELECT cwd,retained_ref FROM t3_workflow_v2_history_archive_refs WHERE archive_id=${input.archiveId} AND checkpoint_id=${input.checkpointId} AND commit_oid IS NOT NULL`;
          const ref = refs[0];
          if (!ref) return yield* new HistoryRecoveryError({ reason: "unavailable" });
          return yield* withWorkspaceLease(
            path.resolve(ref.cwd),
            Effect.gen(function* () {
              const operation = yield* operationFor(input);
              const exists =
                yield* sql`SELECT 1 FROM t3_workflow_v2_history_archives WHERE archive_id=${operation.archiveId}`;
              if (exists.length > 0) {
                const prior = yield* readFileOperation(operation);
                if (
                  prior.operation.sourceArchiveId !== input.archiveId ||
                  prior.operation.checkpointId !== input.checkpointId
                )
                  return yield* new HistoryRecoveryError({
                    reason: "unavailable",
                  });
                if (prior.state === "completed")
                  return { ...operation, state: "completed" as const };
                if (prior.state === "executing")
                  return yield* new HistoryRecoveryError({
                    reason: "reconciliation-required",
                  });
              }
              const current = yield* guard(input);
              if (
                !(yield* isCheckpointRestoreIsolated(
                  current,
                  { cwd: ref.cwd },
                  { fileSystem, path, projections, projects },
                ))
              )
                return yield* new HistoryRecoveryError({
                  reason: "shared-workspace",
                });
              yield* archives.prepare({
                ...operation,
                reason: "file-restore",
                operation: {
                  type: "file-restore",
                  sourceArchiveId: input.archiveId,
                  checkpointId: input.checkpointId,
                },
              });
              yield* archives.beginExternal(operation);
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql`UPDATE t3_workflow_v2_history_archives SET state=state WHERE 0`;
                  const latest = yield* guard(input);
                  if (
                    !(yield* isCheckpointRestoreIsolated(
                      latest,
                      { cwd: ref.cwd },
                      { fileSystem, path, projections, projects },
                    ))
                  )
                    return yield* new HistoryRecoveryError({
                      reason: "shared-workspace",
                    });
                  const restored = yield* checkpoints.restoreCheckpoint({
                    cwd: ref.cwd,
                    checkpointRef: CheckpointRef.make(ref.retained_ref),
                    fallbackToHead: false,
                  });
                  if (!restored)
                    return yield* new HistoryRecoveryError({
                      reason: "unavailable",
                    });
                }),
              );
              yield* archives.completeExternal(operation);
              return { ...operation, state: "completed" as const };
            }),
          );
        }),
      ),
    ),
  });
});
export const layer = Layer.effect(ThreadHistoryRecoveryService, make);
