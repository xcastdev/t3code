import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runForkMigrations, runMigrations } from "../../Migrations.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const fixture = Effect.gen(function* () {
  yield* runMigrations({ toForkMigrationInclusive: 39 });
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO project_team_run_binding
    (record_id,project_id,status,revision,generation,updated_at,payload_json)
    VALUES ('binding','project','reserved',0,0,'2026-10-06T00:00:00.000Z','{}')`;
  yield* sql`INSERT INTO project_team_model_budget VALUES ('environment','project','root',1000,10000)`;
  yield* sql`INSERT INTO project_team_dispatch
    (dispatch_id,environment_id,project_id,binding_id,generation,task_id,attempt_id,
     worktree,branch,root_task_id,root_maximum_tokens,root_deadline_at_ms,
     attempt_maximum_tokens,attempt_deadline_at_ms,delegation_depth,maximum_delegation_depth,
     repair_allowance,stage,revision,claim_generation,intent_json,created_at,updated_at)
    VALUES ('dispatch','environment','project','binding',0,'task','attempt','/assigned','branch',
      'root',1000,10000,500,9000,0,2,2,'assignment-observed',0,1,'{}',
      '2026-10-06T00:00:00.000Z','2026-10-06T00:00:00.000Z')`;
  const first = encodeJson({
    kind: "none",
    environmentId: "environment",
    dispatchId: "dispatch",
    projectId: "project",
    bindingId: "binding",
    generation: 0,
  });
  const digest = "d".repeat(64);
  yield* sql`INSERT INTO project_team_mailbox_turn
    (environment_id,dispatch_id,project_id,binding_id,generation,decision_json,decision_sha256,operation_id)
    VALUES ('environment','dispatch','project','binding',0,${first},${digest},NULL)`;
  const decision = (turnIndex = 1, predecessorOperationId = "predecessor") => ({
    version: 2,
    kind: "none",
    environmentId: "environment",
    dispatchId: "dispatch",
    projectId: "project",
    bindingId: "binding",
    generation: 0,
    turnIndex,
    predecessor: { operationId: predecessorOperationId },
    stopReason: turnIndex === 128 ? "chain-limit" : "empty",
  });
  const insert = (
    value: unknown = decision(),
    turnIndex = 1,
    predecessor = "predecessor",
    operationId: string | null = null,
  ) => sql`INSERT INTO project_team_mailbox_successor
    (environment_id,dispatch_id,predecessor_operation_id,turn_index,project_id,binding_id,
     generation,decision_json,decision_sha256,operation_id)
    VALUES ('environment','dispatch',${predecessor},${turnIndex},'project','binding',0,
      ${encodeJson(value)},${digest},${operationId})`;
  return { sql, decision, insert };
});

it.effect(
  "upgrades without rewriting the original immutable boundary or selecting a successor",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const before = yield* f.sql`SELECT * FROM project_team_mailbox_turn`;
      expect(yield* runForkMigrations(40)).toEqual([[40, "ProjectTeamMailboxSuccessors"]]);
      expect(yield* f.sql`SELECT * FROM project_team_mailbox_turn`).toEqual(before);
      expect(yield* f.sql`SELECT * FROM project_team_mailbox_successor`).toEqual([]);
      expect(yield* runForkMigrations(40)).toEqual([]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "retains the first successor decision and rejects replacement, deletion and duplicate ordinals",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* runForkMigrations(40);
      yield* f.insert();
      const before = yield* f.sql`SELECT * FROM project_team_mailbox_successor`;
      expect((yield* f.insert().pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* f.insert(f.decision(1, "other"), 1, "other").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(
        (yield* f.sql`UPDATE project_team_mailbox_successor SET decision_sha256=${"a".repeat(64)}`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      expect(
        (yield* f.sql`DELETE FROM project_team_mailbox_successor`.pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* f.sql`SELECT * FROM project_team_mailbox_successor`).toEqual(before);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "rejects substituted boundary identity and permits only a terminal decision at the chain ceiling",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* runForkMigrations(40);
      for (const value of [
        { ...f.decision(), version: 1 },
        { ...f.decision(), predecessor: { operationId: "substitute" } },
        { ...f.decision(), turnIndex: 2 },
        { ...f.decision(), generation: 1 },
        { ...f.decision(), stopReason: "chain-limit" },
      ])
        expect((yield* f.insert(value).pipe(Effect.result))._tag).toBe("Failure");
      expect(
        (yield* f
          .insert(
            { ...f.decision(128), kind: "one", request: { operationId: "too-many" } },
            128,
            "predecessor",
            "too-many",
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* f.insert(f.decision(128), 128);
      expect(
        (yield* f.sql`SELECT turn_index,operation_id FROM project_team_mailbox_successor`)[0],
      ).toEqual({ turn_index: 128, operation_id: null });
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
