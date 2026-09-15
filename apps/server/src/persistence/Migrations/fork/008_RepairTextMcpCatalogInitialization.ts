import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // SQLite's TEXT affinity serializes the swapped numeric revision as JSON
  // text. Repair only the impossible pair: an array in the revision column
  // and a nonnegative integral JSON revision where the applied catalog belongs.
  yield* sql`
    UPDATE projection_mcp_catalog_sessions
    SET desired_revision = CAST(applied_catalog_json AS INTEGER),
        applied_catalog_json = desired_revision
    WHERE typeof(desired_revision) = 'text'
      AND json_valid(desired_revision)
      AND json_type(CASE WHEN json_valid(desired_revision) THEN desired_revision ELSE 'null' END) = 'array'
      AND json_valid(applied_catalog_json)
      AND json_type(
        CASE WHEN json_valid(applied_catalog_json) THEN applied_catalog_json ELSE 'null' END
      ) = 'integer'
      AND json_extract(applied_catalog_json, '$') >= 0
  `;
});
