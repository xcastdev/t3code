import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_team_review_target (
    environment_id TEXT NOT NULL CHECK(typeof(environment_id)='text' AND length(environment_id) BETWEEN 1 AND 256),
    dispatch_id TEXT NOT NULL REFERENCES project_team_dispatch(dispatch_id) ON DELETE CASCADE CHECK(typeof(dispatch_id)='text' AND length(dispatch_id) BETWEEN 1 AND 256),
    project_id TEXT NOT NULL CHECK(typeof(project_id)='text' AND length(project_id) BETWEEN 1 AND 256),
    binding_id TEXT NOT NULL CHECK(typeof(binding_id)='text' AND length(binding_id) BETWEEN 1 AND 256),
    generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991),
    dispatch_intent_hash TEXT NOT NULL CHECK(typeof(dispatch_intent_hash)='text' AND length(dispatch_intent_hash)=64 AND dispatch_intent_hash NOT GLOB '*[^a-f0-9]*'),
    manifest_json TEXT NOT NULL CHECK(typeof(manifest_json)='text' AND length(CAST(manifest_json AS BLOB)) BETWEEN 1 AND 131072 AND json_valid(manifest_json)),
    sha256 TEXT NOT NULL CHECK(typeof(sha256)='text' AND length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
    PRIMARY KEY(environment_id,dispatch_id),
    UNIQUE(environment_id,binding_id,generation)
  )`;
  yield* sql`CREATE INDEX project_team_review_target_project_binding ON project_team_review_target(environment_id,project_id,binding_id)`;
  yield* sql`CREATE TRIGGER project_team_review_target_first_winner BEFORE INSERT ON project_team_review_target
    WHEN EXISTS(SELECT 1 FROM project_team_review_target WHERE environment_id=NEW.environment_id AND
      (dispatch_id=NEW.dispatch_id OR (binding_id=NEW.binding_id AND generation=NEW.generation)))
    BEGIN SELECT RAISE(IGNORE); END`;
  yield* sql`CREATE TRIGGER project_team_review_target_immutable BEFORE UPDATE ON project_team_review_target
    BEGIN SELECT RAISE(ABORT,'Reviewer target cannot change'); END`;
});
