import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A brief initialization INSERT wrote these two fields in reverse order.
  // The shape is unambiguous: an array JSON value in the integer revision
  // column and a number in the JSON catalog column.
  yield* sql`
    UPDATE projection_mcp_catalog_sessions
    SET desired_revision = CAST(applied_catalog_json AS INTEGER),
        applied_catalog_json = desired_revision
    WHERE typeof(desired_revision) = 'text'
      AND json_valid(desired_revision)
      AND json_type(CASE WHEN json_valid(desired_revision) THEN desired_revision ELSE 'null' END) = 'array'
      AND typeof(applied_catalog_json) IN ('integer', 'real')
  `;
});
