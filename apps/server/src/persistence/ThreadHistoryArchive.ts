import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { isImportedAgentSessionMessageId } from "@t3tools/contracts";

import { toPersistenceSqlError, type PersistenceSqlError } from "./Errors.ts";

export interface ThreadHistoryArchiveMetadata {
  readonly archiveId: string;
  readonly threadId: string;
  readonly createdAt: string;
  readonly turnCount: number;
}

export interface ThreadHistoryArchiveRecord extends ThreadHistoryArchiveMetadata {
  readonly snapshotJson: string;
  readonly providerBindingJson: string;
  readonly projectionRowsJson: string;
}

export interface ThreadHistoryArchiveRepositoryShape {
  readonly insert: (record: ThreadHistoryArchiveRecord) => Effect.Effect<void, PersistenceSqlError>;
  readonly listByThread: (
    threadId: string,
  ) => Effect.Effect<ReadonlyArray<ThreadHistoryArchiveMetadata>, PersistenceSqlError>;
  readonly get: (
    threadId: string,
    archiveId: string,
  ) => Effect.Effect<ThreadHistoryArchiveRecord | undefined, PersistenceSqlError>;
  readonly deleteByThread: (threadId: string) => Effect.Effect<void, PersistenceSqlError>;
  readonly captureProjectionRows: (
    threadId: string,
    checkpointRefMap?: Readonly<Record<string, string>>,
  ) => Effect.Effect<string, PersistenceSqlError>;
  readonly restoreProjectionRows: (
    threadId: string,
    archiveRowsJson: string,
    checkpointRefMap?: Readonly<Record<string, string>>,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly restoreForkProjectionRows: (
    sourceThreadId: string,
    forkThreadId: string,
    archiveRowsJson: string,
    turnCount: number,
    checkpointRefMap?: Readonly<Record<string, string>>,
  ) => Effect.Effect<void, PersistenceSqlError>;
}

export class ThreadHistoryArchiveRepository extends Context.Service<
  ThreadHistoryArchiveRepository,
  ThreadHistoryArchiveRepositoryShape
>()("t3/persistence/ThreadHistoryArchive/ThreadHistoryArchiveRepository") {}

const projectionTables = [
  "projection_threads",
  "projection_thread_messages",
  "projection_thread_activities",
  "projection_thread_proposed_plans",
  "projection_turns",
  "projection_thread_sessions",
  "projection_pending_approvals",
] as const;

type ProjectionTable = (typeof projectionTables)[number];
type ProjectionRow = Record<string, string | number | null>;
type ProjectionRows = Record<ProjectionTable, ProjectionRow[]>;
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function decodeProjectionRows(value: string, threadId: string): ProjectionRows {
  const parsed = decodeJson(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Archive projection rows must be an object");
  }
  const record = parsed as Record<string, unknown>;
  const result = {} as ProjectionRows;
  for (const table of projectionTables) {
    const rows = record[table];
    if (!Array.isArray(rows)) throw new Error(`Archive is missing ${table}`);
    result[table] = rows.map((row: unknown) => {
      if (row === null || typeof row !== "object" || Array.isArray(row)) {
        throw new Error(`Invalid ${table} row`);
      }
      const entries = Object.entries(row);
      if (
        !entries.every(
          ([key, field]) =>
            key !== "row_id" &&
            (field === null || typeof field === "string" || typeof field === "number"),
        ) ||
        (row as Record<string, unknown>).thread_id !== threadId
      ) {
        throw new Error(`Invalid ${table} row for thread`);
      }
      return row as ProjectionRow;
    });
  }
  if (result.projection_threads.length !== 1) {
    throw new Error("Archive must contain exactly one thread row");
  }
  return result;
}

/** @public Immutable archive records are written once; a duplicate id is an error. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    insert: (record: ThreadHistoryArchiveRecord) =>
      sql`
        INSERT INTO thread_history_archives (
          archive_id, thread_id, created_at, turn_count, snapshot_json, provider_binding_json,
          projection_rows_json
        ) VALUES (
          ${record.archiveId}, ${record.threadId}, ${record.createdAt}, ${record.turnCount},
          ${record.snapshotJson}, ${record.providerBindingJson}, ${record.projectionRowsJson}
        )
      `.pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("ThreadHistoryArchiveRepository.insert")),
      ),
    listByThread: (threadId: string) =>
      sql<ThreadHistoryArchiveMetadata>`
        SELECT archive_id AS archiveId, thread_id AS threadId,
          created_at AS createdAt, turn_count AS turnCount
        FROM thread_history_archives
        WHERE thread_id = ${threadId}
        ORDER BY created_at DESC, archive_id DESC
      `.pipe(Effect.mapError(toPersistenceSqlError("ThreadHistoryArchiveRepository.listByThread"))),
    get: (threadId: string, archiveId: string) =>
      sql<ThreadHistoryArchiveRecord>`
        SELECT archive_id AS archiveId, thread_id AS threadId,
          created_at AS createdAt, turn_count AS turnCount,
          snapshot_json AS snapshotJson, provider_binding_json AS providerBindingJson,
          projection_rows_json AS projectionRowsJson
        FROM thread_history_archives
        WHERE thread_id = ${threadId} AND archive_id = ${archiveId}
        LIMIT 1
      `.pipe(
        Effect.map((rows) => rows[0]),
        Effect.mapError(toPersistenceSqlError("ThreadHistoryArchiveRepository.get")),
      ),
    deleteByThread: (threadId: string) =>
      sql`DELETE FROM thread_history_archives WHERE thread_id = ${threadId}`.pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("ThreadHistoryArchiveRepository.deleteByThread")),
      ),
    captureProjectionRows: (
      threadId: string,
      checkpointRefMap: Readonly<Record<string, string>> = {},
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const result = {} as ProjectionRows;
            for (const table of projectionTables) {
              const rows = yield* sql.unsafe<ProjectionRow>(
                `SELECT * FROM ${table} WHERE thread_id = ?`,
                [threadId],
              );
              result[table] = rows.map((row) => {
                const copy = { ...row };
                delete copy.row_id;
                if (table === "projection_turns" && typeof copy.checkpoint_ref === "string") {
                  copy.checkpoint_ref =
                    checkpointRefMap[copy.checkpoint_ref] ?? copy.checkpoint_ref;
                }
                return copy;
              });
            }
            return encodeJson(result);
          }),
        )
        .pipe(
          Effect.mapError(
            toPersistenceSqlError("ThreadHistoryArchiveRepository.captureProjectionRows"),
          ),
        ),
    restoreProjectionRows: (
      threadId: string,
      archiveRowsJson: string,
      checkpointRefMap: Readonly<Record<string, string>> = {},
    ) =>
      Effect.try({
        try: () => decodeProjectionRows(archiveRowsJson, threadId),
        catch: toPersistenceSqlError("ThreadHistoryArchiveRepository.restoreProjectionRows:decode"),
      }).pipe(
        Effect.flatMap((archiveRows) =>
          sql.withTransaction(
            Effect.gen(function* () {
              for (const table of projectionTables) {
                const available = yield* sql.unsafe<{ name: string }>(
                  `PRAGMA table_info(${table})`,
                );
                const columnNames = new Set(available.map((column) => column.name));
                for (const row of archiveRows[table]) {
                  if (Object.keys(row).some((column) => !columnNames.has(column))) {
                    throw new Error(`Archive has unknown ${table} column`);
                  }
                }
              }
              for (const table of [...projectionTables].reverse()) {
                if (table === "projection_thread_sessions") continue;
                yield* sql.unsafe(`DELETE FROM ${table} WHERE thread_id = ?`, [threadId]);
              }
              for (const table of projectionTables) {
                if (
                  table === "projection_pending_approvals" ||
                  table === "projection_thread_sessions"
                )
                  continue;
                for (const rawRow of archiveRows[table]) {
                  const row = { ...rawRow };
                  if (table === "projection_turns" && typeof row.checkpoint_ref === "string") {
                    row.checkpoint_ref = checkpointRefMap[row.checkpoint_ref] ?? row.checkpoint_ref;
                  }
                  const columns = Object.keys(row);
                  if (columns.length === 0) throw new Error(`Archive has empty ${table} row`);
                  const names = columns.map((column) => `"${column}"`).join(", ");
                  const placeholders = columns.map(() => "?").join(", ");
                  yield* sql.unsafe(
                    `INSERT INTO ${table} (${names}) VALUES (${placeholders})`,
                    columns.map((column) => row[column]),
                  );
                }
              }
            }),
          ),
        ),
        Effect.mapError(
          toPersistenceSqlError("ThreadHistoryArchiveRepository.restoreProjectionRows"),
        ),
      ),
    restoreForkProjectionRows: (
      sourceThreadId: string,
      forkThreadId: string,
      archiveRowsJson: string,
      turnCount: number,
      checkpointRefMap: Readonly<Record<string, string>> = {},
    ) =>
      Effect.try({
        try: () => decodeProjectionRows(archiveRowsJson, sourceThreadId),
        catch: toPersistenceSqlError(
          "ThreadHistoryArchiveRepository.restoreForkProjectionRows:decode",
        ),
      }).pipe(
        Effect.flatMap((archiveRows) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const retainedTurns = archiveRows.projection_turns.filter(
                (row) =>
                  typeof row.checkpoint_turn_count === "number" &&
                  row.checkpoint_turn_count <= turnCount,
              );
              const retainedTurnIds = new Set(
                retainedTurns.flatMap((row) =>
                  typeof row.turn_id === "string" ? [row.turn_id] : [],
                ),
              );
              const firstRemovedAt = archiveRows.projection_turns
                .filter(
                  (row) =>
                    typeof row.checkpoint_turn_count === "number" &&
                    row.checkpoint_turn_count > turnCount &&
                    typeof row.requested_at === "string",
                )
                .sort((a, b) => Number(a.checkpoint_turn_count) - Number(b.checkpoint_turn_count))
                .at(0)?.requested_at;
              const retainedMessageIds = new Set<string>();
              for (const turn of retainedTurns) {
                if (typeof turn.pending_message_id === "string")
                  retainedMessageIds.add(turn.pending_message_id);
                if (typeof turn.assistant_message_id === "string")
                  retainedMessageIds.add(turn.assistant_message_id);
              }
              for (const message of archiveRows.projection_thread_messages) {
                if (typeof message.message_id !== "string") continue;
                if (
                  message.role === "system" ||
                  isImportedAgentSessionMessageId(message.message_id) ||
                  retainedTurnIds.has(String(message.turn_id))
                ) {
                  retainedMessageIds.add(message.message_id);
                }
              }
              for (const role of ["user", "assistant"] as const) {
                const retainedCount = archiveRows.projection_thread_messages.filter(
                  (message) =>
                    message.role === role &&
                    typeof message.message_id === "string" &&
                    !isImportedAgentSessionMessageId(message.message_id) &&
                    retainedMessageIds.has(message.message_id),
                ).length;
                const missing = Math.max(0, turnCount - retainedCount);
                const fallback = archiveRows.projection_thread_messages
                  .filter(
                    (message) =>
                      message.role === role &&
                      typeof message.message_id === "string" &&
                      !retainedMessageIds.has(message.message_id) &&
                      (message.turn_id === null || retainedTurnIds.has(String(message.turn_id))),
                  )
                  .toSorted(
                    (a, b) =>
                      String(a.created_at).localeCompare(String(b.created_at)) ||
                      String(a.message_id).localeCompare(String(b.message_id)),
                  )
                  .slice(0, missing);
                for (const message of fallback) retainedMessageIds.add(String(message.message_id));
              }
              const keyedTables = [
                ["projection_thread_messages", "message_id"],
                ["projection_thread_activities", "activity_id"],
                ["projection_thread_proposed_plans", "plan_id"],
              ] as const;
              for (const [table] of keyedTables) {
                yield* sql.unsafe(`DELETE FROM ${table} WHERE thread_id = ?`, [forkThreadId]);
              }
              yield* sql.unsafe("DELETE FROM projection_turns WHERE thread_id = ?", [forkThreadId]);
              const forkId = (id: string) => `${forkThreadId}:${id}`;
              const copyRows = (
                table: ProjectionTable,
                rows: ReadonlyArray<ProjectionRow>,
                key?: "message_id" | "activity_id" | "plan_id",
              ) =>
                Effect.forEach(
                  rows,
                  (original) => {
                    const row: ProjectionRow = { ...original, thread_id: forkThreadId };
                    if (key && typeof row[key] === "string") row[key] = forkId(row[key]);
                    if (typeof row.turn_id === "string") row.turn_id = forkId(row.turn_id);
                    if (typeof row.pending_message_id === "string")
                      row.pending_message_id = forkId(row.pending_message_id);
                    if (typeof row.assistant_message_id === "string")
                      row.assistant_message_id = forkId(row.assistant_message_id);
                    if (typeof row.checkpoint_ref === "string") {
                      row.checkpoint_ref =
                        checkpointRefMap[row.checkpoint_ref] ?? row.checkpoint_ref;
                    }
                    const columns = Object.keys(row);
                    const names = columns.map((column) => `"${column}"`).join(", ");
                    const placeholders = columns.map(() => "?").join(", ");
                    return sql.unsafe(
                      `INSERT INTO ${table} (${names}) VALUES (${placeholders})`,
                      columns.map((column) => row[column]),
                    );
                  },
                  { concurrency: 1 },
                ).pipe(Effect.asVoid);
              yield* copyRows("projection_turns", retainedTurns);
              for (const [table, key] of keyedTables) {
                const rows = archiveRows[table].filter((row) =>
                  table === "projection_thread_messages"
                    ? retainedMessageIds.has(String(row.message_id))
                    : retainedTurnIds.has(String(row.turn_id)) ||
                      (row.turn_id === null &&
                        (typeof firstRemovedAt !== "string" ||
                          (typeof row.created_at === "string" && row.created_at < firstRemovedAt))),
                );
                yield* copyRows(table, rows, key);
              }
              const latestTurn = retainedTurns
                .filter((row) => typeof row.turn_id === "string")
                .sort((a, b) => Number(a.checkpoint_turn_count) - Number(b.checkpoint_turn_count))
                .at(-1)?.turn_id;
              yield* sql.unsafe(
                "UPDATE projection_threads SET latest_turn_id = ? WHERE thread_id = ?",
                [typeof latestTurn === "string" ? forkId(latestTurn) : null, forkThreadId],
              );
            }),
          ),
        ),
        Effect.mapError(
          toPersistenceSqlError("ThreadHistoryArchiveRepository.restoreForkProjectionRows"),
        ),
      ),
  } satisfies ThreadHistoryArchiveRepositoryShape;
});

export const layer = Layer.effect(ThreadHistoryArchiveRepository, make);
