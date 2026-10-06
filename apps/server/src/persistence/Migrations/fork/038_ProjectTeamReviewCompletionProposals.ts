import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_team_review_completion_proposal (
    environment_id TEXT NOT NULL CHECK(typeof(environment_id)='text' AND length(environment_id) BETWEEN 1 AND 256),
    project_id TEXT NOT NULL CHECK(typeof(project_id)='text' AND length(project_id) BETWEEN 1 AND 256),
    command_id TEXT NOT NULL CHECK(typeof(command_id)='text' AND length(command_id) BETWEEN 1 AND 256),
    dispatch_id TEXT NOT NULL REFERENCES project_team_dispatch(dispatch_id) CHECK(typeof(dispatch_id)='text' AND length(dispatch_id) BETWEEN 1 AND 256),
    binding_id TEXT NOT NULL CHECK(typeof(binding_id)='text' AND length(binding_id) BETWEEN 1 AND 256),
    generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991),
    review_task_id TEXT NOT NULL CHECK(typeof(review_task_id)='text' AND length(review_task_id) BETWEEN 1 AND 256),
    parent_task_id TEXT NOT NULL CHECK(typeof(parent_task_id)='text' AND length(parent_task_id) BETWEEN 1 AND 256),
    assignment_operation_id TEXT NOT NULL REFERENCES project_team_pi_operation(operation_id) CHECK(typeof(assignment_operation_id)='text' AND length(assignment_operation_id) BETWEEN 1 AND 256),
    assignment_request_hash TEXT NOT NULL CHECK(typeof(assignment_request_hash)='text' AND length(assignment_request_hash)=64 AND assignment_request_hash NOT GLOB '*[^a-f0-9]*'),
    manifest_json TEXT NOT NULL CHECK(typeof(manifest_json)='text' AND length(CAST(manifest_json AS BLOB)) BETWEEN 1 AND 524288 AND json_valid(manifest_json) AND json_type(manifest_json)='object'),
    sha256 TEXT NOT NULL CHECK(typeof(sha256)='text' AND length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
    PRIMARY KEY(environment_id,project_id,command_id),
    UNIQUE(environment_id,assignment_operation_id)
  )`;
  yield* sql`CREATE INDEX project_team_review_completion_proposal_dispatch ON project_team_review_completion_proposal(environment_id,project_id,dispatch_id)`;
  yield* sql`CREATE TRIGGER project_team_review_completion_proposal_immutable BEFORE UPDATE ON project_team_review_completion_proposal
    BEGIN SELECT RAISE(ABORT,'Retained review completion proposal cannot change'); END`;
  yield* sql`CREATE TRIGGER project_team_review_completion_proposal_retained BEFORE DELETE ON project_team_review_completion_proposal
    BEGIN SELECT RAISE(ABORT,'Retained review completion proposal cannot be deleted'); END`;
});
