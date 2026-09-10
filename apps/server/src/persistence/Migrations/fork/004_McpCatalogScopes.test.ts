import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectMcpTransport } from "@t3tools/contracts";
import migration from "./004_McpCatalogScopes.ts";
import * as NodeSqliteClient from "../../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("fork 004 MCP catalog scopes", (it) => {
  it.effect("normalizes URL-only and explicit project transports", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_thread_sessions (
        thread_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        provider_name TEXT,
        provider_session_id TEXT,
        provider_thread_id TEXT,
        runtime_mode TEXT NOT NULL,
        active_turn_id TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      )`;
      yield* sql`CREATE TABLE projection_project_mcp_servers (
        server_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        transport_json TEXT,
        enabled INTEGER NOT NULL,
        provider_instance_ids_json TEXT NOT NULL
      )`;
      yield* sql`INSERT INTO projection_project_mcp_servers VALUES (
        'legacy', 'project-a', 'Legacy', 'https://legacy.example/mcp', NULL, 1, '["codex"]'
      )`;
      yield* sql`INSERT INTO projection_project_mcp_servers VALUES (
        'explicit', 'project-a', 'Explicit', 'https://explicit.example/mcp',
        '{"type":"streamable-http","url":"https://explicit.example/mcp","headers":[],"authorization":{"type":"none"}}',
        1, '["claude"]'
      )`;
      yield* migration;
      const rows = yield* sql<{ logicalServerId: string; transportJson: string }>`
        SELECT logical_server_id AS logicalServerId, transport_json AS transportJson
        FROM projection_mcp_definitions
        ORDER BY logical_server_id
      `;
      expect(rows).toHaveLength(2);
      expect(rows[0]?.logicalServerId).toBe("explicit");
      expect(rows[1]?.logicalServerId).toBe("legacy");
      const legacyTransport = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ProjectMcpTransport),
      )(rows[1]!.transportJson);
      expect(legacyTransport).toMatchObject({
        type: "streamable-http",
        url: "https://legacy.example/mcp",
      });
    }),
  );
});
