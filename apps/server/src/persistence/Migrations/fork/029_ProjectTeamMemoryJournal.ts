import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Physical cleanup knowledge survives removal of its authoritative project/source. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_team_memory_manifest (
    extraction_id TEXT PRIMARY KEY NOT NULL CHECK(length(extraction_id) BETWEEN 1 AND 256),
    environment_id TEXT NOT NULL CHECK(length(environment_id) BETWEEN 1 AND 256),
    project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 256),
    source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 256),
    source_revision INTEGER NOT NULL CHECK(typeof(source_revision)='integer'
      AND source_revision BETWEEN 0 AND 9007199254740991),
    source_generation INTEGER NOT NULL CHECK(typeof(source_generation)='integer'
      AND source_generation BETWEEN 0 AND 9007199254740991),
    manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)
      AND length(CAST(manifest_json AS BLOB)) <= 4194304)
  )`;
  yield* sql`CREATE TRIGGER project_team_memory_manifest_immutable
    BEFORE UPDATE ON project_team_memory_manifest WHEN
      NEW.extraction_id <> OLD.extraction_id OR NEW.environment_id <> OLD.environment_id
      OR NEW.project_id <> OLD.project_id OR NEW.source_id <> OLD.source_id
      OR NEW.source_revision <> OLD.source_revision OR NEW.source_generation <> OLD.source_generation
      OR NEW.manifest_json <> OLD.manifest_json
    BEGIN SELECT RAISE(ABORT,'Prepared memory manifest cannot change'); END`;
  yield* sql`CREATE TABLE project_team_memory_job (
    effect_id TEXT PRIMARY KEY NOT NULL CHECK(length(effect_id) BETWEEN 1 AND 256),
    environment_id TEXT NOT NULL CHECK(length(environment_id) BETWEEN 1 AND 256),
    project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 256),
    input_json TEXT NOT NULL CHECK(json_valid(input_json)
      AND length(CAST(input_json AS BLOB)) <= 262144),
    claim_generation INTEGER NOT NULL DEFAULT 0 CHECK(typeof(claim_generation)='integer'
      AND claim_generation BETWEEN 0 AND 9007199254740991),
    status TEXT NOT NULL CHECK(status IN ('pending','claimed','uncertain','settled')),
    receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json)
      AND length(CAST(receipt_json AS BLOB)) <= 262144)),
    CHECK((status='pending' AND claim_generation=0 AND receipt_json IS NULL)
      OR (status IN ('claimed','uncertain') AND claim_generation>0 AND receipt_json IS NULL)
      OR (status='settled' AND claim_generation>0 AND receipt_json IS NOT NULL))
  )`;
  yield* sql`CREATE TRIGGER project_team_memory_job_identity_immutable
    BEFORE UPDATE ON project_team_memory_job WHEN
      NEW.effect_id <> OLD.effect_id OR NEW.environment_id <> OLD.environment_id
      OR NEW.project_id <> OLD.project_id OR NEW.input_json <> OLD.input_json
    BEGIN SELECT RAISE(ABORT,'Original memory job input cannot change'); END`;
  yield* sql`CREATE TRIGGER project_team_memory_job_transition
    BEFORE UPDATE ON project_team_memory_job WHEN NOT (
      (NEW.status=OLD.status AND NEW.claim_generation=OLD.claim_generation
        AND NEW.receipt_json IS OLD.receipt_json)
      OR (OLD.status IN ('pending','claimed','uncertain') AND NEW.status='claimed'
        AND NEW.claim_generation=OLD.claim_generation+1 AND NEW.receipt_json IS NULL)
      OR (OLD.status='claimed' AND NEW.status='uncertain'
        AND NEW.claim_generation=OLD.claim_generation AND NEW.receipt_json IS NULL)
      OR (OLD.status='claimed' AND NEW.status='settled'
        AND NEW.claim_generation=OLD.claim_generation AND NEW.receipt_json IS NOT NULL)
    )
    BEGIN SELECT RAISE(ABORT,'Memory job ownership or receipt cannot regress'); END`;
  yield* sql`CREATE INDEX project_team_memory_job_pending
    ON project_team_memory_job(environment_id,status,effect_id)`;
  yield* sql`CREATE INDEX project_team_memory_manifest_source
    ON project_team_memory_manifest(environment_id,project_id,source_id,extraction_id)`;
});
