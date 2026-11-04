import { McpServerId, type McpCatalogSessionId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { CatalogAliases } from "./ProjectMcpBroker.ts";

const StoredAliases = Schema.fromJsonString(
  Schema.Struct({
    byServer: Schema.Array(
      Schema.Tuple([McpServerId, Schema.Struct({ base: Schema.String, alias: Schema.String })]),
    ),
    issued: Schema.Array(Schema.Tuple([Schema.String, McpServerId])),
  }),
);
const decode = Schema.decodeEffect(StoredAliases);
const encode = Schema.encodeEffect(StoredAliases);

export class McpCatalogAliasStoreError extends Schema.TaggedError<McpCatalogAliasStoreError>()(
  "McpCatalogAliasStoreError",
  { cause: Schema.Defect() },
) {}

/** Aliases a catalog session has issued, which outlive the gateway's in-memory generations. */
export class McpCatalogAliasStore extends Context.Service<
  McpCatalogAliasStore,
  {
    readonly read: (
      id: McpCatalogSessionId,
    ) => Effect.Effect<CatalogAliases | undefined, McpCatalogAliasStoreError>;
    readonly write: (
      id: McpCatalogSessionId,
      aliases: CatalogAliases,
    ) => Effect.Effect<void, McpCatalogAliasStoreError>;
  }
>()("t3/mcp/McpCatalogAliasStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fail = Effect.mapError((cause) => new McpCatalogAliasStoreError({ cause }));
  return McpCatalogAliasStore.of({
    read: Effect.fn("McpCatalogAliasStore.read")(function* (id) {
      const rows = yield* sql<{
        readonly aliases_json: string;
      }>`SELECT aliases_json FROM t3_workflow_v2_mcp_catalog_aliases WHERE catalog_session_id=${id}`;
      if (!rows[0]) return undefined;
      // An unreadable row would fail every apply; the next write replaces it.
      const stored = yield* decode(rows[0].aliases_json).pipe(
        Effect.catchTags({
          SchemaError: (error) =>
            Effect.logWarning("ignoring unreadable MCP catalog aliases", {
              catalogSessionId: id,
              error: error.message,
            }).pipe(Effect.as(undefined)),
        }),
      );
      if (!stored) return undefined;
      return { byServer: new Map(stored.byServer), issued: new Map(stored.issued) };
    }, fail),
    write: Effect.fn("McpCatalogAliasStore.write")(function* (id, aliases) {
      const json = yield* encode({
        byServer: [...aliases.byServer],
        issued: [...aliases.issued],
      });
      yield* sql`INSERT INTO t3_workflow_v2_mcp_catalog_aliases(catalog_session_id,aliases_json) VALUES(${id},${json}) ON CONFLICT(catalog_session_id) DO UPDATE SET aliases_json=excluded.aliases_json`;
    }, fail),
  });
});

export const layer = Layer.effect(McpCatalogAliasStore, make);
