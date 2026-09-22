import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE skill_session_overlays (
    thread_id TEXT NOT NULL,
    provider_instance_id TEXT NOT NULL,
    skill_key TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    PRIMARY KEY (thread_id, provider_instance_id, skill_key)
  )`;
  yield* sql`CREATE TABLE skill_catalog_revision (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO skill_catalog_revision (id, revision) VALUES (1, 0)`;
});
