import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_team_mailbox_turn (
    environment_id TEXT NOT NULL CHECK(typeof(environment_id)='text' AND length(environment_id) BETWEEN 1 AND 256),
    dispatch_id TEXT NOT NULL REFERENCES project_team_dispatch(dispatch_id) CHECK(typeof(dispatch_id)='text' AND length(dispatch_id) BETWEEN 1 AND 256),
    project_id TEXT NOT NULL CHECK(typeof(project_id)='text' AND length(project_id) BETWEEN 1 AND 256),
    binding_id TEXT NOT NULL CHECK(typeof(binding_id)='text' AND length(binding_id) BETWEEN 1 AND 256),
    generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991),
    decision_json TEXT NOT NULL CHECK(typeof(decision_json)='text' AND length(CAST(decision_json AS BLOB)) BETWEEN 1 AND 262144 AND json_valid(decision_json) AND json_type(decision_json)='object'),
    decision_sha256 TEXT NOT NULL CHECK(typeof(decision_sha256)='text' AND length(decision_sha256)=64 AND decision_sha256 NOT GLOB '*[^a-f0-9]*'),
    operation_id TEXT UNIQUE CHECK(operation_id IS NULL OR (typeof(operation_id)='text' AND length(operation_id) BETWEEN 1 AND 256)),
    PRIMARY KEY(environment_id,dispatch_id),
    CHECK(json_extract(decision_json,'$.environmentId') IS environment_id
      AND json_extract(decision_json,'$.dispatchId') IS dispatch_id
      AND json_extract(decision_json,'$.projectId') IS project_id
      AND json_extract(decision_json,'$.bindingId') IS binding_id
      AND json_extract(decision_json,'$.generation') IS generation),
    CHECK((json_extract(decision_json,'$.kind') IS 'none' AND operation_id IS NULL
        AND json_type(decision_json,'$.request') IS NULL)
      OR (json_extract(decision_json,'$.kind') IS 'one' AND operation_id IS NOT NULL
        AND json_extract(decision_json,'$.request.operationId') IS operation_id))
  )`;
  yield* sql`CREATE TRIGGER project_team_mailbox_turn_immutable BEFORE UPDATE ON project_team_mailbox_turn
    BEGIN SELECT RAISE(ABORT,'Retained mailbox boundary decision cannot change'); END`;
  yield* sql`CREATE TRIGGER project_team_mailbox_turn_retained BEFORE DELETE ON project_team_mailbox_turn
    BEGIN SELECT RAISE(ABORT,'Retained mailbox boundary decision cannot be deleted'); END`;
});
