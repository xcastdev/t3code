import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Supports bounded, deadline-ordered lease sweeps without scanning terminal history. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_work_attempts_active_lease_due
    ON project_work_attempts(leased_until, attempt_id, project_id, task_id)
    WHERE state IN ('leased', 'running') AND leased_until IS NOT NULL
  `;
});
