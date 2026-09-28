import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_activities)
  `;

  if (!columns.some((column) => column.name === "agent_key")) {
    yield* sql`ALTER TABLE projection_thread_activities ADD COLUMN agent_key TEXT`;
  }
  if (!columns.some((column) => column.name === "event_sequence")) {
    yield* sql`ALTER TABLE projection_thread_activities ADD COLUMN event_sequence INTEGER`;
  }
  if (!columns.some((column) => column.name === "first_event_sequence")) {
    yield* sql`ALTER TABLE projection_thread_activities ADD COLUMN first_event_sequence INTEGER`;
  }

  // Upserts refresh event_sequence for live deltas. Keep the original position
  // separately so a page cursor cannot jump past an older row after an update.
  yield* sql`
    UPDATE projection_thread_activities
    SET first_event_sequence = event_sequence
    WHERE first_event_sequence IS NULL AND event_sequence IS NOT NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_agent_event
    ON projection_thread_activities(thread_id, agent_key, first_event_sequence, activity_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_agent_kind_event
    ON projection_thread_activities(thread_id, agent_key, kind, first_event_sequence, activity_id)
  `;
});
