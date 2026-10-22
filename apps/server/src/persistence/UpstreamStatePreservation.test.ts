// @effect-diagnostics nodeBuiltinImport:off -- All databases and settings belong to temporary fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as LegacyImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { runMigrations, migrationManifest } from "./Migrations.ts";
import {
  prepareUpgradeSnapshot,
  inventoryUpgradeDatabase,
} from "../testUtils/prepareUpgradeSnapshot.ts";
import { upgradeValidationRuntime } from "../testUtils/upgradeValidationRuntime.ts";
import {
  preservationIds,
  preservationRepositoryLayer,
  preservationSeedLayer,
  preservationSettingsLayer,
  readUpgradePreservation,
  seedUpgradePreservation,
  writePreservationSettings,
  seedLegacyPreservation,
  legacyPreservationThread,
} from "../testUtils/upgradePreservationFixture.ts";

it.effect(
  "preserves decoded saved work, continuation, authentication and schedules from migration 66 through two isolated boots",
  () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-semantic-upgrade-"));
      try {
        const sourceRoot = NodePath.join(root, "source");
        const workspace = NodePath.join(root, "workspace");
        const disposableRoot = NodePath.join(root, "snapshot");
        for (const path of [sourceRoot, workspace, disposableRoot]) NodeFS.mkdirSync(path);
        const dbPath = NodePath.join(sourceRoot, "statev2.sqlite");
        const sourceDatabase = NodeSqliteClient.layer({ filename: dbPath });
        yield* runMigrations({ toMigrationInclusive: 66 }).pipe(Effect.provide(sourceDatabase));
        const sourceServices = preservationSeedLayer.pipe(Layer.provideMerge(sourceDatabase));
        yield* seedUpgradePreservation(workspace).pipe(Effect.provide(sourceServices));
        const before = yield* readUpgradePreservation().pipe(Effect.provide(sourceServices));
        assert.deepEqual(
          before.conversation.messages.map((message) => message.text),
          ["Keep the saved request", "Keep the saved answer"],
        );
        assert.equal(before.conversation.thread.projectId, preservationIds.project);
        const forkSource = before.fork.forkedFrom;
        if (forkSource?.type !== "run") throw new Error("Expected a run fork source");
        assert.equal(forkSource.threadId, preservationIds.thread);
        assert.equal(before.conversation.checkpoints[0]?.ref, "refs/t3/preservation/1");
        assert.equal(before.conversation.checkpoints[0]?.scopeId, preservationIds.scope);
        assert.equal(before.conversation.checkpointScopes[0]?.runId, preservationIds.run);
        assert.equal(forkSource.runId, preservationIds.run);
        assert.deepEqual(before.runtime.resumeCursor, {
          threadId: "native-conversation",
          lastNativeTurnId: "native-turn",
        });
        assert.equal(
          before.conversation.providerThreads[0]?.nativeThreadRef?.nativeId,
          "native-conversation",
        );
        assert.equal(before.conversation.providerSessions[0]?.id, preservationIds.session);
        assert.equal(before.pullRequests[0]?.pullRequests?.[0]?.number, 42);
        assert.equal(before.receipt.status, "accepted");
        assert.equal(before.auth.client.label, "Fixture remote client");
        assert.deepEqual(before.auth.scopes, ["orchestration:read", "orchestration:operate"]);
        assert.deepEqual(before.effects.map((effect) => effect.status).toSorted(), [
          "pending",
          "running",
        ]);
        assert.lengthOf(before.schedules, 1);
        assert.isTrue(before.schedules[0]!.enabled);
        assert.equal(before.schedules[0]!.projectId, preservationIds.project);
        assert.equal(before.schedules[0]!.threadId, preservationIds.thread);
        assert.equal(before.history.totalItems, 2);
        assert.isAbove(before.events.length, 8);
        const created = before.events
          .map((stored) => stored.event)
          .find((event) => event.type === "thread.created");
        if (!created || created.type !== "thread.created")
          throw new Error("Missing source create event");
        const replayed = before.events
          .map((stored) => stored.event)
          .reduce(ProjectionStore.applyToProjection, ProjectionStore.emptyProjection(created));
        assert.deepEqual(replayed, before.conversation);
        const sourceInventory = inventoryUpgradeDatabase(dbPath);
        const sourceBytes = NodeFS.readFileSync(dbPath);
        const snapshot = yield* Effect.promise(() =>
          prepareUpgradeSnapshot({
            configured: { dbPath },
            disposableRoot,
            activeDatabasePaths: [dbPath],
          }),
        );
        const untouchedBytes = NodeFS.readFileSync(snapshot.untouchedPath);
        for (let boot = 0; boot < 2; boot++) {
          const runtime = upgradeValidationRuntime(snapshot);
          const readers = preservationRepositoryLayer.pipe(Layer.provideMerge(runtime));
          const after = yield* readUpgradePreservation().pipe(Effect.provide(readers));
          assert.deepEqual(after, before);
        }
        const runtimeDb = new NodeSqlite.DatabaseSync(snapshot.runtimePath, { readOnly: true });
        try {
          assert.equal(
            runtimeDb.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get()
              ?.id,
            migrationManifest.at(-1)?.[0],
          );
        } finally {
          runtimeDb.close();
        }
        assert.deepEqual(NodeFS.readFileSync(snapshot.untouchedPath), untouchedBytes);
        assert.deepEqual(NodeFS.readFileSync(dbPath), sourceBytes);
        assert.deepEqual(inventoryUpgradeDatabase(dbPath), sourceInventory);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "reads copied synthetic settings through the production settings service across repeated starts",
  () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-settings-upgrade-"));
      try {
        const sourceRoot = NodePath.join(root, "source");
        const runtimeRoot = NodePath.join(root, "runtime");
        NodeFS.mkdirSync(sourceRoot);
        NodeFS.mkdirSync(runtimeRoot);
        const sourceConfig = ServerConfig.layerTest(sourceRoot, sourceRoot);
        yield* writePreservationSettings().pipe(Effect.provide(sourceConfig));
        const source = yield* Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return config.settingsPath;
        }).pipe(Effect.provide(sourceConfig));
        const runtime = yield* Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return config.settingsPath;
        }).pipe(Effect.provide(ServerConfig.layerTest(runtimeRoot, runtimeRoot)));
        NodeFS.mkdirSync(NodePath.dirname(runtime), { recursive: true });
        NodeFS.copyFileSync(source, runtime);
        const database = NodeSqliteClient.layer({
          filename: NodePath.join(root, "settings.sqlite"),
        });
        yield* runMigrations().pipe(Effect.provide(database));
        const read = Effect.gen(function* () {
          return yield* (yield* ServerSettings.ServerSettingsService).getSettings;
        });
        const before = yield* read.pipe(
          Effect.provide(preservationSettingsLayer(sourceRoot).pipe(Layer.provide(database))),
        );
        assert.isFalse(before.continueThreadsAfterServerUpdate);
        assert.equal(before.responseStreamingMode, "turn");
        for (let boot = 0; boot < 2; boot++) {
          const after = yield* read.pipe(
            Effect.provide(preservationSettingsLayer(runtimeRoot).pipe(Layer.provide(database))),
          );
          assert.deepEqual(after, before);
        }
        assert.deepEqual(NodeFS.readFileSync(runtime), NodeFS.readFileSync(source));
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "upgrades migration 52 legacy shells without eagerly importing history and hydrates the full transcript idempotently",
  () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-legacy-preservation-"));
      try {
        const sourceRoot = NodePath.join(root, "source");
        const workspace = NodePath.join(root, "workspace");
        const disposableRoot = NodePath.join(root, "snapshot");
        for (const path of [sourceRoot, workspace, disposableRoot]) NodeFS.mkdirSync(path);
        const dbPath = NodePath.join(sourceRoot, "statev2.sqlite");
        const sourceDatabase = NodeSqliteClient.layer({ filename: dbPath });
        yield* Effect.gen(function* () {
          yield* runMigrations({ toMigrationInclusive: 52 });
          yield* seedLegacyPreservation(workspace);
        }).pipe(Effect.provide(sourceDatabase));
        const original = NodeFS.readFileSync(dbPath);
        const snapshot = yield* Effect.promise(() =>
          prepareUpgradeSnapshot({
            configured: { dbPath },
            disposableRoot,
            activeDatabasePaths: [dbPath],
          }),
        );
        const untouched = NodeFS.readFileSync(snapshot.untouchedPath);
        // The isolated runtime performs schema upgrade first; transcript import remains user driven.
        yield* Effect.void.pipe(Effect.provide(upgradeValidationRuntime(snapshot)));
        const services = preservationSeedLayer.pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: snapshot.runtimePath })),
        );
        const importerLayer = LegacyImporter.layer.pipe(Layer.provideMerge(services));
        const imported = yield* Effect.gen(function* () {
          const importer = yield* LegacyImporter.LegacyV1ThreadImporter;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const sql = yield* SqlClient.SqlClient;
          yield* importer.reconcileShells;
          assert.equal(yield* importer.pendingThreadCount, 1);
          const shell = yield* projections.getThreadProjection(legacyPreservationThread);
          assert.deepEqual(
            shell.messages.map((message) => message.text),
            ["Legacy saved text 4", "Legacy saved text 5"],
          );
          assert.equal(
            (yield* sql`SELECT transcript_imported_at FROM orchestration_v2_legacy_imports WHERE thread_id = ${legacyPreservationThread}`)[0]
              ?.transcript_imported_at,
            null,
          );
          yield* importer.ensureTranscript(legacyPreservationThread);
          const full = yield* projections.getThreadProjection(legacyPreservationThread);
          assert.equal(yield* importer.pendingThreadCount, 0);
          assert.deepEqual(
            full.messages.map((message) => message.text),
            Array.from({ length: 6 }, (_, index) => `Legacy saved text ${index}`),
          );
          assert.equal(full.thread.projectId, "legacy-preservation-project");
          assert.equal(
            (yield* sql`SELECT imported_message_count FROM orchestration_v2_legacy_imports WHERE thread_id = ${legacyPreservationThread}`)[0]
              ?.imported_message_count,
            6,
          );
          yield* importer.ensureTranscript(legacyPreservationThread);
          assert.deepEqual(yield* projections.getThreadProjection(legacyPreservationThread), full);
          return full;
        }).pipe(Effect.provide(importerLayer));
        for (let boot = 0; boot < 2; boot++) {
          const restored = yield* Effect.gen(function* () {
            return yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
              legacyPreservationThread,
            );
          }).pipe(Effect.provide(upgradeValidationRuntime(snapshot)));
          assert.deepEqual(restored, imported);
        }
        assert.deepEqual(NodeFS.readFileSync(dbPath), original);
        assert.deepEqual(NodeFS.readFileSync(snapshot.untouchedPath), untouched);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
