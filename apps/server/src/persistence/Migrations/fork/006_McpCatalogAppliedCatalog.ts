import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_mcp_catalog_sessions ADD COLUMN applied_catalog_json TEXT`;
  yield* sql`UPDATE projection_mcp_catalog_sessions SET applied_catalog_json = desired_catalog_json
    WHERE applied_revision = desired_revision`;
});
