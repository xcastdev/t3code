import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_team_mailbox_batch (
    operation_id TEXT NOT NULL PRIMARY KEY REFERENCES project_team_pi_operation(operation_id) CHECK(typeof(operation_id)='text' AND length(operation_id) BETWEEN 1 AND 256),
    batch_id TEXT NOT NULL UNIQUE CHECK(typeof(batch_id)='text' AND length(batch_id) BETWEEN 1 AND 256),
    environment_id TEXT NOT NULL CHECK(typeof(environment_id)='text' AND length(environment_id) BETWEEN 1 AND 256),
    project_id TEXT NOT NULL CHECK(typeof(project_id)='text' AND length(project_id) BETWEEN 1 AND 256),
    dispatch_id TEXT NOT NULL REFERENCES project_team_dispatch(dispatch_id) CHECK(typeof(dispatch_id)='text' AND length(dispatch_id) BETWEEN 1 AND 256),
    binding_id TEXT NOT NULL CHECK(typeof(binding_id)='text' AND length(binding_id) BETWEEN 1 AND 256),
    generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991),
    manifest_json TEXT NOT NULL CHECK(typeof(manifest_json)='text' AND length(CAST(manifest_json AS BLOB)) BETWEEN 1 AND 262144 AND json_valid(manifest_json)),
    manifest_sha256 TEXT NOT NULL CHECK(typeof(manifest_sha256)='text' AND length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^a-f0-9]*'),
    system_text TEXT NOT NULL CHECK(typeof(system_text)='text' AND length(CAST(system_text AS BLOB)) <= 65536),
    system_text_sha256 TEXT NOT NULL CHECK(typeof(system_text_sha256)='text' AND length(system_text_sha256)=64 AND system_text_sha256 NOT GLOB '*[^a-f0-9]*'),
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
    status TEXT NOT NULL CHECK(status IN ('sealed','uncertain','delivered'))
  )`;
  yield* sql`CREATE TABLE project_team_mailbox_input (
    reservation_id TEXT NOT NULL PRIMARY KEY REFERENCES project_team_model_request(reservation_id) CHECK(typeof(reservation_id)='text' AND length(reservation_id) BETWEEN 1 AND 256),
    operation_id TEXT NOT NULL REFERENCES project_team_mailbox_batch(operation_id) CHECK(typeof(operation_id)='text' AND length(operation_id) BETWEEN 1 AND 256),
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
  yield* sql`CREATE TABLE project_team_mailbox_reflection (
    operation_id TEXT NOT NULL REFERENCES project_team_mailbox_batch(operation_id) CHECK(typeof(operation_id)='text' AND length(operation_id) BETWEEN 1 AND 256),
    phase TEXT NOT NULL CHECK(phase IN ('uncertain','delivered')),
    command_json TEXT NOT NULL CHECK(typeof(command_json)='text' AND length(CAST(command_json AS BLOB)) BETWEEN 1 AND 262144 AND json_valid(command_json)),
    command_sha256 TEXT NOT NULL CHECK(typeof(command_sha256)='text' AND length(command_sha256)=64 AND command_sha256 NOT GLOB '*[^a-f0-9]*'),
    observation_sha256 TEXT NOT NULL CHECK(typeof(observation_sha256)='text' AND length(observation_sha256)=64 AND observation_sha256 NOT GLOB '*[^a-f0-9]*'),
    observed_at TEXT NOT NULL CHECK(typeof(observed_at)='text' AND length(observed_at) BETWEEN 1 AND 256),
    outcome_json TEXT NOT NULL CHECK(typeof(outcome_json)='text' AND length(CAST(outcome_json AS BLOB)) BETWEEN 1 AND 262144 AND json_valid(outcome_json)),
    PRIMARY KEY(operation_id,phase)
  )`;
  yield* sql`CREATE INDEX project_team_mailbox_batch_owner ON project_team_mailbox_batch(environment_id,project_id,dispatch_id)`;
  yield* sql`CREATE INDEX project_team_mailbox_input_operation ON project_team_mailbox_input(operation_id,reservation_id)`;
  yield* sql`CREATE TRIGGER project_team_mailbox_batch_transition BEFORE UPDATE ON project_team_mailbox_batch
    WHEN NEW.operation_id IS NOT OLD.operation_id OR
      NEW.batch_id IS NOT OLD.batch_id OR
      NEW.environment_id IS NOT OLD.environment_id OR
      NEW.project_id IS NOT OLD.project_id OR
      NEW.dispatch_id IS NOT OLD.dispatch_id OR
      NEW.binding_id IS NOT OLD.binding_id OR
      NEW.generation IS NOT OLD.generation OR
      NEW.manifest_json IS NOT OLD.manifest_json OR
      NEW.manifest_sha256 IS NOT OLD.manifest_sha256 OR
      NEW.system_text IS NOT OLD.system_text OR
      NEW.system_text_sha256 IS NOT OLD.system_text_sha256 OR
      NEW.revision != OLD.revision + 1 OR NOT (
        (OLD.status='sealed' AND NEW.status IN ('uncertain','delivered')) OR
        (OLD.status='uncertain' AND NEW.status='delivered'))
    BEGIN SELECT RAISE(ABORT,'Mailbox batch identity or transition differs'); END`;
  yield* sql`CREATE TRIGGER project_team_mailbox_input_immutable BEFORE UPDATE ON project_team_mailbox_input
    BEGIN SELECT RAISE(ABORT,'Retained mailbox input cannot change'); END`;
  yield* sql`CREATE TRIGGER project_team_mailbox_reflection_immutable BEFORE UPDATE ON project_team_mailbox_reflection
    BEGIN SELECT RAISE(ABORT,'Retained mailbox reflection cannot change'); END`;
  yield* sql`CREATE TRIGGER project_team_mailbox_batch_retained BEFORE DELETE ON project_team_mailbox_batch
    BEGIN SELECT RAISE(ABORT,'Retained mailbox batch cannot be deleted'); END`;
  yield* sql`CREATE TRIGGER project_team_mailbox_input_retained BEFORE DELETE ON project_team_mailbox_input
    BEGIN SELECT RAISE(ABORT,'Retained mailbox input cannot be deleted'); END`;
  yield* sql`CREATE TRIGGER project_team_mailbox_reflection_retained BEFORE DELETE ON project_team_mailbox_reflection
    BEGIN SELECT RAISE(ABORT,'Retained mailbox reflection cannot be deleted'); END`;
});
