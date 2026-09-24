import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_history_archives (
    archive_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    turn_count INTEGER NOT NULL CHECK (turn_count >= 0),
    snapshot_json TEXT NOT NULL,
    provider_binding_json TEXT NOT NULL,
    projection_rows_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX idx_thread_history_archives_thread_created
    ON thread_history_archives (thread_id, created_at DESC, archive_id DESC)`;
});
