import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** These ownership journals are authoritative; projection replay cannot recreate or clear them. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_team_dispatch (
    dispatch_id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    binding_id TEXT NOT NULL UNIQUE,
    generation INTEGER NOT NULL CHECK(generation >= 0),
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL UNIQUE,
    worktree TEXT NOT NULL,
    branch TEXT NOT NULL,
    root_task_id TEXT NOT NULL,
    root_maximum_tokens INTEGER NOT NULL CHECK(root_maximum_tokens > 0),
    root_deadline_at_ms INTEGER NOT NULL CHECK(root_deadline_at_ms > 0),
    attempt_maximum_tokens INTEGER NOT NULL CHECK(attempt_maximum_tokens > 0
      AND attempt_maximum_tokens <= root_maximum_tokens),
    attempt_deadline_at_ms INTEGER NOT NULL CHECK(attempt_deadline_at_ms > 0
      AND attempt_deadline_at_ms <= root_deadline_at_ms),
    delegation_depth INTEGER NOT NULL CHECK(delegation_depth >= 0),
    maximum_delegation_depth INTEGER NOT NULL CHECK(maximum_delegation_depth BETWEEN 0 AND 8
      AND delegation_depth <= maximum_delegation_depth),
    repair_allowance INTEGER NOT NULL CHECK(repair_allowance BETWEEN 0 AND 16),
    stage TEXT NOT NULL CHECK(stage IN ('reserved','workspace-ready','setup-complete',
      'session-bound','assignment-intent','assignment-observed','stopping','settled','quarantine')),
    revision INTEGER NOT NULL CHECK(revision >= 0),
    claim_generation INTEGER NOT NULL CHECK(claim_generation >= 0),
    intent_json TEXT NOT NULL CHECK(json_valid(intent_json)
      AND length(CAST(intent_json AS BLOB)) <= 262144),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(environment_id,project_id,root_task_id)
      REFERENCES project_team_model_budget(environment_id,project_id,root_task_id)
      DEFERRABLE INITIALLY DEFERRED
  )`;
  yield* sql`CREATE UNIQUE INDEX project_team_dispatch_workspace_owner
    ON project_team_dispatch(environment_id,worktree) WHERE stage <> 'settled'`;
  yield* sql`CREATE INDEX project_team_dispatch_recovery
    ON project_team_dispatch(environment_id,stage,dispatch_id)`;
  // Cleanup ownership survives removal of the project's replayable binding projection.
  yield* sql`CREATE TRIGGER project_team_dispatch_binding_required
    BEFORE INSERT ON project_team_dispatch WHEN NOT EXISTS (
      SELECT 1 FROM project_team_run_binding WHERE record_id=NEW.binding_id
        AND project_id=NEW.project_id AND generation=NEW.generation)
    BEGIN SELECT RAISE(ABORT,'Dispatch requires its exact committed binding'); END`;
  yield* sql`CREATE TRIGGER project_team_dispatch_immutable
    BEFORE UPDATE ON project_team_dispatch WHEN
      NEW.dispatch_id <> OLD.dispatch_id OR NEW.environment_id <> OLD.environment_id OR
      NEW.project_id <> OLD.project_id OR NEW.binding_id <> OLD.binding_id OR
      NEW.generation <> OLD.generation OR NEW.task_id <> OLD.task_id OR
      NEW.attempt_id <> OLD.attempt_id OR NEW.worktree <> OLD.worktree OR
      NEW.branch <> OLD.branch OR NEW.root_task_id <> OLD.root_task_id OR
      NEW.root_maximum_tokens <> OLD.root_maximum_tokens OR
      NEW.root_deadline_at_ms <> OLD.root_deadline_at_ms OR
      NEW.attempt_maximum_tokens <> OLD.attempt_maximum_tokens OR
      NEW.attempt_deadline_at_ms <> OLD.attempt_deadline_at_ms OR
      NEW.delegation_depth <> OLD.delegation_depth OR
      NEW.maximum_delegation_depth <> OLD.maximum_delegation_depth OR
      NEW.repair_allowance <> OLD.repair_allowance OR
      NEW.intent_json <> OLD.intent_json OR NEW.created_at <> OLD.created_at
    BEGIN SELECT RAISE(ABORT,'Frozen dispatch identity and limits cannot change'); END`;
  yield* sql`CREATE TABLE project_team_dispatch_receipt (
    receipt_id TEXT PRIMARY KEY,
    dispatch_id TEXT NOT NULL REFERENCES project_team_dispatch(dispatch_id),
    revision INTEGER NOT NULL CHECK(revision > 0),
    claim_generation INTEGER NOT NULL CHECK(claim_generation >= 0),
    stage TEXT NOT NULL CHECK(stage IN ('workspace-ready','setup-complete','session-bound',
      'assignment-intent','assignment-observed','stopping','settled','quarantine')),
    evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)
      AND length(CAST(evidence_json AS BLOB)) <= 262144),
    recorded_at TEXT NOT NULL,
    UNIQUE(dispatch_id,revision)
  )`;
  yield* sql`CREATE TRIGGER project_team_dispatch_receipt_no_update
    BEFORE UPDATE ON project_team_dispatch_receipt
    BEGIN SELECT RAISE(ABORT,'Dispatch receipts are append-only'); END`;
  yield* sql`CREATE TRIGGER project_team_dispatch_receipt_no_delete
    BEFORE DELETE ON project_team_dispatch_receipt
    BEGIN SELECT RAISE(ABORT,'Dispatch receipts require explicit retained-history cleanup'); END`;
  yield* sql`CREATE TABLE project_team_setup_process (
    setup_id TEXT PRIMARY KEY,
    dispatch_id TEXT NOT NULL UNIQUE REFERENCES project_team_dispatch(dispatch_id),
    unit TEXT UNIQUE,
    selection_json TEXT NOT NULL CHECK(json_valid(selection_json)
      AND length(CAST(selection_json AS BLOB)) <= 262144),
    allocation_json TEXT CHECK(allocation_json IS NULL OR
      (json_valid(allocation_json) AND length(CAST(allocation_json AS BLOB)) <= 262144)),
    status TEXT NOT NULL CHECK(status IN ('no-script','allocated','claimed','captured',
      'completed','failed','uncertain')),
    owner_json TEXT CHECK(owner_json IS NULL OR
      (json_valid(owner_json) AND length(CAST(owner_json AS BLOB)) <= 262144)),
    drain_json TEXT CHECK(drain_json IS NULL OR
      (json_valid(drain_json) AND length(CAST(drain_json AS BLOB)) <= 262144)),
    CHECK((status='no-script' AND unit IS NULL AND allocation_json IS NULL)
      OR (status <> 'no-script' AND unit IS NOT NULL AND allocation_json IS NOT NULL)),
    CHECK(status NOT IN ('completed','failed') OR (owner_json IS NOT NULL AND drain_json IS NOT NULL))
  )`;
  yield* sql`CREATE TRIGGER project_team_setup_identity_immutable
    BEFORE UPDATE ON project_team_setup_process WHEN NEW.setup_id <> OLD.setup_id
      OR NEW.dispatch_id <> OLD.dispatch_id OR NEW.unit IS NOT OLD.unit
      OR NEW.selection_json <> OLD.selection_json OR NEW.allocation_json IS NOT OLD.allocation_json
      OR (OLD.owner_json IS NOT NULL AND NEW.owner_json IS NOT OLD.owner_json)
      OR (OLD.drain_json IS NOT NULL AND NEW.drain_json IS NOT OLD.drain_json)
      OR (OLD.status IN ('no-script','completed','failed') AND NEW.status <> OLD.status)
    BEGIN SELECT RAISE(ABORT,'Setup identity and physical receipts cannot change'); END`;
});
