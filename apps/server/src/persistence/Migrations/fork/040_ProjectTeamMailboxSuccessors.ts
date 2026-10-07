import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_team_mailbox_successor (
    environment_id TEXT NOT NULL CHECK(typeof(environment_id)='text' AND length(environment_id) BETWEEN 1 AND 256),
    dispatch_id TEXT NOT NULL REFERENCES project_team_dispatch(dispatch_id) CHECK(typeof(dispatch_id)='text' AND length(dispatch_id) BETWEEN 1 AND 256),
    predecessor_operation_id TEXT NOT NULL CHECK(typeof(predecessor_operation_id)='text' AND length(predecessor_operation_id) BETWEEN 1 AND 256),
    turn_index INTEGER NOT NULL CHECK(typeof(turn_index)='integer' AND turn_index BETWEEN 1 AND 128),
    project_id TEXT NOT NULL CHECK(typeof(project_id)='text' AND length(project_id) BETWEEN 1 AND 256),
    binding_id TEXT NOT NULL CHECK(typeof(binding_id)='text' AND length(binding_id) BETWEEN 1 AND 256),
    generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991),
    decision_json TEXT NOT NULL CHECK(typeof(decision_json)='text' AND length(CAST(decision_json AS BLOB)) BETWEEN 1 AND 262144 AND json_valid(decision_json) AND json_type(decision_json)='object'),
    decision_sha256 TEXT NOT NULL CHECK(typeof(decision_sha256)='text' AND length(decision_sha256)=64 AND decision_sha256 NOT GLOB '*[^a-f0-9]*'),
    operation_id TEXT UNIQUE CHECK(operation_id IS NULL OR (typeof(operation_id)='text' AND length(operation_id) BETWEEN 1 AND 256)),
    PRIMARY KEY(environment_id,dispatch_id,predecessor_operation_id),
    UNIQUE(environment_id,dispatch_id,turn_index),
    CHECK(json_extract(decision_json,'$.version') IS 2
      AND json_extract(decision_json,'$.environmentId') IS environment_id
      AND json_extract(decision_json,'$.dispatchId') IS dispatch_id
      AND json_extract(decision_json,'$.predecessor.operationId') IS predecessor_operation_id
      AND json_extract(decision_json,'$.turnIndex') IS turn_index
      AND json_extract(decision_json,'$.projectId') IS project_id
      AND json_extract(decision_json,'$.bindingId') IS binding_id
      AND json_extract(decision_json,'$.generation') IS generation),
    CHECK((json_extract(decision_json,'$.kind') IS 'none' AND operation_id IS NULL
        AND json_type(decision_json,'$.request') IS NULL
        AND ((turn_index < 128 AND json_extract(decision_json,'$.stopReason') IS 'empty')
          OR (turn_index IS 128 AND json_extract(decision_json,'$.stopReason') IS 'chain-limit')))
      OR (json_extract(decision_json,'$.kind') IS 'one' AND turn_index < 128
        AND operation_id IS NOT NULL
        AND json_extract(decision_json,'$.request.operationId') IS operation_id
        AND json_type(decision_json,'$.stopReason') IS NULL))
  )`;
  yield* sql`CREATE TRIGGER project_team_mailbox_successor_immutable BEFORE UPDATE ON project_team_mailbox_successor
    BEGIN SELECT RAISE(ABORT,'Retained mailbox successor decision cannot change'); END`;
  yield* sql`CREATE TRIGGER project_team_mailbox_successor_retained BEFORE DELETE ON project_team_mailbox_successor
    BEGIN SELECT RAISE(ABORT,'Retained mailbox successor decision cannot be deleted'); END`;
});
