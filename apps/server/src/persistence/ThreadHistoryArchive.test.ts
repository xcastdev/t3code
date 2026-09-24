import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import {
  ThreadHistoryArchiveRepository,
  layer as repositoryLayer,
  type ThreadHistoryArchiveRecord,
} from "./ThreadHistoryArchive.ts";

const database = NodeSqliteClient.layerMemory();
const testLayer = Layer.provide(repositoryLayer, database);

describe("ThreadHistoryArchiveRepository", () => {
  it.effect("stores immutable archives and scopes lookup to the owning thread", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const repository = yield* ThreadHistoryArchiveRepository;
      const first: ThreadHistoryArchiveRecord = {
        archiveId: "archive-1",
        threadId: "thread-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        turnCount: 2,
        snapshotJson: '{"messages":["original"]}',
        providerBindingJson: '{"sessionId":"provider-original"}',
        projectionRowsJson: "{}",
      };
      yield* repository.insert(first);
      yield* repository.insert({
        ...first,
        archiveId: "archive-2",
        createdAt: "2026-01-02T00:00:00.000Z",
        turnCount: 3,
        snapshotJson: '{"messages":["later"]}',
      });
      yield* repository.insert({ ...first, archiveId: "archive-other", threadId: "thread-2" });

      expect(yield* repository.listByThread("thread-1")).toEqual([
        {
          archiveId: "archive-2",
          threadId: "thread-1",
          createdAt: "2026-01-02T00:00:00.000Z",
          turnCount: 3,
        },
        {
          archiveId: "archive-1",
          threadId: "thread-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          turnCount: 2,
        },
      ]);
      expect(yield* repository.get("thread-1", "archive-1")).toEqual(first);
      expect(yield* repository.get("thread-2", "archive-1")).toBeUndefined();
      expect(
        yield* repository.insert({ ...first, snapshotJson: "{}" }).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "PersistenceSqlError",
      });
      expect(yield* repository.get("thread-1", "archive-1")).toEqual(first);
      yield* repository.deleteByThread("thread-1");
      expect(yield* repository.listByThread("thread-1")).toEqual([]);
      expect(yield* repository.get("thread-2", "archive-other")).toBeDefined();
    }).pipe(Effect.provide(Layer.mergeAll(database, testLayer))),
  );

  it.effect("restores raw turn metadata and replaces newer projection rows", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const repository = yield* ThreadHistoryArchiveRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, created_at, updated_at
        ) VALUES (
          'thread-history', 'project', 'Before', '{"provider":"codex","model":"gpt-6"}',
          '2026-01-01', '2026-01-01'
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, checkpoint_turn_count,
          checkpoint_ref, checkpoint_status, checkpoint_files_json
        ) VALUES (
          'thread-history', 'turn-1', 'completed', '2026-01-01', 1,
          'active-ref', 'captured', '["src/a.ts"]'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_session_id, updated_at
        ) VALUES ('thread-history', 'stopped', 'codex', 'old-session', '2026-01-01')
      `;
      const archived = yield* repository.captureProjectionRows("thread-history", {
        "active-ref": "archive-ref",
      });
      yield* sql`UPDATE projection_threads SET title = 'After' WHERE thread_id = 'thread-history'`;
      yield* sql`UPDATE projection_thread_sessions
        SET status = 'running', provider_session_id = 'new-session', updated_at = '2026-01-02'
        WHERE thread_id = 'thread-history'`;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, checkpoint_turn_count,
          checkpoint_ref, checkpoint_status, checkpoint_files_json
        ) VALUES (
          'thread-history', 'turn-2', 'completed', '2026-01-02', 2,
          'later-ref', 'captured', '[]'
        )
      `;
      yield* repository.restoreProjectionRows("thread-history", archived, {
        "archive-ref": "restored-active-ref",
      });
      const turns = yield* sql<{
        turn_id: string;
        checkpoint_ref: string;
        checkpoint_files_json: string;
        row_id: number;
      }>`SELECT turn_id, checkpoint_ref, checkpoint_files_json, row_id
        FROM projection_turns WHERE thread_id = 'thread-history'`;
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        turn_id: "turn-1",
        checkpoint_ref: "restored-active-ref",
        checkpoint_files_json: '["src/a.ts"]',
      });
      const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(archived);
      expect(decoded).toMatchObject({
        projection_turns: [expect.not.objectContaining({ row_id: expect.anything() })],
      });
      const threads = yield* sql<{ title: string }>`SELECT title FROM projection_threads
        WHERE thread_id = 'thread-history'`;
      expect(threads[0]?.title).toBe("Before");
      const sessions = yield* sql<{ status: string; provider_session_id: string }>`
        SELECT status, provider_session_id FROM projection_thread_sessions
        WHERE thread_id = 'thread-history'
      `;
      expect(sessions[0]).toMatchObject({
        status: "running",
        provider_session_id: "new-session",
      });
    }).pipe(Effect.provide(Layer.mergeAll(database, testLayer))),
  );

  it.effect("copies a retained path into a new thread with distinct row identities", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const repository = yield* ThreadHistoryArchiveRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, created_at, updated_at)
        VALUES ('source-fork', 'project', 'Source', '{"provider":"codex","model":"gpt-6"}',
          '2026-01-01', '2026-01-01')`;
      yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, created_at, updated_at)
        VALUES ('fork-copy', 'project', 'Fork', '{"provider":"codex","model":"gpt-6"}',
          '2026-01-01', '2026-01-01')`;
      yield* sql`INSERT INTO projection_turns
        (thread_id, turn_id, state, requested_at, checkpoint_turn_count, checkpoint_ref, checkpoint_files_json)
        VALUES ('source-fork', 'turn-a', 'completed', '2026-01-01', 1, 'ref-a', '[]'),
          ('source-fork', 'turn-b', 'completed', '2026-01-02', 2, 'ref-b', '[]')`;
      yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('message-a', 'source-fork', 'turn-a', 'user', 'first', 0, '2026-01-01', '2026-01-01'),
          ('message-b', 'source-fork', 'turn-b', 'user', 'second', 0, '2026-01-02', '2026-01-02')`;
      const archived = yield* repository.captureProjectionRows("source-fork");
      yield* repository.restoreForkProjectionRows("source-fork", "fork-copy", archived, 1, {
        "ref-a": "fork-ref-a",
      });
      const copied = yield* sql<{ message_id: string; turn_id: string; text: string }>`
        SELECT message_id, turn_id, text FROM projection_thread_messages
        WHERE thread_id = 'fork-copy'`;
      expect(copied).toEqual([
        { message_id: "fork-copy:message-a", turn_id: "fork-copy:turn-a", text: "first" },
      ]);
      const turns = yield* sql<{ turn_id: string; checkpoint_ref: string }>`
        SELECT turn_id, checkpoint_ref FROM projection_turns WHERE thread_id = 'fork-copy'`;
      expect(turns).toEqual([{ turn_id: "fork-copy:turn-a", checkpoint_ref: "fork-ref-a" }]);
      const source = yield* sql<{
        message_id: string;
      }>`SELECT message_id FROM projection_thread_messages
        WHERE thread_id = 'source-fork' ORDER BY message_id`;
      expect(source.map((row) => row.message_id)).toEqual(["message-a", "message-b"]);
    }).pipe(Effect.provide(Layer.mergeAll(database, testLayer))),
  );
});
