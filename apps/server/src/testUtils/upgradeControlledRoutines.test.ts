// @effect-diagnostics nodeBuiltinImport:off -- Only synthetic SQL and caller-owned temporary fixtures are used.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import { RunAdmission } from "../orchestration-v2/RunAdmission.ts";
import * as Stream from "effect/Stream";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ControlledProviderTranscript, controlledResponse } from "./upgradeControlledProviders.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as HttpClient from "effect/http/HttpClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as AssistantRepository from "../assistants/AssistantRepository.ts";
import { configuration } from "../assistants/AssistantTestHelpers.ts";
import { controlledProviderId, controlledProviderModel } from "./upgradeControlledProviders.ts";
import { EnvironmentId, CommandId } from "@t3tools/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import { prepareUpgradeSnapshot } from "./prepareUpgradeSnapshot.ts";
import { upgradeValidationBaseRuntime } from "./upgradeValidationRuntime.ts";
import { layerControlledBusiness } from "./upgradeControlledBusiness.ts";
import * as WorktreeSetup from "../project/WorktreeSetupTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as OwnerDeadline from "../orchestration-v2/OwnerDeadlineControl.ts";
import * as Cleanup from "../orchestration-v2/ResourceCleanupService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

import * as SqlClient from "effect/sql/SqlClient";
import * as RoutineRepository from "../assistants/AssistantRoutineRepository.ts";
import * as AssistantEvents from "../assistants/AssistantEventBus.ts";
import { AssistantRuntime } from "../assistants/AssistantRuntime.ts";
import { AssistantRoutineGateway } from "../assistants/AssistantRoutineGateway.ts";
import { AssistantRoutines } from "../assistants/AssistantRoutines.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import {
  AuthSessionId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import {
  ControlledRoutineIsolation,
  layerControlledRoutineIsolation,
} from "./controlledRoutineIsolation.ts";
import { layerControlledRoutines } from "./controlledRoutines.ts";

it.live("runs and recovers real assistant routines without mutating copied scheduler rows", () =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-controlled-routine-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
    );
    NodeFS.mkdirSync(NodePath.join(root, "source"));
    const dbPath = NodePath.join(root, "source", "statev2.sqlite");
    const disposableRoot = NodePath.join(root, "disposable");
    NodeFS.mkdirSync(disposableRoot);
    yield* Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO scheduled_tasks(task_id,title,prompt,enabled,schedule_json,project_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,next_run_at,last_run_status,run_count,webhook_token,webhook_secret) VALUES ('copied-running-task','copied title','copied prompt',1,'{}','copied-project','{}','{}','full-access','default','user','web','2026-01-01','2026-01-01','2026-01-01','running',7,'copied-token','copied-secret')`;
      yield* sql`INSERT INTO scheduled_task_webhook_deliveries(delivery_id,task_id,received_at,method,query,headers_json,body,body_bytes,body_truncated,outcome,signature_verified,missing_fields_json) VALUES ('copied-delivery','copied-running-task','2026-01-01','POST','','{}','copied body',11,0,'accepted',1,'[]')`;
      yield* sql`INSERT INTO scheduled_task_webhook_pending VALUES ('copied-delivery','copied-running-task','copied-key',0,'running','{}','{}','[]')`;
      yield* sql`INSERT INTO scheduled_task_webhook_replay_keys VALUES ('copied-running-task','copied-replay','copied-delivery',0)`;
      yield* sql`INSERT INTO scheduled_task_webhook_relay_deliveries VALUES ('copied-relay','copied-running-task','2026-01-01')`;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
    const snapshot = yield* Effect.promise(() =>
      prepareUpgradeSnapshot({
        configured: { dbPath },
        disposableRoot,
        activeDatabasePaths: [dbPath],
      }),
    );
    const base = layerControlledRoutineIsolation.pipe(
      Layer.provideMerge(upgradeValidationBaseRuntime(snapshot)),
    );
    const externals = Layer.mergeAll(
      Layer.mock(ServerSecretStore.ServerSecretStore)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("External HTTP is disabled")),
      ),
      Layer.mock(TerminalManager.TerminalManager)({}),
      Layer.mock(OwnerDeadline.OwnerDeadlineControl)({}),
      Layer.mock(Cleanup.ResourceCleanupService)({}),
      Layer.succeed(Environment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("fixture")),
        getDescriptor: Effect.die("unused"),
      }),
    );
    const infrastructure = Layer.mergeAll(
      AuthSessions.layer,
      WorkspacePaths.layer,
      WorktreeSetup.layer,
      externals,
    ).pipe(Layer.provideMerge(base));
    const repository = AssistantRepository.layer.pipe(Layer.provideMerge(infrastructure));
    const routinePorts = Layer.mergeAll(RoutineRepository.layer, AssistantEvents.layer).pipe(
      Layer.provideMerge(repository),
    );
    const business = layerControlledBusiness(snapshot).pipe(Layer.provideMerge(routinePorts));
    const routinesLayer = layerControlledRoutines.pipe(Layer.provideMerge(business));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const isolation = yield* ControlledRoutineIsolation;
      const runtime = yield* AssistantRuntime;
      const sessions = yield* AuthSessions.AuthSessionRepository;
      const sessionId = AuthSessionId.make("routine-fixture-human");
      yield* sessions.create({
        sessionId,
        subject: "fixture",
        scopes: [AuthOrchestrationOperateScope, AuthOrchestrationReadScope],
        method: "browser-session-cookie",
        issuedAt: yield* DateTime.now,
        expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00Z"),
        client: {
          label: null,
          ipAddress: null,
          userAgent: null,
          deviceType: "unknown",
          os: null,
          browser: null,
        },
      });
      yield* isolation.assertCopiedUnchanged;
      const created = yield* runtime.create(
        {
          environmentId: EnvironmentId.make("fixture"),
          commandId: CommandId.make("routine-assistant-create"),
          configuration: {
            ...configuration,
            modelSelection: { instanceId: controlledProviderId, model: controlledProviderModel },
            memory: { ...configuration.memory, automaticCapture: false },
          },
        },
        sessionId,
      );
      assert.equal(created.summary.provisioningState, "ready");
      yield* isolation.assertCopiedUnchanged;
      const scope = {
        environmentId: created.summary.environmentId,
        assistantId: created.summary.assistantId,
      };
      const gateway = yield* AssistantRoutineGateway;
      const routines = yield* AssistantRoutines;
      const owned = yield* RoutineRepository.AssistantRoutineRepository;
      const transcript = yield* ControlledProviderTranscript;
      assert.equal((yield* transcript.turns).length, 0);
      const made = yield* gateway.write(
        {
          ...scope,
          operation: "upsert",
          commandId: CommandId.make("routine-create"),
          title: "Fixture routine",
          prompt: "Report the fixture status",
          enabled: true,
          schedule: { type: "interval", everyMs: 3_600_000 },
        },
        sessionId,
      );
      const taskId = made.taskId;
      yield* isolation.assertCopiedUnchanged;
      const fireCommand = CommandId.make("routine-fire-one");
      const threads = yield* ThreadManagementService;
      const sink = yield* EventSinkV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const afterSequence = yield* sink.latestSequence();
      const launched = yield* gateway.write(
        { ...scope, taskId, operation: "run-now", commandId: fireCommand },
        sessionId,
      );
      assert.equal(launched.threadId, created.summary.binding.canonicalThreadId);
      yield* worker.drain();
      const terminals = yield* sink.stream({ afterSequence }).pipe(
        Stream.filter(
          ({ event }) => event.type === "run.updated" && event.payload.status === "waiting",
        ),
        Stream.take(1),
        Stream.runCollect,
      );
      assert.equal(terminals.length, 1);
      yield* worker.drain();
      const firstFire = (yield* routines.fires({ ...scope, taskId }))[0]!;
      assert.equal(firstFire.status, "completed");
      assert.isNotNull(firstFire.runId);
      const completed = yield* threads.getThreadProjection(
        created.summary.binding.canonicalThreadId,
      );
      assert.equal(completed.runs.length, 1);
      assert.equal(completed.runs[0]!.status, "completed");
      assert.isTrue(completed.messages.some((message) => message.text === controlledResponse));
      const receipt = yield* sql<{
        status: string;
      }>`SELECT status FROM orchestration_command_receipts WHERE command_id=${firstFire.commandId}`;
      assert.equal(receipt[0]?.status, "accepted");
      yield* isolation.assertCopiedUnchanged;

      // A lost post-commit acknowledgment is recovered by reconstructing the real service on its owned connection.
      yield* sql`UPDATE scheduled_tasks SET last_run_status='running' WHERE task_id=${taskId}`;
      yield* sql`UPDATE t3_workflow_v2_assistant_routine_fires SET dispatched=0 WHERE fire_key=${firstFire.fireKey}`;
      const context = yield* Effect.context<Layer.Services<typeof ScheduledTasks.layer>>();
      yield* Layer.build(Layer.fresh(ScheduledTasks.layer)).pipe(Effect.provideContext(context));
      const recovered = (yield* routines.fires({ ...scope, taskId }))[0]!;
      assert.equal(recovered.commandId, firstFire.commandId);
      assert.equal(recovered.runId, firstFire.runId);
      assert.equal(recovered.status, "completed");
      assert.isTrue(recovered.dispatched);
      const recoveredCount = (yield* sql<{
        run_count: number;
      }>`SELECT run_count FROM scheduled_tasks WHERE task_id=${taskId}`)[0]!.run_count;
      yield* Layer.build(Layer.fresh(ScheduledTasks.layer)).pipe(Effect.provideContext(context));
      assert.equal(
        (yield* sql<{
          run_count: number;
        }>`SELECT run_count FROM scheduled_tasks WHERE task_id=${taskId}`)[0]!.run_count,
        recoveredCount,
      );
      const replay = yield* gateway.write(
        { ...scope, taskId, operation: "run-now", commandId: fireCommand },
        sessionId,
      );
      assert.equal(replay.threadId, created.summary.binding.canonicalThreadId);
      assert.equal((yield* routines.fires({ ...scope, taskId })).length, 1);
      assert.equal((yield* transcript.turns).length, 1);
      yield* isolation.assertCopiedUnchanged;

      // Leave the next admission pending so lifecycle controls can prove they fence future inference without stopping it.
      yield* gateway.write(
        { ...scope, taskId, operation: "run-now", commandId: CommandId.make("routine-fire-two") },
        sessionId,
      );
      const beforeDisable = yield* threads.getThreadProjection(
        created.summary.binding.canonicalThreadId,
      );
      const pending = beforeDisable.runs.find((run) => run.id !== firstFire.runId)!;
      assert.isDefined(pending);
      assert.include(["queued", "starting"], pending.status);
      const disabled = yield* runtime.lifecycle(
        {
          ...scope,
          commandId: CommandId.make("routine-disable-assistant"),
          expectedRevision: created.configuration.revision,
          action: "disable",
        },
        sessionId,
      );
      assert.isFalse((yield* owned.find(taskId))!.enabled);
      assert.equal(
        (yield* sql<{
          enabled: number;
        }>`SELECT enabled FROM scheduled_tasks WHERE task_id=${taskId}`)[0]!.enabled,
        0,
      );
      const admission = yield* RunAdmission;
      const denied = yield* admission
        .check({
          threadId: created.summary.binding.canonicalThreadId,
          runId: pending.id,
          operation: "start",
          now: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(Effect.result);
      if (denied._tag === "Success") assert.equal(denied.success._tag, "denied");
      const queuedDenied = yield* owned
        .assertQueued({
          runId: pending.id,
          threadId: pending.threadId,
          messageId: pending.userMessageId,
        })
        .pipe(Effect.result);
      assert.equal(queuedDenied._tag, "Failure");
      assert.equal(
        (yield* threads.getThreadProjection(pending.threadId)).runs.find(
          (run) => run.id === pending.id,
        )!.status,
        pending.status,
      );
      yield* threads.interruptThread({
        projectId: created.summary.binding.backingProjectId,
        threadId: pending.threadId,
        runId: pending.id,
        commandId: CommandId.make("routine-explicit-stop"),
      });
      const stopped = (yield* threads.getThreadProjection(pending.threadId)).runs.find(
        (run) => run.id === pending.id,
      )!;
      assert.include(["cancelled", "interrupted"], stopped.status);
      assert.equal((yield* transcript.turns).length, 1);
      const archived = yield* runtime.lifecycle(
        {
          ...scope,
          commandId: CommandId.make("routine-archive-assistant"),
          expectedRevision: disabled.configuration.revision,
          action: "archive",
        },
        sessionId,
      );
      const restored = yield* runtime.lifecycle(
        {
          ...scope,
          commandId: CommandId.make("routine-restore-assistant"),
          expectedRevision: archived.configuration.revision,
          action: "restore",
        },
        sessionId,
      );
      assert.equal(restored.summary.lifecycle, "active");
      assert.isFalse((yield* owned.find(taskId))!.enabled);
      const blocked = yield* gateway
        .write(
          {
            ...scope,
            taskId,
            operation: "run-now",
            commandId: CommandId.make("routine-after-restore"),
          },
          sessionId,
        )
        .pipe(Effect.result);
      assert.equal(blocked._tag, "Failure");
      assert.equal((yield* routines.fires({ ...scope, taskId })).length, 2);
      yield* isolation.assertCopiedUnchanged;
      assert.equal(
        (yield* sql<{
          run_count: number;
          last_run_status: string;
        }>`SELECT run_count,last_run_status FROM main.scheduled_tasks WHERE task_id='copied-running-task'`)[0]
          ?.run_count,
        7,
      );
    }).pipe(
      Effect.provide(
        EffectWorker.layer.pipe(
          Layer.provideMerge(routinesLayer),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);
