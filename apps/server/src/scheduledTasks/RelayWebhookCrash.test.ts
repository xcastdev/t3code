// @effect-diagnostics nodeBuiltinImport:off -- The fixture must kill a disposable writer process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as Tracer from "effect/Tracer";

import * as AssistantRepository from "../assistants/AssistantRepository.ts";
import * as AssistantRoutines from "../assistants/AssistantRoutineRepository.ts";
import { environmentId, input as assistantInput } from "../assistants/AssistantTestHelpers.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { migrationManifest, runMigrations } from "../persistence/Migrations.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { runWorkflowFeatureMigrations } from "../persistence/WorkflowFeatureMigrations.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ScheduledTasks from "./ScheduledTaskService.ts";

const projectId = ProjectId.make("project:relay-crash");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const taskId = ScheduledTaskId.make("scheduled-task:relay-crash");
const legacyMigrationHead = 98;
const decodeTaskInput = Schema.decodeEffect(ScheduledTaskUpsertInput);

const Stage = Schema.Literals([
  "claim-gap",
  "before-admission-commit",
  "after-admission-commit",
  "claimed-work",
  "assistant-claimed",
  "assistant-command-committed",
  "direct-shared-key",
  "direct-committed-shared-key",
  "direct-window-shared-key",
  "command-committed",
  "reply-lost",
  "legacy-hosted",
  "filtered",
  "prompt-rejected",
  "coalesced",
  "recover",
]);
type Stage = typeof Stage.Type;
const decodeStage = Schema.decodeUnknownEffect(Stage);
const decodeDatabasePath = Schema.decodeUnknownEffect(Schema.String.check(Schema.isMinLength(1)));

const killFixture = () => process.kill(process.pid, "SIGKILL");
const trackedSpan = (span: Tracer.Span, name: string) =>
  span.parent._tag === "Some" &&
  span.parent.value._tag === "Span" &&
  span.parent.value.name === name;

const runFixture = (dbPath: string, stage: Stage, scenario: Stage) => {
  const database =
    stage === "legacy-hosted"
      ? Layer.effectDiscard(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`PRAGMA journal_mode = WAL`;
            yield* runMigrations({ toMigrationInclusive: legacyMigrationHead });
            yield* runWorkflowFeatureMigrations().pipe(Effect.orDie);
          }),
        ).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath, writerWorker: true })))
      : Sqlite.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));
  const adapters = ProviderAdapterRegistry.layerFromAdapters([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: () => Effect.die("The crash fixture does not start providers."),
    },
  ]);
  const runtime = ProviderReplayHarness.layerWithRegistry(
    { name: "relay-webhook-crash" },
    adapters,
    {
      databaseLayer: database,
      runEffectWorker: false,
    },
  );
  const assistantScenario =
    scenario === "assistant-claimed" || scenario === "assistant-command-committed";
  const directWindow = scenario === "direct-window-shared-key";
  const directSharedKey =
    scenario === "direct-shared-key" || scenario === "direct-committed-shared-key" || directWindow;
  const assistants = AssistantRepository.layer.pipe(
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Effect.die("The crash fixture uses a fixed environment."),
      }),
    ),
  );
  const routines = AssistantRoutines.layer.pipe(Layer.provideMerge(assistants));
  const threadManagement = Layer.effect(
    ThreadManagement.ThreadManagementService,
    Effect.gen(function* () {
      const service = yield* ThreadManagement.ThreadManagementService;
      return {
        ...service,
        sendToThread: (input) =>
          Effect.gen(function* () {
            if (stage === "assistant-claimed") killFixture();
            const result = yield* service.sendToThread(input);
            if (stage === "assistant-command-committed") killFixture();
            return result;
          }),
      };
    }),
  ).pipe(
    Layer.provide(ThreadManagement.layer),
    Layer.provide(Layer.mergeAll(runtime, CommandReceiptStore.layer, ServerSettings.layerTest())),
  );
  const launch = Layer.unwrap(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      return Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) =>
          Effect.gen(function* () {
            if (stage === "claimed-work") killFixture();
            if (stage === "direct-shared-key") return yield* Effect.never;
            const threadId = ThreadId.make(input.commandId);
            yield* orchestrator
              .dispatch({
                type: "thread.create",
                commandId: input.commandId,
                threadId,
                projectId: input.projectId,
                title: input.title,
                modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
                createdBy: input.createdBy,
                creationSource: input.creationSource,
                branch: null,
                worktreePath: null,
                initialMessage: {
                  ...input.initialMessage!,
                  messageId: input.initialMessage!.messageId!,
                  workspaceStrategy: { type: "root" },
                },
              })
              .pipe(Effect.orDie);
            if (stage === "command-committed") killFixture();
            if (stage === "reply-lost") {
              yield* Effect.log("The launch reply was lost.");
              return yield* Effect.die("The launch reply was lost.");
            }
            const projection = yield* orchestrator.getThreadProjection(threadId).pipe(Effect.orDie);
            return { threadId, projection, resumed: false };
          }),
      });
    }),
  ).pipe(Layer.provide(runtime));
  if (stage === "legacy-hosted") {
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`INSERT INTO projection_projects
            (project_id, title, workspace_root, scripts_json, created_at, updated_at)
            VALUES (${projectId}, 'Relay crash fixture', ${NodePath.dirname(dbPath)}, '[]', ${now}, ${now})`;
      yield* sql`INSERT INTO scheduled_tasks
            (task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
             model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
             created_at, updated_at, last_run_status, run_count, webhook_token)
            VALUES (${taskId}, 'Relay crash fixture', '{{body.value}}', 1, '{"type":"webhook","signature":null}',
              ${projectId}, '{"type":"root"}', ${JSON.stringify(modelSelection)}, 'full-access',
              'default', 'user', 'server', ${now}, ${now}, 'succeeded', 1, 'legacy-hosted-fixture-token')`;
      const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
      const legacyDeliveryId = "delivery:relay:first";
      const fireKey = `${taskId}:webhook:${legacyDeliveryId}`;
      yield* sql`INSERT INTO scheduled_task_webhook_relay_deliveries
            (relay_delivery_id, task_id, seen_at) VALUES ('first', ${taskId}, ${now})`;
      yield* sql`INSERT INTO scheduled_task_webhook_deliveries
            (delivery_id, task_id, received_at, method, query, headers_json, body, body_bytes,
             body_truncated, outcome, signature_verified, missing_fields_json)
            VALUES (${legacyDeliveryId}, ${taskId}, ${now}, 'POST', '', '{}', '{}', 2, 0, 'accepted', 0, '[]')`;
      yield* threadLaunch.launch({
        commandId: CommandId.make(`scheduled-task:${fireKey}`),
        projectId,
        title: "Relay crash fixture",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make(`scheduled-task-message:${fireKey}`),
          scheduledTaskId: taskId,
          text: "legacy delivery",
          attachments: [],
        },
        createdBy: "user",
        creationSource: "server",
      });
      killFixture();
    }).pipe(Effect.provide(Layer.merge(launch, database)), Effect.orDie);
  }
  return Effect.scoped(
    Effect.gen(function* () {
      const dispatchFinished = yield* Deferred.make<void>();
      const directPermitHeld = yield* Deferred.make<void>();
      const directCleanupFinished = yield* Deferred.make<void>();
      const workers = new Map<string, Effect.Effect<void>>();
      let receiptInserts = 0;
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          if (
            stage === "direct-shared-key" &&
            span.name === "ScheduledTaskService.runWebhookDelivery"
          )
            Deferred.doneUnsafe(directPermitHeld, Effect.void);
          const end = span.end.bind(span);
          span.end = (time, exit) => {
            end(time, exit);
            if (!Exit.isSuccess(exit)) return;
            const query = span.attributes.get("db.query.text");
            if (typeof query === "string") {
              if (
                stage === "claim-gap" &&
                query.includes("INSERT INTO scheduled_task_webhook_deliveries")
              )
                killFixture();
              if (query.includes("INSERT INTO scheduled_task_webhook_relay_receipts")) {
                receiptInserts++;
                if (stage === "before-admission-commit") killFixture();
              }
            }
            if (
              span.name === "sql.transaction" &&
              trackedSpan(span, "ScheduledTaskService.triggerRelayWebhook") &&
              (stage === "after-admission-commit" ||
                stage === "direct-shared-key" ||
                stage === "direct-committed-shared-key" ||
                stage === "direct-window-shared-key" ||
                ((stage === "filtered" || stage === "prompt-rejected") && receiptInserts === 1) ||
                (stage === "coalesced" && receiptInserts === 2))
            )
              killFixture();
            if (span.name === "ScheduledTaskService.dispatchPendingWebhook")
              Deferred.doneUnsafe(dispatchFinished, Effect.void);
            if (span.name === "ScheduledTaskService.finishPendingWebhook")
              Deferred.doneUnsafe(directCleanupFinished, Effect.void);
          };
          return span;
        },
      });
      const dependencies = Layer.mergeAll(
        NodeCrypto.layer,
        launch,
        assistantScenario
          ? Layer.mergeAll(threadManagement, routines, runtime)
          : Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: NodePath.dirname(dbPath),
          isScratchProject: () => Effect.succeed(false),
        }),
        ManagedPolicy.layerTest(),
        Layer.succeed(Scheduler.Scheduler, {
          register: <E, R>(name: string, work: Effect.Effect<void, E, R>) =>
            Effect.gen(function* () {
              const context = yield* Effect.context<R>();
              workers.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
            }),
        }),
      );
      return yield* Effect.gen(function* () {
        const service = yield* ScheduledTasks.ScheduledTaskService;
        const sql = yield* SqlClient.SqlClient;
        const now = DateTime.formatIso(yield* DateTime.now);
        const [initialSync] = yield* sql<{ synchronous: number }>`PRAGMA synchronous`;
        yield* Effect.log(`initial writer: synchronous=${initialSync?.synchronous}`);
        const checkWriter = Effect.gen(function* () {
          const [settings] = yield* sql<{ synchronous: number }>`PRAGMA synchronous`;
          const [journal] = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`;
          const [flush] = yield* sql<{ fullfsync: number }>`PRAGMA fullfsync`;
          const [checkpoint] = yield* sql<{
            checkpoint_fullfsync: number;
          }>`PRAGMA checkpoint_fullfsync`;
          yield* Effect.log(
            `admission writer: synchronous=${settings?.synchronous}, journal_mode=${journal?.journal_mode}, fullfsync=${flush?.fullfsync}, checkpoint_fullfsync=${checkpoint?.checkpoint_fullfsync}`,
          );
          return true;
        }).pipe(Effect.orDie);
        if (stage !== "recover") {
          yield* sql`INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES (${projectId}, 'Relay crash fixture', ${NodePath.dirname(dbPath)}, '[]', ${now}, ${now})`;
          const { task } = yield* service.upsert(
            yield* decodeTaskInput({
              id: taskId,
              title: "Relay crash fixture",
              projectId,
              prompt: "{{body.value}}",
              enabled: true,
              schedule: {
                type: "webhook",
                relayEnabled: true,
                ...(scenario === "filtered"
                  ? { filters: [{ path: "headers.event", op: "equals", value: "run" }] }
                  : {}),
                ...(scenario === "coalesced" || directSharedKey
                  ? {
                      dedupe: {
                        ...(directSharedKey ? { replayKey: "{{headers.event}}" } : {}),
                        ...(scenario === "coalesced" || directWindow
                          ? { coalesceKey: "{{headers.group}}", coalesceWindowSeconds: 60 }
                          : {}),
                      },
                    }
                  : {}),
              },
              workspaceStrategy: { type: "root" },
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
            }),
          );
          if (assistantScenario) {
            const repository = yield* AssistantRepository.AssistantRepository;
            const routineRepository = yield* AssistantRoutines.AssistantRoutineRepository;
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const { detail } = yield* repository.create(assistantInput);
            const binding = detail.summary.binding;
            const workspaceRoot = NodePath.dirname(dbPath);
            yield* sql`INSERT INTO projection_projects
              (project_id, title, workspace_root, scripts_json, created_at, updated_at)
              VALUES (${binding.backingProjectId}, 'Assistant crash fixture', ${workspaceRoot}, '[]', ${now}, ${now})`;
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("assistant-crash-fixture:create-thread"),
              threadId: binding.canonicalThreadId,
              projectId: binding.backingProjectId,
              title: "Assistant crash fixture",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              createdBy: "system",
              creationSource: "server",
              branch: null,
              worktreePath: null,
            });
            yield* repository.setProvisioning(
              detail.summary,
              { state: "ready", binding },
              workspaceRoot,
            );
            yield* sql`UPDATE scheduled_tasks SET project_id = ${binding.backingProjectId},
              thread_id = ${binding.canonicalThreadId} WHERE task_id = ${taskId}`;
            yield* routineRepository.bind({ ...detail.summary, taskId: task.id, enabled: true });
          }
        }
        const task = (yield* service.list()).tasks[0]!;
        const deliver = (relayDeliveryId: string | null, value: string, event = "skip") => {
          const bodyText = JSON.stringify({ value });
          return service.triggerWebhook({
            hookId: task.id,
            token: task.webhook!.path.split("/").at(-1)!,
            ...(relayDeliveryId === null
              ? {}
              : {
                  relayIssuer: "fixture-relay",
                  relaySource: scenario === "legacy-hosted" ? "hosted" : "self-hosted",
                  relayAdmissionCheck: checkWriter,
                  relayDeliveryId,
                }),
            method: "POST",
            path: "/hook",
            query: "",
            headers: { event, group: "one" },
            bodyText,
            body: new TextEncoder().encode(bodyText),
          });
        };
        if (stage === "direct-shared-key") {
          yield* deliver(null, "blocker", "blocker");
          yield* Deferred.await(directPermitHeld);
        }
        if (stage !== "recover" && directSharedKey) yield* deliver(null, "direct owner");
        if (stage === "direct-committed-shared-key") yield* Deferred.await(directCleanupFinished);
        const first = yield* deliver(
          "first",
          scenario === "prompt-rejected" ? "x".repeat(800_000) : "initial",
        );
        yield* Effect.log("first relay receipt", first);
        if (scenario === "coalesced") {
          const second = yield* deliver("second", "latest");
          yield* Effect.log("second relay receipt", second);
        }
        if (stage === "recover") {
          yield* sql`UPDATE scheduled_task_webhook_pending SET due_at = 0 WHERE state = 'pending'`;
          const pending = yield* sql`SELECT 1 FROM scheduled_task_webhook_pending`;
          if (pending.length > 0) {
            yield* workers.get("webhook-coalescing")!;
            yield* Deferred.await(dispatchFinished);
          }
        }
        if (
          stage === "claimed-work" ||
          assistantScenario ||
          stage === "command-committed" ||
          stage === "reply-lost"
        )
          yield* Deferred.await(dispatchFinished);
      }).pipe(
        Effect.provide(
          ScheduledTasks.layer.pipe(Layer.provideMerge(dependencies), Layer.provideMerge(database)),
        ),
        Effect.withTracer(tracer),
        Effect.provideService(Statement.SpanPropagationEnabled, true),
      );
    }),
  ).pipe(Effect.orDie);
};

const fixtureMode = process.argv[2] === "--relay-webhook-fixture";
if (fixtureMode) {
  const [, , , dbPath, stage, scenario] = process.argv;
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Standalone subprocess entry point.
  await Effect.runPromise(
    Effect.gen(function* () {
      const path = yield* decodeDatabasePath(dbPath);
      const decodedStage = yield* decodeStage(stage);
      const decodedScenario = yield* decodeStage(scenario);
      yield* runFixture(path, decodedStage, decodedScenario);
    }),
  );
} else {
  const { it, expect } = await import("@effect/vitest");
  const spawn = NodeUtil.promisify(NodeChildProcess.execFile);
  const run = (dbPath: string, stage: Stage, scenario = stage) =>
    spawn(
      process.execPath,
      [NodeURL.fileURLToPath(import.meta.url), "--relay-webhook-fixture", dbPath, stage, scenario],
      { env: { ...process.env, TMPDIR: NodePath.dirname(dbPath) } },
    );
  const readState = (dbPath: string) => {
    using db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    const migration = db
      .prepare("SELECT MAX(migration_id) AS head FROM effect_sql_migrations")
      .get()?.head;
    const commandIds = db
      .prepare(`SELECT command_id FROM orchestration_command_receipts
        WHERE (command_id LIKE 'scheduled-task:%' OR command_id LIKE 'assistant-routine:%')
          AND status = 'accepted'`)
      .all()
      .map((row) => row.command_id);
    return {
      migration,
      receipts:
        migration === legacyMigrationHead
          ? []
          : db
              .prepare(`SELECT result_json, work_delivery_id FROM scheduled_task_webhook_relay_receipts
        ORDER BY relay_delivery_id`)
              .all(),
      pending: db.prepare("SELECT 1 FROM scheduled_task_webhook_pending").all().length,
      commands: commandIds.length,
      commandIds,
      runs: db
        .prepare("SELECT payload_json FROM orchestration_events WHERE event_type = 'run.created'")
        .all().length,
      prompt: db
        .prepare(`SELECT json_extract(payload_json, '$.text') AS prompt
        FROM orchestration_events
        WHERE event_type = 'message.updated' AND json_extract(payload_json, '$.role') = 'user'`)
        .get()?.prompt,
      attempts: db.prepare("SELECT run_count FROM scheduled_tasks").get()?.run_count,
      ...(migration === legacyMigrationHead
        ? {}
        : {
            assistantFire: db
              .prepare(`SELECT f.command_id, f.dispatched, c.status AS receipt_status
                FROM t3_workflow_v2_assistant_routine_fires f
                LEFT JOIN orchestration_command_receipts c ON c.command_id = f.command_id`)
              .get(),
          }),
    };
  };

  it("preserves a hosted delivery whose workflow committed before the database upgrade", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "relay-webhook-upgrade-"),
    );
    try {
      const dbPath = NodePath.join(directory, "state.sqlite");
      await expect(run(dbPath, "legacy-hosted")).rejects.toMatchObject({ signal: "SIGKILL" });
      expect(readState(dbPath)).toMatchObject({
        migration: legacyMigrationHead,
        pending: 0,
        commands: 1,
        runs: 1,
      });
      await run(dbPath, "recover", "legacy-hosted");
      expect(readState(dbPath)).toEqual(
        expect.objectContaining({
          migration: migrationManifest.at(-1)?.[0],
          pending: 0,
          commands: 1,
          runs: 1,
          attempts: 1,
          receipts: [
            {
              result_json:
                '{"_tag":"accepted","deliveryId":"delivery:relay:first","outcome":"accepted"}',
              work_delivery_id: "delivery:relay:first",
            },
          ],
        }),
      );
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["claim-gap", { receipts: 0, pending: 0, commands: 0 }, 1],
    ["before-admission-commit", { receipts: 0, pending: 0, commands: 0 }, 1],
    ["after-admission-commit", { receipts: 1, pending: 1, commands: 0 }, 1],
    ["claimed-work", { receipts: 1, pending: 1, commands: 0 }, 1],
    ["assistant-claimed", { receipts: 1, pending: 1, commands: 0 }, 1],
    ["assistant-command-committed", { receipts: 1, pending: 1, commands: 1 }, 1],
    ["direct-shared-key", { receipts: 1, pending: 2, commands: 0 }, 2],
    ["direct-committed-shared-key", { receipts: 1, pending: 0, commands: 1 }, 1],
    ["direct-window-shared-key", { receipts: 1, pending: 1, commands: 0 }, 1],
    ["command-committed", { receipts: 1, pending: 1, commands: 1 }, 1],
    ["reply-lost", { receipts: 1, pending: 0, commands: 1 }, 1],
    ["filtered", { receipts: 1, pending: 0, commands: 0 }, 0],
    ["prompt-rejected", { receipts: 1, pending: 0, commands: 0 }, 0],
    ["coalesced", { receipts: 2, pending: 1, commands: 0 }, 1],
  ] as const)(
    "recovers exactly one run per admitted delivery after %s",
    async (stage, beforeRestart, runs) => {
      const directory = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "relay-webhook-crash-"),
      );
      try {
        const dbPath = NodePath.join(directory, "state.sqlite");
        const writerCheck =
          "admission writer: synchronous=2, journal_mode=wal, fullfsync=1, checkpoint_fullfsync=1";
        if (stage === "reply-lost") {
          const { stdout } = await run(dbPath, stage);
          expect(stdout).toContain("The launch reply was lost.");
          expect(stdout).toContain(writerCheck);
          expect(stdout).toContain("initial writer: synchronous=1");
        } else {
          await expect(run(dbPath, stage)).rejects.toMatchObject({
            signal: "SIGKILL",
            stdout: expect.stringMatching(
              /initial writer: synchronous=1[\s\S]+admission writer: synchronous=2, journal_mode=wal, fullfsync=1, checkpoint_fullfsync=1/,
            ),
          });
        }
        const interrupted = readState(dbPath);
        expect(interrupted.receipts).toHaveLength(beforeRestart.receipts);
        if (stage === "assistant-claimed" || stage === "assistant-command-committed")
          expect(interrupted.assistantFire).toMatchObject({
            command_id: expect.stringMatching(/^assistant-routine:/),
            dispatched: 0,
            receipt_status: stage === "assistant-claimed" ? null : "accepted",
          });
        const directOwner =
          stage === "direct-shared-key" ||
          stage === "direct-committed-shared-key" ||
          stage === "direct-window-shared-key";
        if (directOwner)
          expect(interrupted.receipts[0]).toMatchObject({
            result_json: expect.stringContaining('"outcome":"duplicate"'),
            work_delivery_id: expect.stringMatching(/^delivery:[a-f0-9-]+$/),
          });
        expect(interrupted.pending).toBe(beforeRestart.pending);
        expect(interrupted.commands).toBe(beforeRestart.commands);
        const { stdout } = await run(dbPath, "recover", stage);
        if (interrupted.pending > 0) expect(stdout).toContain("initial writer: synchronous=2");
        const recovered = readState(dbPath);
        expect(recovered.receipts).toHaveLength(stage === "coalesced" ? 2 : 1);
        if (beforeRestart.receipts > 0) expect(recovered.receipts).toEqual(interrupted.receipts);
        if (stage === "coalesced") {
          expect(recovered.receipts[1]!.work_delivery_id).toBe(
            recovered.receipts[0]!.work_delivery_id,
          );
          expect(recovered.prompt).toEqual(expect.stringContaining("latest"));
        }
        expect(recovered.pending).toBe(0);
        expect(recovered.commands).toBe(runs);
        expect(recovered.runs).toBe(runs);
        expect(recovered.attempts).toBe(runs);
        if (directOwner)
          expect(recovered.commandIds).toContain(
            `scheduled-task:${taskId}:webhook:${interrupted.receipts[0]!.work_delivery_id}`,
          );
        if (stage === "assistant-claimed" || stage === "assistant-command-committed")
          expect(recovered.assistantFire).toEqual({
            command_id: interrupted.assistantFire?.command_id,
            dispatched: 1,
            receipt_status: "accepted",
          });
        if (stage === "direct-window-shared-key")
          expect(recovered.prompt).toEqual(expect.stringContaining("direct owner"));
      } finally {
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    },
  );
}
