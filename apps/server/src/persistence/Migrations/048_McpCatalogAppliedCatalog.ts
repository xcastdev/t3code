import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Retain the exact definition set handed to a provider independently from
 * the session's desired catalog. Older rows with a stale desired revision
 * remain NULL because the pre-048 projection did not retain enough
 * information to reconstruct the applied catalog safely.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_mcp_catalog_sessions
    ADD COLUMN applied_catalog_json TEXT
  `;

  // An equal revision proves that desired was the catalog applied at the
  // time of the last receipt. Stale rows intentionally remain NULL.
  yield* sql`
    UPDATE projection_mcp_catalog_sessions
    SET applied_catalog_json = desired_catalog_json
    WHERE applied_revision = desired_revision
  `;
});
