import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS terminal_completion_wakes (
      dedupe_key TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      terminal_id TEXT NOT NULL,
      generation TEXT NOT NULL,
      server_run_id TEXT NOT NULL,
      label TEXT NOT NULL,
      exit_status TEXT NOT NULL CHECK (exit_status IN ('exited', 'killed')),
      exit_code INTEGER,
      exit_signal INTEGER,
      delivery_status TEXT NOT NULL CHECK (
        delivery_status IN ('pending', 'claimed', 'delivered', 'canceled', 'unknown')
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_terminal_completion_wakes_thread_status
    ON terminal_completion_wakes (thread_id, delivery_status, created_at, dedupe_key)
  `;
  const turnColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_turns)
  `;
  if (!turnColumns.some((column) => column.name === "pending_terminal_completion_wake_key")) {
    yield* sql.unsafe(
      "ALTER TABLE projection_turns ADD COLUMN pending_terminal_completion_wake_key TEXT",
    );
  }
});
