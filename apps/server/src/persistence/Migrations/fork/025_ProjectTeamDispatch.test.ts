import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../../Migrations.ts";

const fixture = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO project_team_run_binding
    (record_id,project_id,status,revision,generation,updated_at,payload_json)
    VALUES ('binding','project','reserved',0,0,'2026-10-03T00:00:00.000Z','{}')`;
  yield* sql`INSERT INTO project_team_model_budget VALUES ('environment','project','root',1000,10000)`;
  const insert = (
    id = "dispatch",
    binding = "binding",
    path = "/assigned",
    stage = "reserved",
    generation = 0,
  ) =>
    sql`INSERT INTO project_team_dispatch
      (dispatch_id,environment_id,project_id,binding_id,generation,task_id,attempt_id,
       worktree,branch,root_task_id,root_maximum_tokens,root_deadline_at_ms,
       attempt_maximum_tokens,attempt_deadline_at_ms,delegation_depth,maximum_delegation_depth,
       repair_allowance,stage,revision,claim_generation,intent_json,created_at,updated_at)
      VALUES (${id},'environment','project',${binding},${generation},'task',${id},${path},${id},
        'root',1000,10000,500,9000,0,2,2,${stage},0,0,'{}',
        '2026-10-03T00:00:00.000Z','2026-10-03T00:00:00.000Z')`;
  return { sql, insert };
});

it.effect("retains immutable run limits through stage updates and repeated migration", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.insert();
    yield* f.sql`UPDATE project_team_dispatch SET stage='workspace-ready',revision=1,
      updated_at='2026-10-03T00:01:00.000Z' WHERE dispatch_id='dispatch'`;
    for (const column of [
      "root_deadline_at_ms",
      "attempt_deadline_at_ms",
      "root_maximum_tokens",
      "generation",
    ])
      expect(
        (yield* f.sql`UPDATE project_team_dispatch SET ${f.sql(column)}=12000
        WHERE dispatch_id='dispatch'`.pipe(Effect.result))._tag,
      ).toBe("Failure");
    expect(
      (yield* f.sql`UPDATE project_team_dispatch SET intent_json='{"changed":true}'
      WHERE dispatch_id='dispatch'`.pipe(Effect.result))._tag,
    ).toBe("Failure");
    yield* runMigrations();
    expect(
      yield* f.sql`SELECT stage,revision,root_deadline_at_ms,attempt_deadline_at_ms
      FROM project_team_dispatch`,
    ).toEqual([
      {
        stage: "workspace-ready",
        revision: 1,
        root_deadline_at_ms: 10000,
        attempt_deadline_at_ms: 9000,
      },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("does not release an uncertain or stopping workspace to a replacement", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.insert();
    yield* f.sql`INSERT INTO project_team_run_binding
      (record_id,project_id,status,revision,generation,updated_at,payload_json)
      VALUES ('replacement','project','reserved',0,1,'2026-10-03T00:00:00.000Z','{}')`;
    for (const stage of ["reserved", "stopping", "quarantine"]) {
      yield* f.sql`UPDATE project_team_dispatch SET stage=${stage} WHERE dispatch_id='dispatch'`;
      expect(
        (yield* f.insert("second", "replacement", "/assigned", "reserved", 1).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
    }
    yield* f.sql`UPDATE project_team_dispatch SET stage='settled' WHERE dispatch_id='dispatch'`;
    yield* f.insert("second", "replacement", "/assigned", "reserved", 1);
    expect(
      (yield* f
        .insert("duplicate-binding", "replacement", "/other", "reserved", 1)
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("commits ownership and dispatch together or rolls both back", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    expect((yield* f.insert("orphan", "missing").pipe(Effect.result))._tag).toBe("Failure");
    const failed = yield* f.sql
      .withTransaction(
        Effect.gen(function* () {
          yield* f.sql`INSERT INTO project_team_run_binding
        (record_id,project_id,status,revision,generation,updated_at,payload_json)
        VALUES ('new-binding','project','reserved',0,0,'2026-10-03T00:00:00.000Z','{}')`;
          yield* f.insert("atomic", "new-binding");
          return yield* Effect.fail("abort after both inserts");
        }),
      )
      .pipe(Effect.result);
    expect(failed._tag).toBe("Failure");
    expect(yield* f.sql`SELECT dispatch_id FROM project_team_dispatch`).toEqual([]);
    expect(
      yield* f.sql`SELECT record_id FROM project_team_run_binding WHERE record_id='new-binding'`,
    ).toEqual([]);
    yield* f.sql.withTransaction(
      Effect.gen(function* () {
        yield* f.sql`INSERT INTO project_team_run_binding
        (record_id,project_id,status,revision,generation,updated_at,payload_json)
        VALUES ('new-binding','project','reserved',0,0,'2026-10-03T00:00:00.000Z','{}')`;
        yield* f.insert("atomic", "new-binding");
      }),
    );
    expect(yield* f.sql`SELECT dispatch_id FROM project_team_dispatch`).toEqual([
      { dispatch_id: "atomic" },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("retains cleanup ownership through project history deletion only after settlement", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.insert();
    expect(
      (yield* f.sql`DELETE FROM project_team_run_binding WHERE record_id='binding'`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    yield* f.sql`UPDATE project_team_dispatch SET stage='settled' WHERE dispatch_id='dispatch'`;
    yield* f.sql`DELETE FROM project_team_run_binding WHERE record_id='binding'`;
    expect(yield* f.sql`SELECT binding_id,stage FROM project_team_dispatch`).toEqual([
      { binding_id: "binding", stage: "settled" },
    ]);
    yield* runMigrations();
    expect(yield* f.sql`SELECT binding_id FROM project_team_dispatch`).toEqual([
      { binding_id: "binding" },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "keeps setup selection immutable and requires retained physical completion receipts",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.insert();
      yield* f.sql`INSERT INTO project_team_setup_process VALUES
      ('setup','dispatch','owned.service','{}','{}','allocated',NULL,NULL)`;
      expect(
        (yield* f.sql`UPDATE project_team_setup_process SET status='completed'`.pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      expect(
        (yield* f.sql`UPDATE project_team_setup_process SET selection_json='{"changed":true}'`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      yield* f.sql`UPDATE project_team_setup_process SET status='captured',owner_json='{"owner":true}'`;
      expect(
        (yield* f.sql`UPDATE project_team_setup_process SET owner_json='{}'`.pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      yield* f.sql`UPDATE project_team_setup_process SET status='completed',drain_json='{"drained":true}'`;
      expect(
        (yield* f.sql`UPDATE project_team_setup_process SET status='allocated'`.pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      expect(
        (yield* f.sql`UPDATE project_team_setup_process SET drain_json=NULL`.pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("keeps stage receipts append-only and bounded across restart", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.insert();
    const insert = (receipt: string, revision: number, evidence = "{}") =>
      f.sql`INSERT INTO project_team_dispatch_receipt VALUES
        (${receipt},'dispatch',${revision},0,'workspace-ready',${evidence},'2026-10-03T00:00:00.000Z')`;
    yield* insert("receipt", 1);
    expect((yield* insert("other", 1).pipe(Effect.result))._tag).toBe("Failure");
    expect((yield* insert("oversized", 2, "x".repeat(262145)).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    expect(
      (yield* f.sql`UPDATE project_team_dispatch_receipt SET evidence_json='{"changed":true}'`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    expect((yield* f.sql`DELETE FROM project_team_dispatch_receipt`.pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    yield* runMigrations();
    expect(yield* f.sql`SELECT receipt_id,stage FROM project_team_dispatch_receipt`).toEqual([
      { receipt_id: "receipt", stage: "workspace-ready" },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
