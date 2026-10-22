import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Outbox from "../orchestration-v2/EffectOutbox.ts";
import {
  preservationSeedLayer,
  seedUpgradePreservation,
  readUpgradePreservation,
} from "../testUtils/upgradePreservationFixture.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Migrator from "effect/sql/Migrator";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as Sqlite from "./Sqlite.ts";
import {
  assertWorkflowFeatureCompatibility,
  runWorkflowFeatureMigrations,
} from "./WorkflowFeatureMigrations.ts";
import {
  workflowFeatureMigrations,
  type WorkflowFeatureMigration,
} from "./WorkflowFeatureSchema.ts";
import { assertUpstreamUpgradeCompatibility } from "./UpstreamUpgradeCompatibility.ts";

const tableSql =
  "CREATE TABLE t3_workflow_v2_fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL)";
const fixture: WorkflowFeatureMigration = {
  id: Math.max(...workflowFeatureMigrations.map((migration) => migration.id)) + 1,
  name: "Fixture",
  statements: [tableSql, "INSERT INTO t3_workflow_v2_fixture VALUES (1, 'Preserve CASE')"],
  objects: [{ type: "table", name: "t3_workflow_v2_fixture", sql: tableSql }],
};
const manifest = [...workflowFeatureMigrations, fixture];
const memory = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("production fresh boot initializes upstream before the independent feature ledger", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* assertUpstreamUpgradeCompatibility;
    assert.equal(
      (yield* sql`SELECT count(*) AS count FROM effect_sql_migrations`)[0]?.count,
      migrationManifest.length,
    );
    assert.deepStrictEqual(yield* sql`SELECT migration_id,name FROM t3_workflow_v2_migrations`, [
      { migration_id: 1, name: "Foundation" },
      { migration_id: 2, name: "ProjectWork" },
      { migration_id: 3, name: "ProjectTeams" },
      { migration_id: 4, name: "ProjectIssueIntake" },
      { migration_id: 5, name: "ProjectWorkRunAdmission" },
      { migration_id: 6, name: "ProviderInstruction" },
      { migration_id: 7, name: "McpCatalog" },
      { migration_id: 8, name: "ProjectTerminal" },
      { migration_id: 9, name: "ManagedSkills" },
      { migration_id: 10, name: "ProjectTeamDispatch" },
      { migration_id: 11, name: "ProjectWorkDelivery" },
      { migration_id: 12, name: "ProjectMemory" },
      { migration_id: 13, name: "ProjectMemoryProcessing" },
      { migration_id: 14, name: "Assistants" },
      { migration_id: 15, name: "ProjectWorkDeliveryRecovery" },
      { migration_id: 16, name: "AssistantMemory" },
      { migration_id: 17, name: "ThreadHistoryArchive" },
      { migration_id: 18, name: "ExternalNotifications" },
      { migration_id: 19, name: "AssistantRoutines" },
    ]);
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("unknown upstream history rejects before any feature startup writes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 52 });
    yield* sql`INSERT INTO effect_sql_migrations(migration_id,name) VALUES (68,'UnknownUpstream68')`;
    const before = yield* sql`SELECT type,name,sql FROM sqlite_master ORDER BY name`;
    assert.equal(
      (yield* Effect.result(
        assertUpstreamUpgradeCompatibility.pipe(
          Effect.andThen(runMigrations()),
          Effect.andThen(runWorkflowFeatureMigrations()),
        ),
      ))._tag,
      "Failure",
    );
    assert.deepStrictEqual(
      yield* sql`SELECT type,name,sql FROM sqlite_master ORDER BY name`,
      before,
    );
    assert.equal((yield* sql`SELECT count(*) AS count FROM effect_sql_migrations`)[0]?.count, 53);
  }).pipe(Effect.provide(memory)),
);

it.effect(
  "keeps feature history independent on a populated upstream database and repeated startup",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.deepStrictEqual(yield* runWorkflowFeatureMigrations(manifest), [
        [1, "Foundation"],
        [2, "ProjectWork"],
        [3, "ProjectTeams"],
        [4, "ProjectIssueIntake"],
        [5, "ProjectWorkRunAdmission"],
        [6, "ProviderInstruction"],
        [7, "McpCatalog"],
        [8, "ProjectTerminal"],
        [9, "ManagedSkills"],
        [10, "ProjectTeamDispatch"],
        [11, "ProjectWorkDelivery"],
        [12, "ProjectMemory"],
        [13, "ProjectMemoryProcessing"],
        [14, "Assistants"],
        [15, "ProjectWorkDeliveryRecovery"],
        [16, "AssistantMemory"],
        [17, "ThreadHistoryArchive"],
        [18, "ExternalNotifications"],
        [19, "AssistantRoutines"],
        [Math.max(...workflowFeatureMigrations.map((migration) => migration.id)) + 1, "Fixture"],
      ]);
      assert.deepStrictEqual(yield* runWorkflowFeatureMigrations(manifest), []);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        before,
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM t3_workflow_v2_fixture`, [
        { id: 1, value: "Preserve CASE" },
      ]);
      assert.equal(
        yield* assertWorkflowFeatureCompatibility(manifest),
        Math.max(...manifest.map((migration) => migration.id)),
      );
    }).pipe(Effect.provide(memory)),
);

it.effect("allows synthetic upstream 68 after independent feature 68", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const futureFeature = [
      ...workflowFeatureMigrations,
      { id: 68, name: "Feature68", statements: [], objects: [] },
    ];
    yield* runWorkflowFeatureMigrations(futureFeature);
    yield* Migrator.make({})({
      loader: Migrator.fromRecord({ "68_Upstream68": sql`CREATE TABLE upstream_68 (id INTEGER)` }),
    });
    assert.equal(
      (yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 68`)[0]?.name,
      "Upstream68",
    );
    assert.equal(
      (yield* sql`SELECT name FROM t3_workflow_v2_migrations WHERE migration_id = 68`)[0]?.name,
      "Feature68",
    );
    const before = yield* sql`SELECT type,name,sql FROM sqlite_master ORDER BY name`;
    assert.equal((yield* Effect.result(assertUpstreamUpgradeCompatibility))._tag, "Failure");
    assert.deepStrictEqual(
      yield* sql`SELECT type,name,sql FROM sqlite_master ORDER BY name`,
      before,
    );
    assert.equal(migrationManifest.at(-1)?.[0], 67);
  }).pipe(Effect.provide(memory)),
);

it.effect.each([
  "name",
  "ahead",
  "gap",
  "unknown-table",
  "unknown-uppercase",
  "foreign-ledger",
  "missing-table",
  "different-default",
  "external-trigger",
] as const)("rejects %s without schema or history writes", (scenario) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    if (scenario === "foreign-ledger") {
      yield* sql`CREATE TABLE t3_workflow_v2_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)`;
    } else {
      yield* runWorkflowFeatureMigrations(manifest);
      if (scenario === "name")
        yield* sql`UPDATE t3_workflow_v2_migrations SET name = 'Foreign' WHERE migration_id = 1`;
      if (scenario === "ahead")
        yield* sql`INSERT INTO t3_workflow_v2_migrations(migration_id,name) VALUES (999,'Future')`;
      if (scenario === "gap")
        yield* sql`DELETE FROM t3_workflow_v2_migrations WHERE migration_id = 1`;
      if (scenario === "unknown-table")
        yield* sql`CREATE TABLE t3_workflow_v2_unknown (id INTEGER)`;
      if (scenario === "unknown-uppercase")
        yield* sql`CREATE TABLE T3_WORKFLOW_V2_UNKNOWN (id INTEGER)`;
      if (scenario === "missing-table") yield* sql`DROP TABLE t3_workflow_v2_fixture`;
      if (scenario === "different-default") {
        yield* sql`DROP TABLE t3_workflow_v2_fixture`;
        yield* sql`CREATE TABLE t3_workflow_v2_fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL DEFAULT 'foreign')`;
      }
      if (scenario === "external-trigger")
        yield* sql`CREATE TRIGGER foreign_trigger AFTER INSERT ON t3_workflow_v2_fixture BEGIN DELETE FROM t3_workflow_v2_fixture; END`;
    }
    const before = yield* sql`SELECT type,name,sql FROM sqlite_master ORDER BY name`;
    const history = yield* sql`SELECT * FROM t3_workflow_v2_migrations ORDER BY migration_id`;
    assert.equal((yield* Effect.result(runWorkflowFeatureMigrations(manifest)))._tag, "Failure");
    assert.deepStrictEqual(
      yield* sql`SELECT type,name,sql FROM sqlite_master ORDER BY name`,
      before,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM t3_workflow_v2_migrations ORDER BY migration_id`,
      history,
    );
  }).pipe(Effect.provide(memory)),
);

it.effect("refuses an unledgered pre-existing object even if it has the expected shape", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(tableSql);
    assert.equal((yield* Effect.result(runWorkflowFeatureMigrations(manifest)))._tag, "Failure");
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name = 't3_workflow_v2_migrations'`,
      [],
    );
  }).pipe(Effect.provide(memory)),
);

it.effect("accepts identifier case but preserves exact SQL string literal case", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const declaration = "CREATE TABLE t3_workflow_v2_case (value TEXT DEFAULT 'KeepCASE')";
    const migrations = [
      ...workflowFeatureMigrations,
      {
        id: Math.max(...workflowFeatureMigrations.map((migration) => migration.id)) + 1,
        name: "Case",
        statements: ["CREATE TABLE T3_WORKFLOW_V2_CASE (VALUE text DEFAULT 'KeepCASE')"],
        objects: [{ type: "table" as const, name: "t3_workflow_v2_case", sql: declaration }],
      },
    ];
    yield* runMigrations();
    yield* runWorkflowFeatureMigrations(migrations);
    yield* sql`DROP TABLE t3_workflow_v2_case`;
    yield* sql`CREATE TABLE t3_workflow_v2_case (value TEXT DEFAULT 'keepcase')`;
    assert.equal(
      (yield* Effect.result(assertWorkflowFeatureCompatibility(migrations)))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(memory)),
);

it.effect("rolls back interrupted DDL, data and history and retries exactly once", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const before = yield* sql`SELECT type,name,sql FROM sqlite_master ORDER BY name`;
    const created = yield* Deferred.make<void>();
    const hold = yield* Deferred.make<void>();
    const fiber = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* runWorkflowFeatureMigrations(manifest);
          yield* Deferred.succeed(created, undefined);
          yield* Deferred.await(hold);
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(created);
    yield* Fiber.interrupt(fiber);
    assert.deepStrictEqual(
      yield* sql`SELECT type,name,sql FROM sqlite_master ORDER BY name`,
      before,
    );
    yield* runWorkflowFeatureMigrations(manifest);
    assert.deepStrictEqual(yield* runWorkflowFeatureMigrations(manifest), []);
    assert.equal((yield* sql`SELECT count(*) AS count FROM t3_workflow_v2_fixture`)[0]?.count, 1);
  }).pipe(Effect.provide(memory)),
);

it.effect("rolls back a failed later migration along with earlier feature changes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const broken = [
      ...manifest,
      { id: 8, name: "Broken", statements: ["INSERT INTO missing_table VALUES (1)"], objects: [] },
    ];
    assert.equal((yield* Effect.result(runWorkflowFeatureMigrations(broken)))._tag, "Failure");
    assert.deepStrictEqual(yield* sql`SELECT name FROM sqlite_master`, []);
    yield* runMigrations();
    yield* runWorkflowFeatureMigrations(manifest);
  }).pipe(Effect.provide(memory)),
);

it.effect(
  "the stock upstream runner and readers accept post-feature conversations and drain ordinary work past unknown synthetic lanes",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runWorkflowFeatureMigrations();
      yield* assertUpstreamUpgradeCompatibility;
      // These upstream modules remain unchanged from the pinned upstream foundation.
      yield* seedUpgradePreservation("/fixture-workspace");
      const before = yield* readUpgradePreservation();
      assert.deepStrictEqual(yield* runMigrations(), []);
      const after = yield* readUpgradePreservation();
      assert.deepStrictEqual(after, before);
      assert.deepStrictEqual(
        after.conversation.messages.map((message) => message.text),
        ["Keep the saved request", "Keep the saved answer"],
      );
      for (const [id, status, available] of [
        ["synthetic-future", "pending", "9999-01-01T00:00:00.000Z"],
        ["synthetic-running", "running", "1970-01-01T00:00:00.000Z"],
        ["synthetic-due", "pending", "1970-01-01T00:00:00.000Z"],
      ] as const) {
        yield* sql`INSERT INTO orchestration_v2_effect_outbox (
        effect_id, command_id, thread_id, effect_type, payload_json, status,
        attempt_count, available_at, created_at, updated_at, lease_owner, lease_expires_at
      ) VALUES (${id}, 'synthetic-command', ${id}, 'future-feature.control',
        '{"type":"future-feature.control"}', ${status}, 0, ${available},
        '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z',
        ${status === "running" ? "former-feature-worker" : null},
        ${status === "running" ? "9999-01-01T00:00:00.000Z" : null})`;
      }
      const outbox = yield* Outbox.EffectOutboxV2;
      assert.equal((yield* Effect.result(outbox.get("synthetic-future")))._tag, "Failure");
      const claim = { workerId: "stock-worker", leaseDurationMs: 60_000 };
      assert.equal((yield* Effect.result(outbox.claimNext(claim)))._tag, "Failure");
      // Release the authored fixture's already-running ordinary effect before claiming its sibling.
      assert.isTrue(
        yield* outbox.succeed({
          effectId: "preservation-running",
          workerId: "previous-fixture-worker",
        }),
      );
      const ordinary = Option.getOrThrow(yield* outbox.claimNext(claim));
      assert.equal(ordinary.id, "preservation-pending");
      assert.isTrue(yield* outbox.succeed({ effectId: ordinary.id, workerId: claim.workerId }));
      assert.isTrue(Option.isNone(yield* outbox.claimNext(claim)));
      const remaining =
        yield* sql`SELECT effect_id,status FROM orchestration_v2_effect_outbox WHERE command_id = 'synthetic-command' ORDER BY effect_id`;
      assert.deepStrictEqual(remaining, [
        { effect_id: "synthetic-due", status: "running" },
        { effect_id: "synthetic-future", status: "pending" },
        { effect_id: "synthetic-running", status: "running" },
      ]);
    }).pipe(Effect.provide(preservationSeedLayer.pipe(Layer.provideMerge(memory)))),
);

it.effect(
  "admission objects remain inside the feature namespace and schema tampering fails closed",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runWorkflowFeatureMigrations();
      const objects = yield* sql<{
        name: string;
        tbl_name: string;
      }>`SELECT name,tbl_name FROM sqlite_master WHERE name LIKE 't3_workflow_v2_%admission%'`;
      assert.isTrue(objects.length >= 4);
      assert.isTrue(
        objects.every(
          (object) =>
            object.name.startsWith("t3_workflow_v2_") &&
            object.tbl_name.startsWith("t3_workflow_v2_"),
        ),
      );
      yield* sql`ALTER TABLE t3_workflow_v2_admission_controls ADD COLUMN foreign_payload TEXT`;
      const outcome = yield* Effect.result(assertWorkflowFeatureCompatibility());
      assert.equal(outcome._tag, "Failure");
    }).pipe(Effect.provide(memory)),
);

it.effect(
  "upgrades populated P5 state with only declared instruction objects and one ledger row",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runWorkflowFeatureMigrations(workflowFeatureMigrations.slice(0, 5));
      yield* seedUpgradePreservation("/fixture-workspace");
      const payload = '{ "roleInstructions": "Keep CASE \\u2603", "revision": 5 }';
      yield* sql`INSERT INTO t3_workflow_v2_team_records VALUES ('existing', 'project', 'snapshot', NULL, 5, ${payload})`;
      const before = yield* readUpgradePreservation();
      const schema = yield* sql`SELECT type,name,sql FROM sqlite_master ORDER BY name`;
      const upstream = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const featureHistory =
        yield* sql`SELECT * FROM t3_workflow_v2_migrations ORDER BY migration_id`;
      assert.deepStrictEqual(
        yield* runWorkflowFeatureMigrations(workflowFeatureMigrations.slice(0, 6)),
        [[6, "ProviderInstruction"]],
      );
      yield* assertUpstreamUpgradeCompatibility;
      assert.deepStrictEqual(yield* readUpgradePreservation(), before);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        upstream,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM t3_workflow_v2_migrations WHERE migration_id <= 5 ORDER BY migration_id`,
        featureHistory,
      );
      assert.equal(
        (yield* sql`SELECT payload_json FROM t3_workflow_v2_team_records WHERE record_id = 'existing'`)[0]
          ?.payload_json,
        payload,
      );
      const originalNames = new Set(schema.map((object) => object.name));
      const after = yield* sql`SELECT type,name,sql FROM sqlite_master ORDER BY name`;
      assert.deepStrictEqual(
        after.filter((object) => originalNames.has(object.name)),
        schema,
      );
      assert.deepStrictEqual(
        after.filter((object) => !originalNames.has(object.name)).map((object) => object.name),
        [
          "sqlite_autoindex_t3_workflow_v2_instruction_deliveries_1",
          "t3_workflow_v2_idx_instruction_deliveries_session",
          "t3_workflow_v2_instruction_deliveries",
        ],
      );
      assert.equal(
        (yield* sql`SELECT count(*) AS count FROM t3_workflow_v2_instruction_deliveries`)[0]?.count,
        0,
      );
      assert.deepStrictEqual(
        yield* runWorkflowFeatureMigrations(workflowFeatureMigrations.slice(0, 6)),
        [],
      );
    }).pipe(Effect.provide(preservationSeedLayer.pipe(Layer.provideMerge(memory)))),
);

it.effect("interrupted P6 upgrade leaves the populated P5 ledger and schema intact", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runWorkflowFeatureMigrations(workflowFeatureMigrations.slice(0, 5));
    const schema = yield* sql`SELECT type,name,sql FROM sqlite_master ORDER BY name`;
    const history = yield* sql`SELECT * FROM t3_workflow_v2_migrations ORDER BY migration_id`;
    const migrated = yield* Deferred.make<void>();
    const hold = yield* Deferred.make<void>();
    const fiber = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* runWorkflowFeatureMigrations(workflowFeatureMigrations.slice(0, 6));
          yield* Deferred.succeed(migrated, undefined);
          yield* Deferred.await(hold);
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(migrated);
    yield* Fiber.interrupt(fiber);
    assert.deepStrictEqual(
      yield* sql`SELECT type,name,sql FROM sqlite_master ORDER BY name`,
      schema,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM t3_workflow_v2_migrations ORDER BY migration_id`,
      history,
    );
    assert.deepStrictEqual(
      yield* runWorkflowFeatureMigrations(workflowFeatureMigrations.slice(0, 6)),
      [[6, "ProviderInstruction"]],
    );
    assert.deepStrictEqual(
      yield* runWorkflowFeatureMigrations(workflowFeatureMigrations.slice(0, 6)),
      [],
    );
  }).pipe(Effect.provide(memory)),
);

it.effect.each(["unledgered", "column", "index"] as const)(
  "refuses %s instruction delivery schema without writes",
  (scenario) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runWorkflowFeatureMigrations(workflowFeatureMigrations.slice(0, 5));
      if (scenario === "unledgered") {
        for (const statement of workflowFeatureMigrations[5]!.statements)
          yield* sql.unsafe(statement);
      } else {
        yield* runWorkflowFeatureMigrations();
        if (scenario === "column") {
          yield* sql`ALTER TABLE t3_workflow_v2_instruction_deliveries ADD COLUMN foreign_snapshot TEXT`;
        } else {
          yield* sql`DROP INDEX t3_workflow_v2_idx_instruction_deliveries_session`;
          yield* sql`CREATE INDEX t3_workflow_v2_idx_instruction_deliveries_session ON t3_workflow_v2_instruction_deliveries(provider_session_id)`;
        }
      }
      const schema = yield* sql`SELECT type,name,sql FROM sqlite_master ORDER BY name`;
      const history = yield* sql`SELECT * FROM t3_workflow_v2_migrations ORDER BY migration_id`;
      assert.equal((yield* Effect.result(runWorkflowFeatureMigrations()))._tag, "Failure");
      assert.deepStrictEqual(
        yield* sql`SELECT type,name,sql FROM sqlite_master ORDER BY name`,
        schema,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM t3_workflow_v2_migrations ORDER BY migration_id`,
        history,
      );
    }).pipe(Effect.provide(memory)),
);

it.effect(
  "retains instruction snapshot bytes and attempt correlations across repeated startup",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runWorkflowFeatureMigrations();
      const snapshot =
        '{ "configurationHash":"config-1", "resourceRevision":"resource-2", "memoryEpoch":0, "roleInstructions":"Keep \\u2603 CASE", "toolIds":["tool-b","tool-a"], "skillIds":["skill-1"] }';
      const createdAt = "2026-01-01T00:00:00.000Z";
      yield* sql`INSERT INTO t3_workflow_v2_instruction_deliveries (
      run_attempt_id, thread_id, run_id, provider_thread_id, provider_session_id,
      run_ordinal, requested_snapshot_json, state, created_at
    ) VALUES ('attempt-1', 'thread-1', 'run-1', 'provider-thread-1', 'session-1',
      1, ${snapshot}, 'pending', ${createdAt})`;
      assert.deepStrictEqual(
        yield* sql`SELECT applied_snapshot_json, applied_at FROM t3_workflow_v2_instruction_deliveries`,
        [{ applied_snapshot_json: null, applied_at: null }],
      );
      yield* sql`UPDATE t3_workflow_v2_instruction_deliveries
      SET state = 'applied', applied_snapshot_json = ${snapshot}, applied_at = ${createdAt}
      WHERE run_attempt_id = 'attempt-1'`;
      const before = yield* sql`SELECT * FROM t3_workflow_v2_instruction_deliveries`;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* runWorkflowFeatureMigrations(), []);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM t3_workflow_v2_instruction_deliveries`,
        before,
      );
      assert.deepStrictEqual(before, [
        {
          run_attempt_id: "attempt-1",
          thread_id: "thread-1",
          run_id: "run-1",
          provider_thread_id: "provider-thread-1",
          provider_session_id: "session-1",
          run_ordinal: 1,
          requested_snapshot_json: snapshot,
          applied_snapshot_json: snapshot,
          state: "applied",
          reason: null,
          created_at: createdAt,
          applied_at: createdAt,
        },
      ]);
      assert.equal(
        (yield* Effect.result(
          sql`UPDATE t3_workflow_v2_instruction_deliveries SET state = 'foreign'`,
        ))._tag,
        "Failure",
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM t3_workflow_v2_instruction_deliveries`,
        before,
      );
    }).pipe(Effect.provide(memory)),
);

it.effect(
  "P7 upgrades populated P6 without rewriting upstream, work, instructions, or preserved payload bytes",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runWorkflowFeatureMigrations(workflowFeatureMigrations.slice(0, 6));
      yield* seedUpgradePreservation("/fixture-workspace");
      const instructionBytes =
        '{ "configurationHash":"old-configuration", "roleInstructions":"Keep \\u2603 CASE", "toolIds":["b","a"] }';
      yield* sql`INSERT INTO t3_workflow_v2_instruction_deliveries(run_attempt_id,thread_id,run_id,provider_thread_id,provider_session_id,run_ordinal,requested_snapshot_json,state,created_at) VALUES('retained-attempt','retained-thread','retained-run','retained-provider-thread','retained-provider-session',1,${instructionBytes},'pending','2026-01-01T00:00:00.000Z')`;
      const before = yield* readUpgradePreservation();
      const schema = yield* sql`SELECT type,name,sql FROM sqlite_master ORDER BY name`;
      const upstream = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const features = yield* sql`SELECT * FROM t3_workflow_v2_migrations ORDER BY migration_id`;
      const instructions = yield* sql`SELECT * FROM t3_workflow_v2_instruction_deliveries`;
      assert.deepStrictEqual(
        yield* runWorkflowFeatureMigrations(workflowFeatureMigrations.slice(0, 7)),
        [[7, "McpCatalog"]],
      );
      assert.deepStrictEqual(yield* readUpgradePreservation(), before);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        upstream,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM t3_workflow_v2_migrations WHERE migration_id<=6 ORDER BY migration_id`,
        features,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM t3_workflow_v2_instruction_deliveries`,
        instructions,
      );
      const originalNames = new Set(schema.map((object) => object.name));
      const after = yield* sql`SELECT type,name,sql FROM sqlite_master ORDER BY name`;
      assert.deepStrictEqual(
        after.filter((object) => originalNames.has(object.name)),
        schema,
      );
      assert.deepStrictEqual(
        after.filter((object) => !originalNames.has(object.name)).map((object) => object.name),
        [
          "sqlite_autoindex_t3_workflow_v2_mcp_catalog_scopes_1",
          "sqlite_autoindex_t3_workflow_v2_mcp_catalog_sessions_1",
          "t3_workflow_v2_mcp_catalog_active_thread",
          "t3_workflow_v2_mcp_catalog_pending",
          "t3_workflow_v2_mcp_catalog_scopes",
          "t3_workflow_v2_mcp_catalog_sessions",
          "t3_workflow_v2_mcp_catalog_thread",
        ],
      );
      assert.deepStrictEqual(
        yield* runWorkflowFeatureMigrations(workflowFeatureMigrations.slice(0, 7)),
        [],
      );
    }).pipe(Effect.provide(preservationSeedLayer.pipe(Layer.provideMerge(memory)))),
);
