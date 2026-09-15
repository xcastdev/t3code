import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_turns)`;
  const existing = new Set(columns.map((column) => column.name));
  const additions = [
    ["model", "TEXT"],
    ["effort", "TEXT"],
    ["command_count", "INTEGER"],
    ["tool_call_count", "INTEGER"],
    ["subagent_count", "INTEGER"],
    ["changed_file_count", "INTEGER"],
  ] as const;
  for (const [name, type] of additions) {
    if (!existing.has(name)) {
      yield* sql.unsafe(`ALTER TABLE projection_turns ADD COLUMN ${name} ${type}`);
    }
  }
});
