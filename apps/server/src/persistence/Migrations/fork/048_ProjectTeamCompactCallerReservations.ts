import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** A caller owns the gap before its compact operation can be prepared. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_team_compact_caller (
    environment_id TEXT NOT NULL,
    dispatch_id TEXT NOT NULL REFERENCES project_team_dispatch(dispatch_id) ON DELETE CASCADE,
    binding_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation>=0),
    provider_instance_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_json TEXT NOT NULL CHECK(length(CAST(request_json AS BLOB))<=65536),
    predecessor_operation_id TEXT NOT NULL,
    authority_json TEXT NOT NULL CHECK(length(CAST(authority_json AS BLOB))<=65536),
    admission_revision INTEGER NOT NULL CHECK(admission_revision>=0),
    claim_generation INTEGER NOT NULL CHECK(claim_generation>0),
    deadline_at_ms INTEGER NOT NULL CHECK(deadline_at_ms>0),
    status TEXT NOT NULL CHECK(status IN ('pending','consumed','released')),
    operation_id TEXT REFERENCES project_team_pi_operation(operation_id) ON DELETE CASCADE,
    PRIMARY KEY(environment_id,binding_id,generation,request_id),
    CHECK((status='consumed' AND operation_id IS NOT NULL) OR (status<>'consumed' AND operation_id IS NULL))
  )`;
  yield* sql`CREATE UNIQUE INDEX project_team_compact_caller_pending
    ON project_team_compact_caller(environment_id,binding_id,generation) WHERE status='pending'`;
  yield* sql`CREATE TRIGGER project_team_compact_caller_insert BEFORE INSERT ON project_team_compact_caller
    WHEN NEW.status<>'pending' OR NOT EXISTS (
      SELECT 1 FROM project_team_dispatch d WHERE d.dispatch_id=NEW.dispatch_id
      AND d.environment_id=NEW.environment_id AND d.binding_id=NEW.binding_id AND d.generation=NEW.generation
      AND d.cleanup_claim_revision IS NULL AND d.revision=NEW.admission_revision
      AND d.claim_generation=NEW.claim_generation AND d.stage IN ('assignment-intent','assignment-observed'))
      OR (SELECT COUNT(*) FROM project_team_compact_caller c WHERE c.environment_id=NEW.environment_id
        AND c.binding_id=NEW.binding_id AND c.generation=NEW.generation)>=130
    BEGIN SELECT RAISE(ABORT,'Compact caller requires open current dispatch and bounded history'); END`;
  yield* sql`CREATE TRIGGER project_team_compact_caller_immutable BEFORE UPDATE ON project_team_compact_caller
    WHEN NEW.environment_id IS NOT OLD.environment_id OR NEW.dispatch_id IS NOT OLD.dispatch_id
      OR NEW.binding_id IS NOT OLD.binding_id OR NEW.generation IS NOT OLD.generation
      OR NEW.provider_instance_id IS NOT OLD.provider_instance_id OR NEW.thread_id IS NOT OLD.thread_id
      OR NEW.request_id IS NOT OLD.request_id OR NEW.request_json IS NOT OLD.request_json
      OR NEW.predecessor_operation_id IS NOT OLD.predecessor_operation_id OR NEW.authority_json IS NOT OLD.authority_json
      OR NEW.admission_revision IS NOT OLD.admission_revision OR NEW.claim_generation IS NOT OLD.claim_generation
      OR NEW.deadline_at_ms IS NOT OLD.deadline_at_ms OR OLD.status<>'pending'
      OR NEW.status NOT IN ('consumed','released')
    BEGIN SELECT RAISE(ABORT,'Compact caller identity and terminal status are immutable'); END`;
  yield* sql`CREATE TRIGGER project_team_dispatch_compact_caller_cleanup BEFORE UPDATE ON project_team_dispatch
    WHEN OLD.cleanup_claim_revision IS NULL AND NEW.cleanup_claim_revision IS NOT NULL AND EXISTS (
      SELECT 1 FROM project_team_compact_caller c WHERE c.environment_id=OLD.environment_id
      AND c.binding_id=OLD.binding_id AND c.generation=OLD.generation AND c.status='pending')
    BEGIN SELECT RAISE(ABORT,'Pending compact caller owns cleanup boundary'); END`;
});
