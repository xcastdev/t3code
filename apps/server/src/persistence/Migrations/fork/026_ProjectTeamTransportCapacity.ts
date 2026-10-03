import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Usage outcomes do not prove that a transport has stopped consuming capacity. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE project_team_model_request ADD COLUMN capacity_state TEXT NOT NULL
    DEFAULT 'legacy' CHECK(capacity_state IN ('held','released','quarantine','legacy'))`;
  yield* sql`UPDATE project_team_model_request SET capacity_state='held' WHERE status='held'`;
  // Old settled requests reused slots. Retain their uncertainty without making upgrade fail.
  yield* sql`CREATE UNIQUE INDEX project_team_transport_environment_slot
    ON project_team_model_request(environment_id,environment_slot)
    WHERE capacity_state IN ('held','quarantine')`;
  yield* sql`CREATE UNIQUE INDEX project_team_transport_model_slot
    ON project_team_model_request(environment_id,model,model_slot)
    WHERE capacity_state IN ('held','quarantine')`;
  yield* sql`CREATE INDEX project_team_transport_recovery
    ON project_team_model_request(environment_id,capacity_state,reservation_id)`;
});
