import {
  CheckpointRef,
  ThreadId,
  type CheckpointId,
  type CheckpointScopeId,
  type ProviderThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

export class HistoryArchiveError extends Schema.TaggedError<HistoryArchiveError>()(
  "HistoryArchiveError",
  {
    reason: Schema.Literals([
      "not-found",
      "conflict",
      "reconciliation-required",
      "retention-unavailable",
      "storage",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `History archive operation failed (${this.reason}).`;
  }
}

type Identity = { readonly archiveId: string; readonly threadId: ThreadId };
type ArchivePreparation = Identity & {
  readonly reason: string;
  readonly operation?:
    | {
        readonly type: "rollback";
        readonly checkpointId: CheckpointId;
        readonly scopeId: CheckpointScopeId;
        readonly providerThreadId: ProviderThreadId;
        readonly restoreFiles: boolean;
      }
    | {
        readonly type: "file-restore";
        readonly sourceArchiveId: string;
        readonly checkpointId: CheckpointId;
      };
};

type Header = {
  readonly archive_id: string;
  readonly thread_id: ThreadId;
  readonly reason: string;
  readonly state: "preparing" | "ready" | "executing" | "completed" | "releasing" | "released";
  readonly created_at: string;
  readonly operation_json: string | null;
};
type Fragment = {
  readonly position: number;
  readonly kind: string;
  readonly source_id: string;
  readonly fragment: number;
  readonly payload: string;
};
type RetainedRef = {
  readonly checkpoint_id: string;
  readonly cwd: string;
  readonly source_ref: string;
  readonly retained_ref: string;
  readonly commit_oid: string | null;
};
export class ThreadHistoryArchiveService extends Context.Service<
  ThreadHistoryArchiveService,
  {
    readonly prepareIntent: (input: ArchivePreparation) => Effect.Effect<void, HistoryArchiveError>;
    readonly prepare: (input: ArchivePreparation) => Effect.Effect<void, HistoryArchiveError>;
    readonly resumePreparations: Effect.Effect<number, HistoryArchiveError>;
    readonly list: (input: {
      readonly threadId: ThreadId;
      readonly before?: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<Header>, HistoryArchiveError>;
    readonly detail: (
      input: Identity & { readonly after?: number; readonly limit?: number },
    ) => Effect.Effect<
      {
        readonly archive: Header;
        readonly fragments: ReadonlyArray<Fragment>;
        readonly next: number | null;
        readonly continuity: "context-only";
      },
      HistoryArchiveError
    >;
    readonly beginExternal: (input: Identity) => Effect.Effect<void, HistoryArchiveError>;
    readonly completeExternal: (input: Identity) => Effect.Effect<void, HistoryArchiveError>;
    readonly reconcileExternal: (
      input: Identity & { readonly outcome: "completed" | "not-applied" },
    ) => Effect.Effect<void, HistoryArchiveError>;
    readonly release: (input: Identity) => Effect.Effect<void, HistoryArchiveError>;
    readonly isCheckpointRetained: (ref: string) => Effect.Effect<boolean, HistoryArchiveError>;
    readonly isAttachmentRetained: (id: string) => Effect.Effect<boolean, HistoryArchiveError>;
  }
>()("t3/orchestration-v2/ThreadHistoryArchiveService") {}

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isHistoryArchiveError = Schema.is(HistoryArchiveError);
const sources = [
  ["threads", "thread_id"],
  ["runs", "run_id"],
  ["run_attempts", "attempt_id"],
  ["nodes", "node_id"],
  ["provider_session_bindings", "provider_session_id"],
  ["provider_sessions", "provider_session_id"],
  ["provider_threads", "provider_thread_id"],
  ["provider_turns", "provider_turn_id"],
  ["runtime_requests", "runtime_request_id"],
  ["messages", "message_id"],
  ["plans", "plan_id"],
  ["turn_items", "turn_item_id"],
  ["checkpoint_scopes", "scope_id"],
  ["checkpoints", "checkpoint_id"],
  ["context_handoffs", "context_handoff_id"],
  ["context_transfers", "context_transfer_id"],
  ["subagents", "subagent_id"],
] as const;
const pageLimit = (value: number | undefined, maximum: number) =>
  Math.max(1, Math.min(maximum, Math.trunc(value ?? maximum) || 1));
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const projections = yield* ProjectionStoreV2;
  const read = Effect.fn("ThreadHistoryArchive.read")(function* (input: Identity) {
    const rows =
      yield* sql<Header>`SELECT * FROM t3_workflow_v2_history_archives WHERE archive_id=${input.archiveId} AND thread_id=${input.threadId}`;
    if (!rows[0]) return yield* new HistoryArchiveError({ reason: "not-found" });
    return rows[0];
  });
  const resumePreparation = Effect.fn("ThreadHistoryArchive.resumePreparation")(function* (
    input: Identity,
  ) {
    // Keep the durable claim live through ref creation; release takes the same writer lock.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE t3_workflow_v2_history_archives SET state=state WHERE 0`;
        const archive = yield* read(input);
        if (archive.state !== "preparing") return;
        const refs =
          yield* sql<RetainedRef>`SELECT * FROM t3_workflow_v2_history_archive_refs WHERE archive_id=${input.archiveId}`;
        for (const ref of refs) {
          if (!checkpoints.retainCheckpointRef)
            return yield* new HistoryArchiveError({ reason: "retention-unavailable" });
          const oid = yield* checkpoints.retainCheckpointRef({
            cwd: ref.cwd,
            checkpointRef: CheckpointRef.make(ref.source_ref),
            retainedRef: CheckpointRef.make(ref.retained_ref),
          });
          if (ref.commit_oid !== null && oid !== ref.commit_oid)
            return yield* new HistoryArchiveError({ reason: "conflict" });
          yield* sql`UPDATE t3_workflow_v2_history_archive_refs SET commit_oid=${oid} WHERE archive_id=${input.archiveId} AND checkpoint_id=${ref.checkpoint_id}`;
        }
        yield* sql`UPDATE t3_workflow_v2_history_archives SET state='ready' WHERE archive_id=${input.archiveId} AND state='preparing'`;
      }),
    );
  });

  const prepareIntent = Effect.fn("ThreadHistoryArchive.prepareIntent")(function* (
    input: ArchivePreparation,
  ) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.archiveId))
      return yield* new HistoryArchiveError({ reason: "conflict" });
    const operationJson =
      input.operation === undefined ? null : yield* encodePayload(input.operation);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing =
          yield* sql<Header>`SELECT * FROM t3_workflow_v2_history_archives WHERE archive_id=${input.archiveId}`;
        if (existing[0]) {
          if (
            existing[0].thread_id !== input.threadId ||
            existing[0].reason !== input.reason ||
            existing[0].operation_json !== operationJson ||
            existing[0].state === "released" ||
            existing[0].state === "releasing"
          )
            return yield* new HistoryArchiveError({ reason: "conflict" });
          return;
        }
        const uncertain =
          yield* sql`SELECT 1 FROM t3_workflow_v2_history_archives WHERE thread_id=${input.threadId} AND state='executing' LIMIT 1`;
        if (uncertain.length)
          return yield* new HistoryArchiveError({ reason: "reconciliation-required" });
        const thread =
          yield* sql`SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id=${input.threadId}`;
        if (!thread.length) return yield* new HistoryArchiveError({ reason: "not-found" });
        yield* sql`INSERT INTO t3_workflow_v2_history_archives(archive_id,thread_id,reason,state,operation_json) VALUES(${input.archiveId},${input.threadId},${input.reason},'preparing',${operationJson})`;
        const closure: { threadId: string; throughOrdinal: number | null }[] = [
          { threadId: input.threadId, throughOrdinal: null },
        ];
        const seen = new Set<string>([input.threadId]);
        let sourceThread: string = input.threadId;
        while (true) {
          const ancestors = yield* sql<{ thread_id: string; ordinal: number }>`
            SELECT r.thread_id,r.ordinal FROM orchestration_v2_projection_threads t
            JOIN orchestration_v2_projection_runs r
              ON r.thread_id=json_extract(t.payload_json,'$.forkedFrom.threadId')
              AND r.run_id=json_extract(t.payload_json,'$.forkedFrom.runId')
            WHERE t.thread_id=${sourceThread} AND json_extract(t.payload_json,'$.forkedFrom.type')='run'
          `;
          const ancestor = ancestors[0];
          if (!ancestor || seen.has(ancestor.thread_id)) break;
          seen.add(ancestor.thread_id);
          closure.push({ threadId: ancestor.thread_id, throughOrdinal: ancestor.ordinal });
          sourceThread = ancestor.thread_id;
        }
        let position = 0;
        const captured = new Set<string>();
        for (const source of closure) {
          for (const [kind, identity] of sources) {
            // Store whole SQL rows, including full JSON payload and source identities. Event compaction never touches these rows.
            const columns = yield* sql.unsafe<{ name: string }>(
              `PRAGMA table_info(orchestration_v2_projection_${kind})`,
            );
            const bound =
              source.throughOrdinal === null
                ? ""
                : kind === "runs"
                  ? " AND ordinal<=?"
                  : columns.some((column) => column.name === "run_id")
                    ? ` AND (${kind === "messages" || kind === "turn_items" ? `run_id IS NULL AND EXISTS (SELECT 1 FROM orchestration_v2_projection_threads origin WHERE origin.thread_id=? AND json_extract(origin.payload_json,'$.historyOrigin')='v1_import') OR ` : "run_id IS NULL OR "}run_id IN (SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=? AND ordinal<=?))`
                    : "";
            const boundaryArgs =
              source.throughOrdinal === null || bound === ""
                ? []
                : kind === "runs"
                  ? [source.throughOrdinal]
                  : [
                      ...(kind === "messages" || kind === "turn_items" ? [source.threadId] : []),
                      source.threadId,
                      source.throughOrdinal,
                    ];
            const rows = yield* sql.unsafe<Record<string, unknown>>(
              `SELECT * FROM orchestration_v2_projection_${kind} WHERE (${kind === "context_transfers" ? "source_thread_id=? OR target_thread_id=?" : kind === "provider_sessions" ? "thread_id=? OR provider_session_id IN (SELECT provider_session_id FROM orchestration_v2_projection_provider_session_bindings WHERE thread_id=?)" : "thread_id=?"})${bound} ORDER BY ${identity}`,
              [
                ...(kind === "context_transfers" || kind === "provider_sessions"
                  ? [source.threadId, source.threadId]
                  : [source.threadId]),
                ...boundaryArgs,
              ],
            );
            for (const row of rows) {
              const sourceId =
                kind === "provider_session_bindings"
                  ? yield* encodePayload([row[identity], row.thread_id])
                  : String(row[identity]);
              const identityKey = `${kind}:${sourceId}`;
              if (captured.has(identityKey)) continue;
              captured.add(identityKey);
              const payload = yield* encodePayload(row);
              for (
                let offset = 0, fragment = 0;
                offset < payload.length;
                offset += 65536, fragment++
              ) {
                yield* sql`INSERT INTO t3_workflow_v2_history_archive_rows(archive_id,position,kind,source_id,source_order,run_id,item_type,message_id,fragment,payload) VALUES(${input.archiveId},${position++},${kind},${sourceId},${String(row.ordinal ?? row.created_at ?? "")},${typeof row.run_id === "string" ? row.run_id : null},json_extract(${typeof row.payload_json === "string" ? row.payload_json : "{}"},'$.type'),json_extract(${typeof row.payload_json === "string" ? row.payload_json : "{}"},'$.messageId'),${fragment},${payload.slice(offset, offset + 65536)})`;
              }
            }
          }
        }
        let refIndex = 0;
        for (const source of closure) {
          const refs = yield* sql<{
            checkpoint_id: string;
            source_ref: string;
            cwd: string;
          }>`SELECT c.checkpoint_id, json_extract(c.payload_json,'$.ref') AS source_ref,json_extract(s.payload_json,'$.cwd') AS cwd FROM orchestration_v2_projection_checkpoints c JOIN orchestration_v2_projection_checkpoint_scopes s ON s.scope_id=c.scope_id WHERE c.thread_id=${source.threadId} AND c.status='ready' AND (${source.throughOrdinal} IS NULL OR c.run_id IS NULL OR c.run_id IN (SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=${source.threadId} AND ordinal<=${source.throughOrdinal}))`;
          for (const ref of refs) {
            yield* sql`INSERT INTO t3_workflow_v2_history_archive_refs(archive_id,checkpoint_id,cwd,source_ref,retained_ref) VALUES(${input.archiveId},${ref.checkpoint_id},${ref.cwd},${ref.source_ref},${`refs/t3/history-archives/${input.archiveId}/${refIndex++}`})`;
          }
        }
        const attachmentIds = new Set<string>();
        for (const source of closure)
          for (const id of yield* projections.getThreadAttachmentIds(
            ThreadId.make(source.threadId),
          ))
            attachmentIds.add(id);
        for (const id of attachmentIds)
          yield* sql`INSERT INTO t3_workflow_v2_history_archive_attachments(archive_id,attachment_id) VALUES(${input.archiveId},${id})`;
      }),
    );
  });
  const changeState = Effect.fn("ThreadHistoryArchive.changeState")(function* (
    input: Identity,
    from: string,
    to: string,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE t3_workflow_v2_history_archives SET state=state WHERE 0`;
        const archive = yield* read(input);
        if (to === "executing") {
          const other =
            yield* sql`SELECT 1 FROM t3_workflow_v2_history_archives WHERE thread_id=${input.threadId} AND archive_id!=${input.archiveId} AND state='executing' LIMIT 1`;
          if (other.length)
            return yield* new HistoryArchiveError({ reason: "reconciliation-required" });
        }
        if (archive.state !== from)
          return yield* new HistoryArchiveError({
            reason: archive.state === "executing" ? "reconciliation-required" : "conflict",
          });
        yield* sql`UPDATE t3_workflow_v2_history_archives SET state=${to} WHERE archive_id=${input.archiveId}`;
      }),
    );
  });
  const protect = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isHistoryArchiveError(cause)
          ? cause
          : new HistoryArchiveError({ reason: "storage", cause }),
      ),
    );
  return ThreadHistoryArchiveService.of({
    resumePreparations: protect(
      Effect.gen(function* () {
        const pending =
          yield* sql<Header>`SELECT * FROM t3_workflow_v2_history_archives WHERE state='preparing' ORDER BY archive_id LIMIT 50`;
        let resumed = 0;
        for (const archive of pending) {
          const confirmed = yield* resumePreparation({
            threadId: ThreadId.make(archive.thread_id),
            archiveId: archive.archive_id,
          }).pipe(
            Effect.as(true),
            Effect.catch((cause) =>
              Effect.logWarning("History archive retention remains pending.", {
                archiveId: archive.archive_id,
                cause,
              }).pipe(Effect.as(false)),
            ),
          );
          if (confirmed) resumed++;
        }
        return resumed;
      }),
    ),
    prepareIntent: (input) => protect(prepareIntent(input)),
    prepare: Effect.fn("ThreadHistoryArchive.prepare")((input) =>
      protect(prepareIntent(input).pipe(Effect.andThen(resumePreparation(input)))),
    ),
    list: Effect.fn("ThreadHistoryArchive.list")((input) =>
      protect(
        sql<Header>`SELECT * FROM t3_workflow_v2_history_archives WHERE thread_id=${input.threadId} AND state NOT IN ('released','releasing') AND (${input.before ?? null} IS NULL OR (created_at,archive_id) < (SELECT created_at,archive_id FROM t3_workflow_v2_history_archives WHERE archive_id=${input.before ?? null} AND thread_id=${input.threadId})) ORDER BY created_at DESC,archive_id DESC LIMIT ${pageLimit(input.limit, 50)}`,
      ),
    ),
    detail: Effect.fn("ThreadHistoryArchive.detail")((input) =>
      protect(
        Effect.gen(function* () {
          const archive = yield* read(input);
          if (archive.state === "released" || archive.state === "releasing")
            return yield* new HistoryArchiveError({ reason: "not-found" });
          const limit = pageLimit(input.limit, 4);
          const fragments =
            yield* sql<Fragment>`SELECT position,kind,source_id,fragment,payload FROM t3_workflow_v2_history_archive_rows WHERE archive_id=${input.archiveId} AND position > ${input.after ?? -1} ORDER BY position LIMIT ${limit + 1}`;
          const page = fragments.slice(0, limit);
          return {
            archive,
            fragments: page,
            next: fragments.length > limit ? page.at(-1)!.position : null,
            continuity: "context-only" as const,
          };
        }),
      ),
    ),
    beginExternal: (input) => protect(changeState(input, "ready", "executing")),
    completeExternal: (input) => protect(changeState(input, "executing", "completed")),
    reconcileExternal: (input) =>
      protect(
        changeState(input, "executing", input.outcome === "completed" ? "completed" : "ready"),
      ),
    release: Effect.fn("ThreadHistoryArchive.release")((input) =>
      protect(
        Effect.gen(function* () {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const archive = yield* read(input);
              const dependent =
                yield* sql`SELECT 1 FROM t3_workflow_v2_history_archives WHERE state='executing' AND json_extract(operation_json,'$.type')='file-restore' AND json_extract(operation_json,'$.sourceArchiveId')=${input.archiveId} LIMIT 1`;
              if (dependent.length)
                return yield* new HistoryArchiveError({ reason: "reconciliation-required" });
              if (archive.state === "executing")
                return yield* new HistoryArchiveError({ reason: "reconciliation-required" });
              if (archive.state !== "released")
                yield* sql`UPDATE t3_workflow_v2_history_archives SET state='releasing' WHERE archive_id=${input.archiveId}`;
            }),
          );
          const refs =
            yield* sql<RetainedRef>`SELECT * FROM t3_workflow_v2_history_archive_refs WHERE archive_id=${input.archiveId}`;
          for (const ref of refs)
            yield* checkpoints.deleteCheckpointRefs({
              cwd: ref.cwd,
              checkpointRefs: [CheckpointRef.make(ref.retained_ref)],
            });
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM t3_workflow_v2_history_archive_rows WHERE archive_id=${input.archiveId}`;
              yield* sql`DELETE FROM t3_workflow_v2_history_archive_refs WHERE archive_id=${input.archiveId}`;
              yield* sql`DELETE FROM t3_workflow_v2_history_archive_attachments WHERE archive_id=${input.archiveId}`;
              yield* sql`UPDATE t3_workflow_v2_history_archives SET state='released' WHERE archive_id=${input.archiveId}`;
            }),
          );
        }),
      ),
    ),
    isCheckpointRetained: (ref) =>
      protect(
        sql`SELECT 1 FROM t3_workflow_v2_history_archive_refs r JOIN t3_workflow_v2_history_archives a USING(archive_id) WHERE r.source_ref=${ref} AND a.state!='released' LIMIT 1`.pipe(
          Effect.map((rows) => rows.length > 0),
        ),
      ),
    isAttachmentRetained: (id) =>
      protect(
        sql`SELECT 1 FROM t3_workflow_v2_history_archive_attachments r JOIN t3_workflow_v2_history_archives a USING(archive_id) WHERE r.attachment_id=${id} AND a.state!='released' LIMIT 1`.pipe(
          Effect.map((rows) => rows.length > 0),
        ),
      ),
  });
});
export const layer = Layer.effect(ThreadHistoryArchiveService, make);
