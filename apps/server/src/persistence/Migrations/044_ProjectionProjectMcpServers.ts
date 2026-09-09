import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_project_mcp_servers (
      server_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      provider_instance_ids_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_project_mcp_servers_project_id
    ON projection_project_mcp_servers(project_id)
  `;
});
