import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_work_verification_jobs (
    environment_id TEXT NOT NULL CHECK(typeof(environment_id)='text' AND length(environment_id) BETWEEN 1 AND 256),
    job_id TEXT NOT NULL CHECK(typeof(job_id)='text' AND length(job_id) BETWEEN 1 AND 256),
    project_id TEXT NOT NULL CHECK(typeof(project_id)='text' AND length(project_id) BETWEEN 1 AND 256),
    task_id TEXT NOT NULL CHECK(typeof(task_id)='text' AND length(task_id) BETWEEN 1 AND 256),
    manifest_json TEXT NOT NULL CHECK(typeof(manifest_json)='text' AND length(CAST(manifest_json AS BLOB)) BETWEEN 1 AND 65536 AND json_valid(manifest_json)),
    sha256 TEXT NOT NULL CHECK(typeof(sha256)='text' AND length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
    PRIMARY KEY(environment_id,job_id)
  )`;
  yield* sql`CREATE TRIGGER project_work_verification_jobs_first_winner BEFORE INSERT ON project_work_verification_jobs
    WHEN EXISTS(SELECT 1 FROM project_work_verification_jobs WHERE environment_id=NEW.environment_id AND job_id=NEW.job_id)
    BEGIN SELECT RAISE(IGNORE); END`;
  yield* sql`CREATE TRIGGER project_work_verification_jobs_immutable BEFORE UPDATE ON project_work_verification_jobs
    BEGIN SELECT RAISE(ABORT,'Prepared verification manifest cannot change'); END`;
});
