import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Process and model operation receipts retain ownership across server restarts. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_team_pi_operation (
    operation_id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation >= 0),
    provider_instance_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    operation_ordinal INTEGER NOT NULL CHECK(operation_ordinal >= 0),
    operation_kind TEXT NOT NULL CHECK(operation_kind IN ('initialize','prompt','compact')),
    request_hash TEXT NOT NULL,
    root_binding_id TEXT NOT NULL,
    root_task_id TEXT NOT NULL,
    maximum_tokens INTEGER NOT NULL CHECK(maximum_tokens > 0),
    deadline_at_ms INTEGER NOT NULL CHECK(deadline_at_ms > 0),
    status TEXT NOT NULL CHECK(status IN ('prepared','starting','running','settled','quarantine')),
    intent_json TEXT NOT NULL CHECK(length(CAST(intent_json AS BLOB)) <= 1048576),
    native_json TEXT CHECK(native_json IS NULL OR length(CAST(native_json AS BLOB)) <= 8192),
    terminal_json TEXT CHECK(terminal_json IS NULL OR length(CAST(terminal_json AS BLOB)) <= 262144),
    UNIQUE(worker_id,generation,operation_id),
    UNIQUE(environment_id,provider_instance_id,thread_id,operation_ordinal)
  )`;
  yield* sql`CREATE UNIQUE INDEX project_team_pi_active_thread
    ON project_team_pi_operation(environment_id,provider_instance_id,thread_id)
    WHERE status IN ('prepared','starting','running','quarantine')`;
  yield* sql`CREATE INDEX project_team_pi_binding_history
    ON project_team_pi_operation(environment_id,project_id,binding_id,generation,operation_ordinal)`;
  yield* sql`CREATE TABLE project_team_pi_process (
    unit TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL REFERENCES project_team_pi_operation(operation_id),
    allocation_json TEXT NOT NULL CHECK(length(CAST(allocation_json AS BLOB)) <= 262144),
    status TEXT NOT NULL CHECK(status IN ('allocated','claimed','captured','drained','quarantine')),
    owner_json TEXT CHECK(owner_json IS NULL OR length(CAST(owner_json AS BLOB)) <= 262144),
    drain_json TEXT CHECK(drain_json IS NULL OR length(CAST(drain_json AS BLOB)) <= 262144)
  )`;
  yield* sql`CREATE INDEX project_team_pi_process_operation
    ON project_team_pi_process(operation_id,status,unit)`;
  yield* sql`CREATE TABLE project_team_pi_control (
    operation_id TEXT NOT NULL REFERENCES project_team_pi_operation(operation_id),
    control_id INTEGER NOT NULL CHECK(control_id > 0),
    kind TEXT NOT NULL CHECK(kind IN ('steer','follow-up','interrupt')),
    status TEXT NOT NULL CHECK(status IN ('received','unresolved')),
    receipt_json TEXT NOT NULL CHECK(length(CAST(receipt_json AS BLOB)) <= 8192),
    PRIMARY KEY(operation_id,control_id)
  )`;
  yield* sql`CREATE TABLE project_team_pi_catalogue (
    source TEXT PRIMARY KEY CHECK(source='https://api.commandcode.ai/provider/v1/models'),
    fetched_at TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK(length(CAST(payload_json AS BLOB)) <= 262144)
  )`;
});
