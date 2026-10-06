import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Preserve the host's initial native snapshot independently of subsequent session appends. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_team_review_freshness (
    operation_id TEXT PRIMARY KEY NOT NULL REFERENCES project_team_pi_operation(operation_id) ON DELETE CASCADE,
    environment_id TEXT NOT NULL CHECK(length(environment_id) BETWEEN 1 AND 256),
    project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 256),
    binding_id TEXT NOT NULL CHECK(length(binding_id) BETWEEN 1 AND 256),
    generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991),
    provider_instance_id TEXT NOT NULL CHECK(length(provider_instance_id) BETWEEN 1 AND 256),
    thread_id TEXT NOT NULL CHECK(length(thread_id) BETWEEN 1 AND 256),
    session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
    manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json) AND length(CAST(manifest_json AS BLOB)) <= 32768),
    native_jsonl TEXT NOT NULL CHECK(length(CAST(native_jsonl AS BLOB)) BETWEEN 1 AND 4194304)
  )`;
  yield* sql`CREATE INDEX project_team_review_freshness_session
    ON project_team_review_freshness(environment_id,provider_instance_id,thread_id,session_id)`;
  yield* sql`CREATE TRIGGER project_team_review_freshness_first_winner BEFORE INSERT ON project_team_review_freshness
    WHEN EXISTS(SELECT 1 FROM project_team_review_freshness WHERE operation_id=NEW.operation_id)
    BEGIN SELECT RAISE(IGNORE); END`;
  yield* sql`CREATE TRIGGER project_team_review_freshness_immutable BEFORE UPDATE ON project_team_review_freshness
    WHEN NEW.operation_id<>OLD.operation_id OR NEW.environment_id<>OLD.environment_id OR
      NEW.project_id<>OLD.project_id OR NEW.binding_id<>OLD.binding_id OR
      NEW.generation<>OLD.generation OR NEW.provider_instance_id<>OLD.provider_instance_id OR
      NEW.thread_id<>OLD.thread_id OR NEW.session_id<>OLD.session_id OR
      NEW.manifest_json<>OLD.manifest_json OR NEW.native_jsonl<>OLD.native_jsonl
    BEGIN SELECT RAISE(ABORT,'Original review freshness receipt cannot change'); END`;
});
