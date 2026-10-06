import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Raw retention is independent of evidence qualification and never grants delivery authority. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_work_artifacts (
    environment_id TEXT NOT NULL CHECK(length(environment_id) BETWEEN 1 AND 256),
    artifact_id TEXT NOT NULL CHECK(length(artifact_id) BETWEEN 1 AND 256),
    project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 256),
    task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 1 AND 256),
    source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 256),
    manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json) AND length(CAST(manifest_json AS BLOB)) BETWEEN 1 AND 65536),
    sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    byte_count INTEGER NOT NULL CHECK(typeof(byte_count)='integer' AND byte_count BETWEEN 0 AND 1048576),
    raw_bytes BLOB NOT NULL CHECK(typeof(raw_bytes)='blob' AND length(raw_bytes)=byte_count),
    PRIMARY KEY(environment_id,artifact_id)
  )`;
  yield* sql`CREATE INDEX project_work_artifacts_task ON project_work_artifacts(environment_id,project_id,task_id)`;
  yield* sql`CREATE TRIGGER project_work_artifacts_first_winner BEFORE INSERT ON project_work_artifacts
    WHEN EXISTS(SELECT 1 FROM project_work_artifacts WHERE environment_id=NEW.environment_id AND artifact_id=NEW.artifact_id)
    BEGIN SELECT RAISE(IGNORE); END`;
  yield* sql`CREATE TRIGGER project_work_artifacts_immutable BEFORE UPDATE ON project_work_artifacts
    BEGIN SELECT RAISE(ABORT,'Retained artifact cannot change'); END`;
});
