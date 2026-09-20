import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Derived reducer checkpoints avoid replaying a large aggregate for every
 * ordinary write. The append-only event log remains authoritative. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_work_reducer_checkpoints (
      project_id TEXT PRIMARY KEY,
      last_sequence INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
