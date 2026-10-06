import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_work_verification_execution (
    environment_id TEXT NOT NULL CHECK(typeof(environment_id)='text' AND length(environment_id) BETWEEN 1 AND 256),
    job_id TEXT NOT NULL CHECK(typeof(job_id)='text' AND length(job_id) BETWEEN 1 AND 256),
    project_id TEXT NOT NULL CHECK(typeof(project_id)='text' AND length(project_id) BETWEEN 1 AND 256),
    task_id TEXT NOT NULL CHECK(typeof(task_id)='text' AND length(task_id) BETWEEN 1 AND 256),
    attempt_id TEXT NOT NULL UNIQUE CHECK(typeof(attempt_id)='text' AND length(attempt_id) BETWEEN 1 AND 256),
    manifest_hash TEXT NOT NULL CHECK(typeof(manifest_hash)='text' AND length(manifest_hash)=64 AND manifest_hash NOT GLOB '*[^a-f0-9]*'),
    gate_id TEXT NOT NULL CHECK(typeof(gate_id)='text' AND length(gate_id) BETWEEN 1 AND 256),
    gate_revision INTEGER NOT NULL CHECK(typeof(gate_revision)='integer' AND gate_revision BETWEEN 0 AND 9007199254740991),
    intent_json TEXT NOT NULL CHECK(typeof(intent_json)='text' AND length(CAST(intent_json AS BLOB)) BETWEEN 1 AND 262144 AND json_valid(intent_json)),
    intent_hash TEXT NOT NULL CHECK(typeof(intent_hash)='text' AND length(intent_hash)=64 AND intent_hash NOT GLOB '*[^a-f0-9]*'),
    allocation_hash TEXT NOT NULL CHECK(typeof(allocation_hash)='text' AND length(allocation_hash)=64 AND allocation_hash NOT GLOB '*[^a-f0-9]*'),
    deadline_at_ms INTEGER NOT NULL CHECK(typeof(deadline_at_ms)='integer' AND deadline_at_ms BETWEEN 0 AND 9007199254740991),
    phase TEXT NOT NULL CHECK(phase IN ('claimed','activating','owner-captured','terminal','quarantine')),
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
    owner_json TEXT CHECK(owner_json IS NULL OR (typeof(owner_json)='text' AND length(CAST(owner_json AS BLOB)) BETWEEN 1 AND 16384 AND json_valid(owner_json))),
    result_json TEXT CHECK(result_json IS NULL OR (typeof(result_json)='text' AND length(CAST(result_json AS BLOB)) BETWEEN 1 AND 65536 AND json_valid(result_json))),
    result_hash TEXT CHECK(result_hash IS NULL OR (typeof(result_hash)='text' AND length(result_hash)=64 AND result_hash NOT GLOB '*[^a-f0-9]*')),
    reason TEXT CHECK(reason IS NULL OR (typeof(reason)='text' AND length(CAST(reason AS BLOB)) BETWEEN 1 AND 4096)),
    CHECK((result_json IS NULL) = (result_hash IS NULL)),
    CHECK((phase='terminal') = (result_json IS NOT NULL)),
    CHECK(phase!='owner-captured' OR owner_json IS NOT NULL),
    PRIMARY KEY(environment_id,job_id)
  )`;
  yield* sql`CREATE INDEX project_work_verification_execution_recovery
    ON project_work_verification_execution(environment_id,phase)`;
  yield* sql`CREATE TRIGGER project_work_verification_execution_first_winner
    BEFORE INSERT ON project_work_verification_execution
    WHEN EXISTS(SELECT 1 FROM project_work_verification_execution
      WHERE environment_id=NEW.environment_id AND job_id=NEW.job_id)
    BEGIN SELECT RAISE(IGNORE); END`;
  yield* sql`CREATE TRIGGER project_work_verification_execution_initial
    BEFORE INSERT ON project_work_verification_execution
    WHEN NEW.phase!='claimed' OR NEW.revision!=0 OR NEW.owner_json IS NOT NULL
      OR NEW.result_json IS NOT NULL OR NEW.result_hash IS NOT NULL OR NEW.reason IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'Verification execution must begin with one unactivated claim'); END`;
  yield* sql`CREATE TRIGGER project_work_verification_execution_intent_immutable
    BEFORE UPDATE ON project_work_verification_execution
    WHEN OLD.environment_id IS NOT NEW.environment_id OR OLD.job_id IS NOT NEW.job_id
      OR OLD.project_id IS NOT NEW.project_id OR OLD.task_id IS NOT NEW.task_id
      OR OLD.attempt_id IS NOT NEW.attempt_id OR OLD.manifest_hash IS NOT NEW.manifest_hash
      OR OLD.gate_id IS NOT NEW.gate_id OR OLD.gate_revision IS NOT NEW.gate_revision
      OR OLD.intent_json IS NOT NEW.intent_json OR OLD.intent_hash IS NOT NEW.intent_hash
      OR OLD.allocation_hash IS NOT NEW.allocation_hash OR OLD.deadline_at_ms IS NOT NEW.deadline_at_ms
    BEGIN SELECT RAISE(ABORT,'Verification execution intent cannot change'); END`;
  yield* sql`CREATE TRIGGER project_work_verification_execution_progress
    BEFORE UPDATE ON project_work_verification_execution
    WHEN (
      OLD.phase IS NOT NEW.phase OR OLD.owner_json IS NOT NEW.owner_json
      OR OLD.result_json IS NOT NEW.result_json OR OLD.result_hash IS NOT NEW.result_hash
      OR OLD.reason IS NOT NEW.reason OR OLD.revision IS NOT NEW.revision
    ) AND (
      NEW.revision!=OLD.revision+1 OR OLD.phase='terminal'
      OR (OLD.owner_json IS NOT NULL AND OLD.owner_json IS NOT NEW.owner_json)
      OR (OLD.phase='quarantine' AND OLD.reason IS NOT NEW.reason)
      OR NOT (
        NEW.phase=OLD.phase
        OR (OLD.phase='claimed' AND NEW.phase IN ('activating','terminal','quarantine'))
        OR (OLD.phase='activating' AND NEW.phase IN ('owner-captured','terminal','quarantine'))
        OR (OLD.phase='owner-captured' AND NEW.phase IN ('terminal','quarantine'))
        OR (OLD.phase='quarantine' AND NEW.phase='terminal')
      )
    )
    BEGIN SELECT RAISE(ABORT,'Verification execution progress cannot replace its owner or result'); END`;
});
