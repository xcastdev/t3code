import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const tables = [
  "scheduled_tasks",
  "scheduled_task_webhook_deliveries",
  "scheduled_task_webhook_relay_deliveries",
  "scheduled_task_webhook_replay_keys",
  "scheduled_task_webhook_pending",
] as const;
const encodeRows = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export class ControlledRoutineIsolation extends Context.Service<
  ControlledRoutineIsolation,
  { readonly assertCopiedUnchanged: Effect.Effect<void, import("effect/sql/SqlError").SqlError> }
>()("t3/testUtils/controlledRoutineIsolation") {}

/** All scheduler SQL remains real; only its unqualified table namespace is empty and fixture-owned. */
export const layerControlledRoutineIsolation = Layer.effect(
  ControlledRoutineIsolation,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const before = new Map<string, string>();
    for (const name of tables) {
      const rows = yield* sql.unsafe<Record<string, unknown>>(
        `SELECT * FROM main.${name} ORDER BY rowid`,
      );
      before.set(name, encodeRows(rows));
      const definitions = yield* sql<{ sql: string | null; type: string; name: string }>`
        SELECT sql,type,name FROM main.sqlite_schema WHERE tbl_name=${name} AND type IN ('table','index') ORDER BY type DESC,name`;
      const table = definitions.find((row) => row.type === "table");
      if (!table?.sql || !/^CREATE TABLE\s/i.test(table.sql))
        throw new Error(`Missing verified scheduler schema: ${name}`);
      const existing = yield* sql`SELECT name FROM temp.sqlite_schema WHERE name=${name}`;
      if (existing.length !== 0)
        throw new Error("Routine isolation must precede service construction");
      yield* sql.unsafe(table.sql.replace(/^CREATE TABLE\s/i, "CREATE TEMP TABLE "));
      for (const index of definitions.filter((row) => row.type === "index" && row.sql !== null)) {
        if (!/^[A-Za-z0-9_]+$/.test(index.name)) throw new Error("Unexpected scheduler index name");
        const definition = index.sql!;
        const match = /^CREATE (UNIQUE )?INDEX\s+(?:"[^"]+"|\w+)\s+ON\s/i.exec(definition);
        if (!match) throw new Error("Unexpected scheduler index definition");
        yield* sql.unsafe(
          definition.replace(match[0], `CREATE ${match[1] ?? ""}INDEX temp.${index.name} ON `),
        );
      }
      const count = yield* sql.unsafe<{ count: number }>(`SELECT COUNT(*) AS count FROM ${name}`);
      const transaction = yield* sql.withTransaction(
        sql.unsafe<{ count: number }>(`SELECT COUNT(*) AS count FROM ${name}`),
      );
      const readOnly = yield* sql
        .unsafe<{ count: number }>(`SELECT COUNT(*) AS count FROM ${name}`)
        .pipe(NodeSqliteClient.readOnly);
      const readOnlyTransaction = yield* sql
        .withTransaction(sql.unsafe<{ count: number }>(`SELECT COUNT(*) AS count FROM ${name}`))
        .pipe(NodeSqliteClient.readOnly);
      if ([count, transaction, readOnly, readOnlyTransaction].some((rows) => rows[0]?.count !== 0))
        throw new Error("Scheduler isolation requires one SQLite connection");
    }
    // Even an adversarial caller cannot reuse a copied task identity in the shadow namespace.
    yield* sql`CREATE TEMP TRIGGER p21_routine_owned_insert BEFORE INSERT ON scheduled_tasks
      WHEN EXISTS (SELECT 1 FROM main.scheduled_tasks WHERE task_id=NEW.task_id)
        OR length(NEW.task_id)!=82 OR substr(NEW.task_id,1,18)!='assistant-routine-'
        OR substr(NEW.task_id,19) GLOB '*[^0-9a-f]*'
      BEGIN SELECT RAISE(ABORT,'Only new fixture routine identities are admitted'); END`;
    const assertCopiedUnchanged = Effect.gen(function* () {
      for (const name of tables) {
        const rows = yield* sql.unsafe<Record<string, unknown>>(
          `SELECT * FROM main.${name} ORDER BY rowid`,
        );
        if (encodeRows(rows) !== before.get(name))
          throw new Error(`Copied scheduler rows changed: ${name}`);
      }
    });
    yield* assertCopiedUnchanged;
    yield* Effect.addFinalizer(() => assertCopiedUnchanged.pipe(Effect.orDie));
    return ControlledRoutineIsolation.of({ assertCopiedUnchanged });
  }),
);
