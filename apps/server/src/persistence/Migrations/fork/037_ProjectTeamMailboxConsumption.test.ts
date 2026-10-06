import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runForkMigrations, runMigrations } from "../../Migrations.ts";

it.effect("upgrades retained authority without inventing mailbox consumption", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toForkMigrationInclusive: 36 });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO project_team_member (record_id,project_id,status,revision,generation,updated_at,payload_json)
      VALUES ('retained-member','project','active',0,0,'2026-10-06T00:00:00.000Z','{}')`;
    const before = yield* sql`SELECT * FROM project_team_member`;
    expect(yield* runForkMigrations(37)).toEqual([[37, "ProjectTeamMailboxConsumption"]]);
    expect(yield* sql`SELECT * FROM project_team_mailbox_batch`).toEqual([]);
    expect(yield* sql`SELECT * FROM project_team_mailbox_input`).toEqual([]);
    expect(yield* sql`SELECT * FROM project_team_mailbox_reflection`).toEqual([]);
    expect(yield* sql`SELECT * FROM project_team_member`).toEqual(before);
    expect(yield* runForkMigrations(37)).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
