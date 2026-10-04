import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Original cleanup/reflection receipts survive project deletion and never change owners. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_team_memory_outcome (
    effect_id TEXT PRIMARY KEY NOT NULL CHECK(length(effect_id) BETWEEN 1 AND 256),
    environment_id TEXT NOT NULL CHECK(length(environment_id) BETWEEN 1 AND 256),
    project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 256),
    claim_generation INTEGER NOT NULL CHECK(typeof(claim_generation)='integer' AND
      claim_generation BETWEEN 1 AND 9007199254740991),
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB))<=262144),
    reflection_json TEXT NOT NULL CHECK(json_valid(reflection_json) AND length(CAST(reflection_json AS BLOB))<=262144)
  )`;
  yield* sql`CREATE TRIGGER project_team_memory_outcome_first_winner BEFORE INSERT ON project_team_memory_outcome
    WHEN EXISTS(SELECT 1 FROM project_team_memory_outcome WHERE effect_id=NEW.effect_id)
    BEGIN SELECT RAISE(IGNORE); END`;
  yield* sql`CREATE TRIGGER project_team_memory_outcome_immutable BEFORE UPDATE ON project_team_memory_outcome
    WHEN NEW.effect_id<>OLD.effect_id OR NEW.environment_id<>OLD.environment_id OR
      NEW.project_id<>OLD.project_id OR NEW.claim_generation<>OLD.claim_generation OR
      NEW.receipt_json<>OLD.receipt_json OR NEW.reflection_json<>OLD.reflection_json
    BEGIN SELECT RAISE(ABORT,'Original memory reflection receipt cannot change'); END`;
});
