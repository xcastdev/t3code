import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Git persists physical ownership before releasing its common-directory permit. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_team_workspace_receipt (
    dispatch_id TEXT PRIMARY KEY NOT NULL REFERENCES project_team_dispatch(dispatch_id),
    environment_id TEXT NOT NULL CHECK(length(environment_id) BETWEEN 1 AND 256),
    binding_id TEXT NOT NULL CHECK(length(binding_id) BETWEEN 1 AND 256),
    generation INTEGER NOT NULL CHECK(typeof(generation)='integer'
      AND generation BETWEEN 0 AND 9007199254740991),
    claim_generation INTEGER NOT NULL CHECK(typeof(claim_generation)='integer'
      AND claim_generation BETWEEN 1 AND 9007199254740991),
    assignment_json TEXT NOT NULL CHECK(json_valid(assignment_json)
      AND length(CAST(assignment_json AS BLOB)) <= 262144),
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)
      AND length(CAST(receipt_json AS BLOB)) <= 262144)
  )`;
  // BEFORE INSERT also fences OR REPLACE, which bypasses UPDATE immutability.
  yield* sql`CREATE TRIGGER project_team_workspace_receipt_first_winner
    BEFORE INSERT ON project_team_workspace_receipt WHEN EXISTS (
      SELECT 1 FROM project_team_workspace_receipt WHERE dispatch_id=NEW.dispatch_id
    ) BEGIN SELECT RAISE(IGNORE); END`;
  yield* sql`CREATE TRIGGER project_team_workspace_receipt_immutable
    BEFORE UPDATE ON project_team_workspace_receipt WHEN
      NEW.dispatch_id <> OLD.dispatch_id OR NEW.environment_id <> OLD.environment_id
      OR NEW.binding_id <> OLD.binding_id OR NEW.generation <> OLD.generation
      OR NEW.claim_generation <> OLD.claim_generation OR NEW.assignment_json <> OLD.assignment_json
      OR NEW.receipt_json <> OLD.receipt_json
    BEGIN SELECT RAISE(ABORT,'Original workspace ownership receipt cannot change'); END`;
});
