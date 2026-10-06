import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runForkMigrations, runMigrations } from "../../Migrations.ts";

it.effect(
  "upgrades a prior database without changing retained authority or backfilling findings",
  () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 35 });
      const sql = yield* SqlClient.SqlClient;
      // Earlier databases have no derived findings table, even though new installs share the current definition.
      yield* sql`DROP TABLE IF EXISTS project_team_review_finding`;
      yield* sql`INSERT INTO project_team_member (record_id,project_id,status,revision,generation,updated_at,payload_json)
      VALUES ('retained-member','project','active',0,0,'2026-10-06T00:00:00.000Z','{}')`;
      const before = yield* sql`SELECT * FROM project_team_member`;
      expect(yield* runForkMigrations()).toEqual([[36, "ProjectTeamReviewFindings"]]);
      expect(yield* sql`SELECT * FROM project_team_review_finding`).toEqual([]);
      expect(yield* sql`SELECT * FROM project_team_member`).toEqual(before);
      expect(yield* runForkMigrations()).toEqual([]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
