import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Memory stages share the original operation ledger without changing native request identities. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_team_model_request_next (
    reservation_id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL, project_id TEXT NOT NULL, root_task_id TEXT NOT NULL,
    run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, worker_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation>=0), operation_id TEXT NOT NULL,
    request_id INTEGER NOT NULL CHECK(request_id>0),
    request_lane TEXT NOT NULL DEFAULT 'pi' CHECK(request_lane IN ('pi','memory')),
    request_scope TEXT NOT NULL DEFAULT '',
    route_id TEXT NOT NULL, provider TEXT NOT NULL,
    model TEXT NOT NULL, environment_slot INTEGER NOT NULL CHECK(environment_slot>=0),
    model_slot INTEGER NOT NULL CHECK(model_slot>=0),
    maximum_input_tokens INTEGER NOT NULL CHECK(maximum_input_tokens>0),
    maximum_output_tokens INTEGER NOT NULL CHECK(maximum_output_tokens>0),
    deadline_at_ms INTEGER NOT NULL CHECK(deadline_at_ms>0),
    status TEXT NOT NULL CHECK(status IN ('held','reported','failed','unknown')),
    charged_input_tokens INTEGER NOT NULL CHECK(charged_input_tokens>=0),
    charged_output_tokens INTEGER NOT NULL CHECK(charged_output_tokens>=0),
    accounting_receipt_id TEXT, reservation_json TEXT NOT NULL, settlement_json TEXT,
    capacity_state TEXT NOT NULL DEFAULT 'legacy'
      CHECK(capacity_state IN ('held','released','quarantine','legacy')),
    CHECK((request_lane='pi' AND request_scope='' AND provider='command-code')
      OR (request_lane='memory' AND length(request_scope)=64 AND request_scope NOT GLOB '*[^a-f0-9]*'
        AND provider IN ('command-code','openrouter'))),
    UNIQUE(worker_id,generation,operation_id,request_lane,request_scope,request_id),
    FOREIGN KEY(environment_id,project_id,root_task_id)
      REFERENCES project_team_model_budget(environment_id,project_id,root_task_id)
  )`;
  yield* sql`INSERT INTO project_team_model_request_next (
    reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,
    operation_id,request_id,route_id,provider,model,environment_slot,model_slot,
    maximum_input_tokens,maximum_output_tokens,deadline_at_ms,status,charged_input_tokens,
    charged_output_tokens,accounting_receipt_id,reservation_json,settlement_json,capacity_state)
    SELECT reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,generation,
      operation_id,request_id,route_id,provider,model,environment_slot,model_slot,
      maximum_input_tokens,maximum_output_tokens,deadline_at_ms,status,charged_input_tokens,
      charged_output_tokens,accounting_receipt_id,reservation_json,settlement_json,capacity_state
    FROM project_team_model_request`;
  // Rebuild the sole referencing child against the new parent before removing
  // either old table. Foreign keys stay enabled throughout the owning migration.
  yield* sql`CREATE TABLE project_team_mailbox_input_next (
    reservation_id TEXT NOT NULL PRIMARY KEY REFERENCES project_team_model_request_next(reservation_id)
      CHECK(typeof(reservation_id)='text' AND length(reservation_id) BETWEEN 1 AND 256),
    operation_id TEXT NOT NULL REFERENCES project_team_mailbox_batch(operation_id)
      CHECK(typeof(operation_id)='text' AND length(operation_id) BETWEEN 1 AND 256),
    request_id INTEGER NOT NULL CHECK(typeof(request_id)='integer' AND request_id BETWEEN 1 AND 9007199254740991),
    worker_id TEXT NOT NULL CHECK(typeof(worker_id)='text' AND length(worker_id) BETWEEN 1 AND 256),
    generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991),
    route_id TEXT NOT NULL CHECK(typeof(route_id)='text' AND length(route_id) BETWEEN 1 AND 256),
    provider TEXT NOT NULL CHECK(provider='command-code'),
    model TEXT NOT NULL CHECK(typeof(model)='text' AND length(model) BETWEEN 1 AND 256),
    system_text_sha256 TEXT NOT NULL CHECK(typeof(system_text_sha256)='text' AND length(system_text_sha256)=64 AND system_text_sha256 NOT GLOB '*[^a-f0-9]*'),
    encoded_request_sha256 TEXT NOT NULL CHECK(typeof(encoded_request_sha256)='text' AND length(encoded_request_sha256)=64 AND encoded_request_sha256 NOT GLOB '*[^a-f0-9]*'),
    UNIQUE(operation_id,request_id)
  )`;
  yield* sql`INSERT INTO project_team_mailbox_input_next SELECT * FROM project_team_mailbox_input`;
  yield* sql`DROP TABLE project_team_mailbox_input`;
  yield* sql`DROP TABLE project_team_model_request`;
  yield* sql`ALTER TABLE project_team_model_request_next RENAME TO project_team_model_request`;
  yield* sql`ALTER TABLE project_team_mailbox_input_next RENAME TO project_team_mailbox_input`;
  yield* sql`CREATE UNIQUE INDEX project_team_model_environment_capacity
    ON project_team_model_request(environment_id,environment_slot) WHERE status='held'`;
  yield* sql`CREATE UNIQUE INDEX project_team_model_route_capacity
    ON project_team_model_request(environment_id,model,model_slot) WHERE status='held'`;
  yield* sql`CREATE INDEX project_team_model_budget_usage
    ON project_team_model_request(environment_id,project_id,root_task_id,reservation_id)`;
  yield* sql`CREATE INDEX project_team_model_pending_deadline
    ON project_team_model_request(status,deadline_at_ms,reservation_id)`;
  yield* sql`CREATE UNIQUE INDEX project_team_transport_environment_slot
    ON project_team_model_request(environment_id,environment_slot) WHERE capacity_state IN ('held','quarantine')`;
  yield* sql`CREATE UNIQUE INDEX project_team_transport_model_slot
    ON project_team_model_request(environment_id,model,model_slot) WHERE capacity_state IN ('held','quarantine')`;
  yield* sql`CREATE INDEX project_team_transport_recovery
    ON project_team_model_request(environment_id,capacity_state,reservation_id)`;
  yield* sql`CREATE INDEX project_team_model_operation_usage
    ON project_team_model_request(environment_id,run_id,generation,operation_id,reservation_id)`;
  yield* sql`CREATE INDEX project_team_mailbox_input_operation
    ON project_team_mailbox_input(operation_id,reservation_id)`;
  yield* sql`CREATE TRIGGER project_team_mailbox_input_immutable BEFORE UPDATE ON project_team_mailbox_input
    BEGIN SELECT RAISE(ABORT,'Retained mailbox input cannot change'); END`;
  yield* sql`CREATE TRIGGER project_team_mailbox_input_retained BEFORE DELETE ON project_team_mailbox_input
    BEGIN SELECT RAISE(ABORT,'Retained mailbox input cannot be deleted'); END`;
  yield* sql`ALTER TABLE project_team_memory_job ADD COLUMN owner_json TEXT CHECK(owner_json IS NULL OR
    (json_valid(owner_json) AND json_type(owner_json)='object'
      AND json_extract(owner_json,'$.version') IS 1 AND length(CAST(owner_json AS BLOB))<=262144))`;
  yield* sql`CREATE TRIGGER project_team_memory_job_owner_immutable BEFORE UPDATE ON project_team_memory_job
    WHEN (OLD.owner_json IS NOT NULL AND NEW.owner_json IS NOT OLD.owner_json)
      OR (OLD.owner_json IS NULL AND NEW.owner_json IS NOT NULL AND
        (OLD.status<>'pending' OR OLD.claim_generation<>0 OR OLD.receipt_json IS NOT NULL))
    BEGIN SELECT RAISE(ABORT,'Original memory operation owner cannot change'); END`;
});
