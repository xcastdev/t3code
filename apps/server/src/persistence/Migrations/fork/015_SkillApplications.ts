import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE projection_skill_applications (
    thread_id TEXT NOT NULL,
    provider_instance_id TEXT NOT NULL,
    application_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, provider_instance_id)
  )`;
});
