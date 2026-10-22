// @effect-diagnostics nodeBuiltinImport:off -- These tests create and remove only their own temporary fixtures.
import * as NodeFS from "node:fs";
import {
  normalizeWorkflowSchemaSql,
  workflowFeatureLedger,
  workflowFeatureMigrations,
} from "../persistence/WorkflowFeatureSchema.ts";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layerFixtureFilesystem, mapUpgradeFixturePath } from "./upgradeFixtureFilesystem.ts";
import { assert, expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  RunId,
  RunAttemptId,
  NodeId,
  ProviderTurnId,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as ProviderRuntimeRecoveryService from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderTurnStartService from "../orchestration-v2/ProviderTurnStartService.ts";
import * as ProviderTurnControlService from "../orchestration-v2/ProviderTurnControlService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import { UpgradeFixtureScheduler } from "./upgradeFixtureServices.ts";
import { UpgradeFixtureNative } from "./upgradeFixtureNative.ts";
import {
  preservationSeedLayer,
  preservationIds,
  seedUpgradePreservation,
} from "./upgradePreservationFixture.ts";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import {
  prepareUpgradeSnapshot,
  inventoryUpgradeDatabase,
  assertDisposablePath,
} from "./prepareUpgradeSnapshot.ts";
import { upgradeValidationRuntime, UpgradeValidationEffects } from "./upgradeValidationRuntime.ts";

const requestFixtureHealth = (origin: string, token?: string) =>
  new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
    const request = NodeHttp.get(
      `${origin}/health`,
      { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on("error", reject);
  });

const decodeScheduledTask = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const seed = Effect.fn("upgradeFixture.seed")(function* (source: string) {
  yield* runMigrations();
  const sink = yield* EventSink.EventSinkV2;
  yield* sink.commitProjectCommand({
    commandId: CommandId.make("create-project"),
    projectId: ProjectId.make("project"),
    commandType: "project.create",
    acceptedAt: yield* DateTime.now,
    event: {
      eventId: EventId.make("project-created"),
      aggregateKind: "project",
      aggregateId: ProjectId.make("project"),
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: ProjectId.make("project"),
        title: "Preserved project",
        workspaceRoot: source,
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  });
  const sql = yield* SqlClient.SqlClient;
  // An unknown ledger is inventoried as unknown provenance; only the reserved namespace is rejected.
  yield* sql`CREATE TABLE other_migrations (id INTEGER PRIMARY KEY, private_value TEXT)`;
  yield* sql`INSERT INTO other_migrations VALUES (1, 'credential-that-must-not-be-reported')`;
});

function assertOnlyDeclaredWorkflowObjectsAdded(
  filename: string,
  before: ReturnType<typeof inventoryUpgradeDatabase>,
) {
  const database = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
  try {
    assert.deepEqual(
      database.prepare("SELECT migration_id, name FROM t3_workflow_v2_migrations").all(),
      [
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
      ],
    );
    const declarations = [
      workflowFeatureLedger,
      ...workflowFeatureMigrations.flatMap((migration) => migration.objects),
    ];
    for (const object of declarations) {
      const stored = database
        .prepare("SELECT type, sql FROM sqlite_master WHERE name = ?")
        .get(object.name);
      assert.equal(stored?.type, object.type);
      assert.equal(
        normalizeWorkflowSchemaSql(String(stored?.sql)),
        normalizeWorkflowSchemaSql(object.sql),
      );
      if (
        object.type === "table" &&
        object.name !== workflowFeatureLedger.name &&
        !new Set([
          "t3_workflow_v2_work_search_fts_data",
          "t3_workflow_v2_work_search_fts_config",
        ]).has(object.name)
      ) {
        assert.equal(
          database.prepare(`SELECT count(*) AS count FROM "${object.name}"`).get()?.count,
          0,
        );
      }
    }
  } finally {
    database.close();
  }
  const after = inventoryUpgradeDatabase(filename);
  const declared = new Set([
    workflowFeatureLedger.name,
    ...workflowFeatureMigrations.flatMap((migration) =>
      migration.objects.map((object) => object.name),
    ),
  ]);
  const originalNames = new Set(before.objects.map((object) => object.name));
  for (const object of after.objects) {
    if (originalNames.has(object.name) || declared.has(String(object.name))) continue;
    // SQLite owns constraint indexes; only a declared table may introduce one.
    assert.isTrue(
      String(object.name).startsWith("sqlite_autoindex_") && declared.has(String(object.tbl_name)),
    );
  }
  assert.deepEqual(
    {
      objects: after.objects.filter(({ name }) => originalNames.has(name)),
      contents: after.contents.filter(({ name }) => !declared.has(name)),
      ledgers: after.ledgers.filter(({ name }) => !declared.has(name)),
    },
    before,
  );
}

it.effect(
  "backs up committed WAL data and keeps an untouched private copy through repeated read-model startup",
  () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-upgrade-test-"));
      try {
        const source = NodePath.join(root, "active");
        const disposableRoot = NodePath.join(root, "disposable");
        NodeFS.mkdirSync(source);
        NodeFS.mkdirSync(disposableRoot);
        const dbPath = NodePath.join(source, "statev2.sqlite");
        yield* seed(source).pipe(
          Effect.provide(
            EventSink.layer.pipe(
              Layer.provide(Layer.mergeAll(EventStore.layer, ProjectionStore.layer)),
              Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath })),
            ),
          ),
        );
        const writer = new NodeSqlite.DatabaseSync(dbPath);
        try {
          writer.exec(
            "PRAGMA journal_mode=WAL; INSERT INTO other_migrations VALUES (2,'committed'); BEGIN; INSERT INTO other_migrations VALUES (3,'not committed')",
          );
          const fixture = yield* Effect.promise(() =>
            prepareUpgradeSnapshot({
              configured: { dbPath },
              disposableRoot,
              activeDatabasePaths: [dbPath],
            }),
          );
          assert.equal(
            fixture.inventory.contents.find(({ name }) => name === "other_migrations")?.count,
            2,
          );
          assert.isFalse(
            JSON.stringify(fixture.inventory).includes("credential-that-must-not-be-reported"),
          );
          assert.include(
            fixture.inventory.ledgers.map(({ name }) => name),
            "other_migrations",
          );
          assert.throws(
            () => upgradeValidationRuntime({ ...fixture, runtimePath: dbPath }),
            "unrecognized",
          );
          const before = inventoryUpgradeDatabase(fixture.runtimePath);
          const untouchedBytes = NodeFS.readFileSync(fixture.untouchedPath);
          const overlay = fixture.projects[0];
          assert.isDefined(overlay);
          if (!overlay) throw new Error("Missing project overlay");
          NodeFS.writeFileSync(NodePath.join(overlay.sandboxRoot, "fixture.txt"), "safe");
          NodeFS.symlinkSync(source, NodePath.join(overlay.sandboxRoot, "escape"));
          for (let boot = 0; boot < 2; boot++) {
            yield* Effect.gen(function* () {
              const projects = yield* ProjectStore.ProjectStoreV2;
              const project = Option.getOrThrow(yield* projects.get(ProjectId.make("project")));
              assert.equal(project.workspaceRoot, overlay.sandboxRoot);
              assert.equal(project.title, "Preserved project");
              assert.isEmpty(yield* (yield* ProviderRegistry.ProviderRegistry).getProviders);
              assert.isEmpty(
                yield* (yield* ProviderInstanceRegistry.ProviderInstanceRegistry).listInstances,
              );
              const effects = yield* UpgradeValidationEffects;
              assert.equal(yield* effects.readFile("project", "fixture.txt"), "safe");
              for (const path of ["../escape", "/etc/passwd", "escape/statev2.sqlite"])
                assert.equal(
                  (yield* Effect.result(effects.readFile("project", path)))._tag,
                  "Failure",
                );
            }).pipe(Effect.provide(upgradeValidationRuntime(fixture)));
          }
          assertOnlyDeclaredWorkflowObjectsAdded(fixture.runtimePath, before);
          assert.deepEqual(NodeFS.readFileSync(fixture.untouchedPath), untouchedBytes);
          writer.exec("ROLLBACK");
          assert.equal(
            inventoryUpgradeDatabase(dbPath).contents.find(
              ({ name }) => name === "other_migrations",
            )?.count,
            2,
          );
        } finally {
          writer.close();
        }
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
);

it("rejects path escapes and active-directory aliases before creating a fixture", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-upgrade-guards-"));
  try {
    const active = NodePath.join(root, "active");
    NodeFS.mkdirSync(active);
    const dbPath = NodePath.join(active, "statev2.sqlite");
    const db = new NodeSqlite.DatabaseSync(dbPath);
    db.close();
    const nested = NodePath.join(active, "test");
    NodeFS.mkdirSync(nested);
    await expect(
      prepareUpgradeSnapshot({
        configured: { dbPath },
        disposableRoot: nested,
        activeDatabasePaths: [],
      }),
    ).rejects.toThrow("overlaps");
    assert.deepEqual(NodeFS.readdirSync(nested), []);
    const alias = NodePath.join(root, "alias");
    NodeFS.symlinkSync(active, alias);
    const disposable = NodePath.join(root, "disposable");
    NodeFS.mkdirSync(disposable);
    NodeFS.symlinkSync(active, NodePath.join(disposable, "escape"));
    assert.throws(
      () => assertDisposablePath(disposable, NodePath.join(disposable, "escape", "statev2.sqlite")),
      "outside",
    );
    await expect(
      prepareUpgradeSnapshot({
        configured: { dbPath },
        disposableRoot: alias,
        activeDatabasePaths: [],
      }),
    ).rejects.toThrow("empty");
    await expect(
      prepareUpgradeSnapshot({
        configured: { dbPath },
        disposableRoot: disposable,
        activeDatabasePaths: [],
      }),
    ).rejects.toThrow("empty");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it.effect.each(["source", "untouched"] as const)(
  "rejects a stale Layer whose runtime path was redirected to %s",
  (target) =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-upgrade-stale-"));
      try {
        const source = NodePath.join(root, "source");
        const disposableRoot = NodePath.join(root, "disposable");
        NodeFS.mkdirSync(source);
        NodeFS.mkdirSync(disposableRoot);
        const dbPath = NodePath.join(source, "statev2.sqlite");
        yield* runMigrations().pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        const fixture = yield* Effect.promise(() =>
          prepareUpgradeSnapshot({
            configured: { dbPath },
            disposableRoot,
            activeDatabasePaths: [dbPath],
          }),
        );
        const layer = upgradeValidationRuntime(fixture);
        const sourceBefore = NodeFS.readFileSync(dbPath);
        const untouchedBefore = NodeFS.readFileSync(fixture.untouchedPath);
        NodeFS.unlinkSync(fixture.runtimePath);
        NodeFS.symlinkSync(
          target === "source" ? dbPath : fixture.untouchedPath,
          fixture.runtimePath,
        );
        assert.equal((yield* Effect.exit(Effect.void.pipe(Effect.provide(layer))))._tag, "Failure");
        assert.deepStrictEqual(NodeFS.readFileSync(dbPath), sourceBefore);
        assert.deepStrictEqual(NodeFS.readFileSync(fixture.untouchedPath), untouchedBefore);
        const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
        try {
          assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "delete");
        } finally {
          db.close();
        }
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
);

it.effect(
  "quarantines real queued, starting, scheduler, webhook and recovery entrypoints while retaining copied state",
  () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-upgrade-admissions-"));
      try {
        const source = NodePath.join(root, "source");
        const disposableRoot = NodePath.join(root, "disposable");
        NodeFS.mkdirSync(source);
        NodeFS.mkdirSync(disposableRoot);
        const dbPath = NodePath.join(source, "statev2.sqlite");
        const queuedId = RunId.make("fixture-queued");
        const attemptId = RunAttemptId.make("fixture-starting-attempt");
        const providerTurnId = ProviderTurnId.make("fixture-provider-turn");
        const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
        const webhook = yield* Effect.gen(function* () {
          yield* runMigrations();
          yield* seedUpgradePreservation(source);
          const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
            preservationIds.thread,
          );
          const run = projection.runs[0];
          if (!run || run.rootNodeId === null) throw new Error("Missing source run");
          const sink = yield* EventSink.EventSinkV2;
          yield* sink.write({
            events: [
              {
                id: EventId.make("fixture-starting"),
                type: "run.updated",
                threadId: preservationIds.thread,
                occurredAt: now,
                payload: {
                  ...run,
                  status: "starting",
                  activeAttemptId: attemptId,
                  startedAt: null,
                  completedAt: null,
                },
              },
              {
                id: EventId.make("fixture-attempt"),
                type: "run-attempt.updated",
                threadId: preservationIds.thread,
                occurredAt: now,
                payload: {
                  id: attemptId,
                  runId: run.id,
                  rootNodeId: run.rootNodeId,
                  attemptOrdinal: 1,
                  providerInstanceId: run.providerInstanceId,
                  providerThreadId: preservationIds.providerThread,
                  providerTurnId,
                  reason: "initial",
                  status: "pending",
                  startedAt: null,
                  completedAt: null,
                },
              },
              {
                id: EventId.make("fixture-node"),
                type: "node.updated",
                threadId: preservationIds.thread,
                occurredAt: now,
                payload: {
                  id: run.rootNodeId,
                  threadId: preservationIds.thread,
                  runId: run.id,
                  parentNodeId: null,
                  rootNodeId: run.rootNodeId,
                  kind: "root_turn",
                  status: "pending",
                  countsForRun: true,
                  providerThreadId: preservationIds.providerThread,
                  providerTurnId,
                  nativeItemRef: null,
                  runtimeRequestId: null,
                  checkpointScopeId: preservationIds.scope,
                  startedAt: null,
                  completedAt: null,
                },
              },
              {
                id: EventId.make("fixture-turn"),
                type: "provider-turn.updated",
                threadId: preservationIds.thread,
                occurredAt: now,
                payload: {
                  id: providerTurnId,
                  providerThreadId: preservationIds.providerThread,
                  nodeId: run.rootNodeId,
                  runAttemptId: attemptId,
                  nativeTurnRef: null,
                  ordinal: 1,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              },
              {
                id: EventId.make("fixture-queued"),
                type: "run.created",
                threadId: preservationIds.fork,
                occurredAt: now,
                payload: {
                  ...run,
                  id: queuedId,
                  threadId: preservationIds.fork,
                  ordinal: 2,
                  status: "queued",
                  activeAttemptId: null,
                  providerThreadId: null,
                  rootNodeId: NodeId.make("fixture-queued-node"),
                  startedAt: null,
                  completedAt: null,
                },
              },
            ],
          });
          const input = yield* decodeScheduledTask({
            id: "fixture-webhook",
            title: "Fixture hook",
            prompt: "Fixture request",
            enabled: true,
            schedule: { type: "webhook" },
            projectId: preservationIds.project,
            threadId: preservationIds.thread,
            workspaceStrategy: { type: "root" },
            modelSelection: run.modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
          });
          return (yield* (yield* ScheduledTasks.ScheduledTaskService).upsert(input)).task;
        }).pipe(
          Effect.provide(
            preservationSeedLayer.pipe(
              Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath })),
            ),
          ),
        );
        const fixture = yield* Effect.promise(() =>
          prepareUpgradeSnapshot({
            configured: { dbPath },
            disposableRoot,
            activeDatabasePaths: [dbPath],
          }),
        );
        const untouched = NodeFS.readFileSync(fixture.untouchedPath);
        const before = inventoryUpgradeDatabase(fixture.runtimePath);
        yield* Effect.gen(function* () {
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const claim = yield* Effect.exit(worker.drain());
          assert.equal(claim._tag, "Failure");
          if (claim._tag === "Failure") assert.include(Cause.pretty(claim.cause), "readonly");
          const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
          assert.equal((yield* Effect.exit(recovery.recover))._tag, "Failure");
          const runtime = yield* Orchestrator.OrchestratorV2;
          yield* Effect.exit(runtime.resumeQueuedRuns);
          const start = yield* ProviderTurnStartService.ProviderTurnStartServiceV2;
          const started = yield* Effect.exit(
            start.start({ threadId: preservationIds.thread, runId: preservationIds.run }),
          );
          assert.equal(started._tag, "Failure");
          if (started._tag === "Failure")
            assert.include(Cause.pretty(started.cause), "FixtureNativeDenied");
          const controls = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
          assert.equal(
            (yield* Effect.exit(
              controls.interrupt({
                threadId: preservationIds.thread,
                providerSessionId: preservationIds.session,
                providerThreadId: preservationIds.providerThread,
                providerTurnId,
              }),
            ))._tag,
            "Success",
          );
          const tasks = yield* ScheduledTasks.ScheduledTaskService;
          const scheduled = yield* Effect.exit(
            tasks.runNow({ id: ScheduledTaskId.make("preservation-schedule") }),
          );
          assert.equal(scheduled._tag, "Failure");
          if (scheduled._tag === "Failure")
            assert.include(Cause.pretty(scheduled.cause), "readonly");
          const trigger = yield* Effect.exit(
            tasks.triggerWebhook({
              hookId: webhook.id,
              token: webhook.webhook?.path.split("/").at(-1) ?? "",
              method: "POST",
              path: `/api/hooks/${webhook.id}`,
              query: "",
              headers: {},
              body: new TextEncoder().encode("{}"),
              bodyText: "{}",
            }),
          );
          assert.equal(trigger._tag, "Failure");
          const continuationFinished = yield* Deferred.make<string>();
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          yield* requests.offer({
            threadId: preservationIds.thread,
            providerThreadId: preservationIds.providerThread,
            driver: ProviderDriverKind.make("codex"),
            detail: "Fixture continuation",
            delivery: "message_text",
            dispatchIfCurrent: (dispatch) =>
              dispatch.pipe(
                Effect.onExit((exit) =>
                  Deferred.succeed(
                    continuationFinished,
                    exit._tag === "Failure" ? Cause.pretty(exit.cause) : "success",
                  ),
                ),
                Effect.asSome,
              ),
          });
          assert.include(yield* Deferred.await(continuationFinished), "readonly");
          const scheduler = yield* UpgradeFixtureScheduler;
          assert.include(yield* scheduler.sources, "scheduled-tasks");
          yield* TestClock.adjust("400 days");
          yield* scheduler.tick;
          const attempts = yield* scheduler.nativeAttempts;
          assert.include(attempts, "provider.open");
          assert.isFalse(attempts.includes("thread.launch"));
          assert.deepEqual(yield* (yield* UpgradeFixtureNative).attempts, []);
          const fs = yield* FileSystem.FileSystem;
          const overlay = fixture.projects[0];
          if (!overlay) throw new Error("Missing clone");
          assert.equal(
            yield* fs.readFileString(NodePath.join(source, "fixture.txt")),
            "T3 upgrade fixture\n",
          );
          const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          yield* files.writeFile({
            cwd: source,
            relativePath: "fixture.txt",
            contents: "sandbox edit",
          });
          assert.equal(
            (yield* files.readFile({ cwd: source, relativePath: "fixture.txt" })).contents,
            "sandbox edit",
          );
          assert.isFalse(NodeFS.existsSync(NodePath.join(source, "fixture.txt")));
          NodeFS.symlinkSync(source, NodePath.join(overlay.sandboxRoot, "outside"));
          assert.equal(
            (yield* Effect.exit(
              files.readFile({ cwd: source, relativePath: "outside/statev2.sqlite" }),
            ))._tag,
            "Failure",
          );
          assert.equal(
            (yield* Effect.exit(files.readFile({ cwd: source, relativePath: "/etc/passwd" })))._tag,
            "Failure",
          );
          const mutation = yield* Effect.exit(
            (yield* EventSink.EventSinkV2).commitProjectCommand({
              commandId: CommandId.make("fixture-unsafe-project"),
              projectId: preservationIds.project,
              commandType: "project.rename",
              acceptedAt: now,
              event: {
                eventId: EventId.make("fixture-unsafe-project"),
                type: "project.meta-updated",
                aggregateKind: "project",
                aggregateId: preservationIds.project,
                occurredAt: DateTime.formatIso(now),
                commandId: null,
                causationEventId: null,
                correlationId: null,
                metadata: {},
                payload: {
                  projectId: preservationIds.project,
                  title: "Must not persist",
                  updatedAt: DateTime.formatIso(now),
                },
              },
            }),
          );
          assert.equal(mutation._tag, "Failure");
        }).pipe(Effect.provide(upgradeValidationRuntime(fixture)));
        assertOnlyDeclaredWorkflowObjectsAdded(fixture.runtimePath, before);
        assert.deepEqual(NodeFS.readFileSync(fixture.untouchedPath), untouched);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
);

it.live(
  "runs only explicitly selected trusted native fixtures with sterile shell state and fresh loopback auth",
  () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-upgrade-native-"));
      try {
        const source = NodePath.join(root, "source");
        const disposableRoot = NodePath.join(root, "disposable");
        NodeFS.mkdirSync(source);
        NodeFS.mkdirSync(disposableRoot);
        const dbPath = NodePath.join(source, "statev2.sqlite");
        yield* seed(source).pipe(
          Effect.provide(
            EventSink.layer.pipe(
              Layer.provide(Layer.mergeAll(EventStore.layer, ProjectionStore.layer)),
              Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath })),
            ),
          ),
        );
        const snapshot = yield* Effect.promise(() =>
          prepareUpgradeSnapshot({
            configured: { dbPath },
            disposableRoot,
            activeDatabasePaths: [dbPath],
          }),
        );
        yield* Effect.gen(function* () {
          const native = yield* UpgradeFixtureNative;
          assert.equal(native.mode, "preservation");
          assert.equal(
            (yield* Effect.result(native.run({ projectId: "project", command: "node-version" })))
              ._tag,
            "Failure",
          );
          assert.equal((yield* Effect.result(native.terminal("project")))._tag, "Failure");
          assert.equal((yield* Effect.result(native.endpoint))._tag, "Failure");
        }).pipe(Effect.provide(upgradeValidationRuntime(snapshot)));
        const project = snapshot.projects[0];
        if (!project) throw new Error("Missing fixture clone");
        NodeFS.mkdirSync(NodePath.join(project.sandboxRoot, ".git", "hooks"), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(project.sandboxRoot, ".git", "hooks", "pre-commit"),
          "#!/bin/sh\nexit 99\n",
          { mode: 0o700 },
        );
        NodeFS.writeFileSync(
          NodePath.join(snapshot.fixtureRoot, "sterile-home", ".bashrc"),
          "exit 99\n",
        );
        yield* Effect.gen(function* () {
          const native = yield* UpgradeFixtureNative;
          assert.equal(native.mode, "controlled-fixture");
          assert.match(
            yield* native.run({ projectId: "project", command: "node-version" }),
            /^v\d/,
          );
          yield* native.run({ projectId: "project", command: "initialize-git" });
          assert.equal(yield* native.run({ projectId: "project", command: "git-status" }), "");
          assert.include(yield* native.terminal("project"), "fixture-terminal");
          const endpoint = yield* native.endpoint;
          assert.match(endpoint.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
          const denied = yield* Effect.promise(() => requestFixtureHealth(endpoint.origin));
          assert.equal(denied.status, 401);
          const accepted = yield* Effect.promise(() =>
            requestFixtureHealth(endpoint.origin, endpoint.token),
          );
          assert.equal(accepted.status, 200);
          assert.equal(accepted.body, '{"fixture":true}');
          const metadata = NodePath.join(project.sandboxRoot, ".git");
          const outsideMetadata = NodePath.join(root, "outside-git");
          NodeFS.renameSync(metadata, outsideMetadata);
          NodeFS.symlinkSync(outsideMetadata, metadata);
          const outsideBefore = NodeFS.readFileSync(NodePath.join(outsideMetadata, "config"));
          assert.equal(
            (yield* Effect.result(native.run({ projectId: "project", command: "initialize-git" })))
              ._tag,
            "Failure",
          );
          assert.equal(
            (yield* Effect.result(native.run({ projectId: "project", command: "git-status" })))
              ._tag,
            "Failure",
          );
          assert.deepEqual(
            NodeFS.readFileSync(NodePath.join(outsideMetadata, "config")),
            outsideBefore,
          );

          assert.equal(
            (yield* Effect.result(native.run({ projectId: "unknown", command: "git-status" })))
              ._tag,
            "Failure",
          );
        }).pipe(Effect.provide(upgradeValidationRuntime(snapshot, { mode: "controlled-fixture" })));
        assert.isFalse(NodeFS.existsSync(NodePath.join(source, ".git")));
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
);

it.effect("allows controlled event commits without consuming copied outbox or scheduler work", () =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-upgrade-controlled-"));
    try {
      const source = NodePath.join(root, "source");
      const disposableRoot = NodePath.join(root, "disposable");
      NodeFS.mkdirSync(source);
      NodeFS.mkdirSync(disposableRoot);
      const dbPath = NodePath.join(source, "statev2.sqlite");
      yield* Effect.gen(function* () {
        yield* runMigrations();
        yield* seedUpgradePreservation(source);
      }).pipe(
        Effect.provide(
          preservationSeedLayer.pipe(
            Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath })),
          ),
        ),
      );
      const snapshot = yield* Effect.promise(() =>
        prepareUpgradeSnapshot({
          configured: { dbPath },
          disposableRoot,
          activeDatabasePaths: [dbPath],
        }),
      );
      const untouched = NodeFS.readFileSync(snapshot.untouchedPath);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const before = yield* sql`SELECT * FROM orchestration_v2_effect_outbox ORDER BY rowid`;
        assert.isAbove(before.length, 0);
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        assert.equal(yield* worker.drain(), 0);
        assert.isFalse(yield* worker.runOnce);
        assert.isFalse(yield* worker.runRecoveryOnce);
        yield* (yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService).recover;
        yield* (yield* UpgradeFixtureScheduler).tick;
        const tasks = yield* ScheduledTasks.ScheduledTaskService;
        assert.equal(
          (yield* Effect.exit(tasks.runNow({ id: ScheduledTaskId.make("preservation-schedule") })))
            ._tag,
          "Failure",
        );
        const now = yield* DateTime.now;
        yield* (yield* EventSink.EventSinkV2).commitProjectCommand({
          commandId: CommandId.make("controlled-rename"),
          projectId: preservationIds.project,
          commandType: "project.rename",
          acceptedAt: now,
          event: {
            eventId: EventId.make("controlled-rename"),
            type: "project.meta-updated",
            aggregateKind: "project",
            aggregateId: preservationIds.project,
            occurredAt: DateTime.formatIso(now),
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: {
              projectId: preservationIds.project,
              title: "Controlled edit",
              updatedAt: DateTime.formatIso(now),
            },
          },
        });
        const project = yield* (yield* ProjectStore.ProjectStoreV2).get(preservationIds.project);
        assert.equal(Option.getOrThrow(project).title, "Controlled edit");
        assert.deepEqual(
          yield* sql`SELECT * FROM orchestration_v2_effect_outbox ORDER BY rowid`,
          before,
        );
        assert.deepEqual(yield* (yield* UpgradeFixtureNative).attempts, []);
      }).pipe(Effect.provide(upgradeValidationRuntime(snapshot, { mode: "controlled-fixture" })));
      const stateRoot = NodePath.join(snapshot.fixtureRoot, "terminal-state");
      const filesystem = layerFixtureFilesystem(snapshot, "controlled-fixture", {
        ownedStateRoots: [stateRoot],
      }).pipe(Layer.provide(NodeServices.layer));
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(stateRoot);
        yield* fs.writeFileString(
          NodePath.join(stateRoot, "terminal.log"),
          "owned terminal output",
        );
        assert.equal(
          yield* fs.readFileString(NodePath.join(stateRoot, "terminal.log")),
          "owned terminal output",
        );
        const clone = snapshot.projects[0];
        if (!clone) throw new Error("Missing fixture clone");
        const gitRoot = NodePath.join(clone.sandboxRoot, ".git");
        NodeFS.mkdirSync(gitRoot);
        const temp = yield* Effect.scoped(
          Effect.gen(function* () {
            const path = yield* fs.makeTempDirectoryScoped({
              directory: gitRoot,
              prefix: "t3-index-",
            });
            assert.isTrue(NodeFS.existsSync(path));
            return path;
          }),
        );
        assert.isFalse(NodeFS.existsSync(temp));
        assert.equal(
          (yield* Effect.exit(fs.makeTempDirectory({ directory: gitRoot, prefix: "arbitrary-" })))
            ._tag,
          "Failure",
        );
        assert.equal((yield* Effect.exit(fs.makeTempDirectory()))._tag, "Failure");
        assert.throws(() =>
          mapUpgradeFixturePath(
            snapshot,
            NodePath.join(stateRoot, "terminal.log"),
            "controlled-fixture",
          ),
        );
        NodeFS.symlinkSync(source, NodePath.join(stateRoot, "outside"));
        assert.equal(
          (yield* Effect.exit(
            fs.writeFileString(NodePath.join(stateRoot, "outside", "escape"), "denied"),
          ))._tag,
          "Failure",
        );
        assert.isFalse(NodeFS.existsSync(NodePath.join(source, "escape")));
      }).pipe(Effect.provide(filesystem));
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        assert.equal(
          (yield* Effect.exit(
            fs.writeFileString(NodePath.join(stateRoot, "terminal.log"), "denied"),
          ))._tag,
          "Failure",
        );
      }).pipe(
        Effect.provide(
          layerFixtureFilesystem(snapshot, "preservation", { ownedStateRoots: [stateRoot] }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      assert.deepEqual(NodeFS.readFileSync(snapshot.untouchedPath), untouched);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  }),
);
