import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Denial survives project/history deletion; this marker never grants run authority.
  yield* sql`CREATE TABLE project_team_identity_fences (
    provider_instance_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    PRIMARY KEY (provider_instance_id, thread_id)
  )`;
  yield* sql`CREATE INDEX project_team_identity_fences_thread_id_idx
    ON project_team_identity_fences (thread_id)`;
});
