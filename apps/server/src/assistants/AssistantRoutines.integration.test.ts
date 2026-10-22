import { assert, it, vi } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  AssistantConfigurationSnapshot,
  OrchestrationV2InstructionSnapshot,
  AuthSessionId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ProviderSessionId,
  ProviderThreadId,
  CommandId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProjectId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Tracer from "effect/Tracer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Config from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Persistence from "../persistence/Sqlite.ts";
import * as Runner from "../processRunner.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Admission from "../orchestration-v2/RunAdmission.ts";
import * as Outbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Enrichment from "../project/ProjectEnrichmentService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as Settings from "../serverSettings.ts";
import * as Repository from "./AssistantRepository.ts";
import * as RoutineRepository from "./AssistantRoutineRepository.ts";
import * as RoutineGateway from "./AssistantRoutineGateway.ts";
import * as AssistantEvents from "./AssistantEventBus.ts";
import * as Routines from "./AssistantRoutines.ts";
import * as AssistantRuntime from "./AssistantRuntime.ts";
import * as AssistantThreadOwnerRead from "./AssistantThreadOwnerRead.ts";
import * as AssistantService from "./AssistantService.ts";
import * as Provisioning from "./AssistantProvisioning.ts";
import { AssistantRoutineMutation } from "./AssistantRoutineMutation.ts";
import * as WorkEvents from "../projectWork/ProjectWorkEventBus.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Checkpoints from "../orchestration-v2/CheckpointService.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as VcsDrivers from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as CommandPolicy from "../orchestration-v2/CommandPolicy.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as ContextHandoff from "../orchestration-v2/ContextHandoffService.ts";
import * as AdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSwitch from "../orchestration-v2/ProviderSwitchService.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadFork from "../orchestration-v2/ThreadForkService.ts";
import * as NativeSessions from "../orchestration-v2/ProviderSessionManager.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { configuration, environmentId } from "./AssistantTestHelpers.ts";
const decodeAdmission = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      configuration: AssistantConfigurationSnapshot,
      snapshot: OrchestrationV2InstructionSnapshot,
    }),
  ),
);
const database = Persistence.layerMemory;
const platform = Layer.mergeAll(
  NodeServices.layer,
  Runner.layer.pipe(Layer.provide(NodeServices.layer)),
  Config.layerTest(process.cwd(), { prefix: "t3-assistant-admission-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  Layer.succeed(Environment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.die("Descriptor is not used by admission."),
  }),
  Settings.layerTest(),
  Layer.mock(Enrichment.ProjectEnrichmentService)({
    peek: () =>
      Effect.succeed({
        repositoryIdentity: null,
        faviconPath: null,
        repositoryIdentityResolved: false,
      }),
    getAvailable: () =>
      Effect.succeed({
        repositoryIdentity: null,
        faviconPath: null,
        repositoryIdentityResolved: false,
      }),
    invalidate: () => Effect.void,
  }),
  Layer.mock(WorkspacePaths.WorkspacePaths)({
    normalizeWorkspaceRoot: (root) => Effect.succeed(root),
  }),
);
const testLayer = Layer.mergeAll(
  WorkEvents.ProjectWorkEventBusLive,
  RuntimeLayer.layerEventSink,
  RuntimeLayer.layerRunAdmission,
  RuntimeLayer.layerProjectService,
  Projections.layer,
  ProjectStore.layer,
  Outbox.layer,
  RoutineRepository.layer,
  AuthSessions.layer,
).pipe(
  Layer.provideMerge(Repository.layer),
  Layer.provideMerge(database),
  Layer.provideMerge(platform),
);

const thread = (
  id: ThreadId,
  projectId: ProjectId,
  now: DateTime.Utc,
): OrchestrationV2AppThread => ({
  id,
  projectId,
  title: "Assistant home",
  createdBy: "system",
  creationSource: "server",
  providerInstanceId: configuration.modelSelection.instanceId,
  modelSelection: configuration.modelSelection,
  runtimeMode: configuration.runtimeMode,
  interactionMode: configuration.interactionMode,
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});
const commit = Effect.fn("AssistantRoutinesIntegration.commit")(function* (
  name: string,
  threadId: ThreadId,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  commandType = "thread.create",
) {
  return yield* (yield* EventSink.EventSinkV2).commitCommand({
    commandId: CommandId.make(name),
    threadId,
    commandType,
    acceptedAt: yield* DateTime.now,
    events,
    effects: [],
  });
});
const setup = Effect.fn("AssistantRoutinesIntegration.setup")(function* (
  selectedConfiguration = configuration,
) {
  const repository = yield* Repository.AssistantRepository;
  const record = yield* repository.create({
    environmentId,
    commandId: CommandId.make("create-assistant"),
    configuration: selectedConfiguration,
  });
  const { binding } = record.detail.summary;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* Config.ServerConfig;
  const workspaceRoot = path.join(config.baseDir, "assistants", binding.assistantId);
  yield* fs.makeDirectory(workspaceRoot, { recursive: true });
  yield* fs.writeFileString(
    path.join(config.baseDir, "assistants", `${binding.assistantId}.claim`),
    binding.assistantId,
  );
  yield* fs.writeFileString(path.join(workspaceRoot, ".t3-assistant-owner"), binding.assistantId);
  const runner = yield* Runner.ProcessRunner;
  for (const args of [
    ["init", "-q", "--initial-branch=main"],
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "Assistant fixture",
    ],
  ]) {
    const result = yield* runner.run({ command: "git", args, cwd: workspaceRoot });
    assert.equal(result.code, 0);
  }
  yield* (yield* ProjectService.ProjectService).create({
    commandId: CommandId.make("create-assistant-project"),
    projectId: binding.backingProjectId,
    title: "Assistant",
    workspaceRoot,
    defaultModelSelection: configuration.modelSelection,
  });
  const now = yield* DateTime.now;
  const home = thread(binding.canonicalThreadId, binding.backingProjectId, now);
  assert.equal(
    (yield* commit("create-assistant-home", home.id, [
      {
        id: EventId.make("assistant-home"),
        type: "thread.created",
        threadId: home.id,
        occurredAt: now,
        payload: home,
      },
    ])).receipt.status,
    "accepted",
  );
  yield* repository.setProvisioning(
    { environmentId, assistantId: binding.assistantId },
    { state: "ready", binding },
    workspaceRoot,
  );
  return {
    repository,
    record: yield* repository.get({ environmentId, assistantId: binding.assistantId }),
    binding,
    workspaceRoot,
    home,
  };
});
const nativeBoundary = Layer.mock(NativeSessions.ProviderSessionManagerV2)({});
const adapters = AdapterRegistry.layerFromAdapters([
  {
    instanceId: configuration.modelSelection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("Continuation only commits V2 effects."),
  },
]);
const dispatchPorts = Layer.mergeAll(
  nativeBoundary,
  adapters,
  CommandPolicy.layer,
  Receipts.layer,
  ContextHandoff.layer.pipe(Layer.provide(IdAllocator.layer)),
  ProviderSwitch.layer.pipe(Layer.provide(adapters)),
  RuntimePolicy.layer,
  ThreadFork.layer,
  IdAllocator.layer,
  Checkpoints.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        CheckpointStore.layer.pipe(
          Layer.provide(VcsDrivers.layer.pipe(Layer.provide(VcsProcess.layer))),
        ),
      ).pipe(Layer.provideMerge(NodeCrypto.layer)),
    ),
  ),
);
const dispatchThreads = Threads.layer.pipe(
  Layer.provideMerge(Orchestrator.layer.pipe(Layer.provideMerge(dispatchPorts))),
);

const unused = Layer.mergeAll(
  Layer.mock(Launch.ThreadLaunchService)({}),
  Layer.mock(Folders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
  Layer.mock(SecretRequests.SecretRequests)({}),
);
const schedulerPorts = Layer.mergeAll(unused, Scheduler.layer).pipe(
  Layer.provideMerge(NodeCrypto.layer),
);
const scheduled = ScheduledTasks.layer.pipe(Layer.provideMerge(schedulerPorts));
const lifecycle = AssistantRuntime.layer.pipe(
  Layer.provide(AssistantThreadOwnerRead.layer),
  Layer.provideMerge(AssistantService.layer.pipe(Layer.provideMerge(Provisioning.layer))),
);
const workflow = Layer.mergeAll(
  Routines.layer.pipe(Layer.provideMerge(scheduled)),
  lifecycle.pipe(Layer.provide(unused)),
).pipe(Layer.provideMerge(dispatchThreads), Layer.provideMerge(testLayer));
const createRoutine = Effect.fn("AssistantRoutinesIntegration.createRoutine")(function* () {
  const fixture = yield* setup();
  const routines = yield* Routines.AssistantRoutines;
  const scope = { environmentId, assistantId: fixture.binding.assistantId };
  const routine = yield* routines.upsert({
    ...scope,
    commandId: CommandId.make("create-routine"),
    title: "Daily check",
    prompt: "Check progress",
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
  });
  assert.isNotNull(routine.task);
  return { ...fixture, routines, scope, routine, taskId: routine.binding.taskId };
});

it.live("scheduler dispatches one canonical V2 routine run and retains late failure", () =>
  Effect.gen(function* () {
    const { routines, scope, taskId, home } = yield* createRoutine();
    const input = { ...scope, taskId, commandId: CommandId.make("manual-fire") };
    assert.equal((yield* routines.runNow(input)).threadId, home.id);
    const projection = yield* Projections.ProjectionStoreV2;
    const before = yield* projection.getThreadRecords(home.id, ["runs"]);
    assert.isDefined(before);
    const fires = yield* routines.fires({ ...scope, taskId });
    assert.equal(fires.length, 1);
    assert.isNotNull(fires[0]!.runId);
    assert.equal((yield* routines.runNow(input)).threadId, home.id);
    assert.equal((yield* routines.fires({ ...scope, taskId })).length, 1);
    const sql = yield* SqlClient.SqlClient;
    const counts = yield* sql<{
      count: number;
    }>`SELECT count(*) AS count FROM orchestration_v2_projection_runs WHERE thread_id=${home.id}`;
    assert.equal(counts[0]!.count, 1);
    const runId = fires[0]!.runId;
    if (runId === null) throw new Error("Accepted fire must retain its actual V2 run.");
    const run = before.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new Error("Actual run missing.");
    const now = yield* DateTime.now;
    assert.equal(
      (yield* commit(
        "native-failure",
        home.id,
        [
          {
            id: EventId.make("native-failure"),
            type: "run.updated",
            threadId: home.id,
            runId,
            occurredAt: now,
            payload: { ...run, status: "failed", completedAt: now },
          },
        ],
        "provider.observe",
      )).receipt.status,
      "accepted",
    );
    assert.equal((yield* routines.fires({ ...scope, taskId }))[0]!.status, "failed");
    assert.equal(
      (yield* (yield* ScheduledTasks.ScheduledTaskService).get({ id: taskId }))!.lastRunStatus,
      "succeeded",
    );
  }).pipe(Effect.provide(workflow)),
);

it.live.each(["disable", "archive"] as const)(
  "%s suspends a queued routine without stopping the active canonical turn",
  (action) =>
    Effect.gen(function* () {
      const { routines, scope, taskId, home, record } = yield* createRoutine();
      const threads = yield* Threads.ThreadManagementService;
      yield* threads.sendToThread({
        projectId: home.projectId,
        threadId: home.id,
        commandId: CommandId.make("human-send"),
        messageId: MessageId.make("human-message"),
        text: "Keep working until I stop you",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
      const projection = yield* Projections.ProjectionStoreV2;
      const initial = (yield* projection.getThreadRecords(home.id, ["runs"])).runs[0];
      if (!initial || initial.activeAttemptId === null)
        throw new Error("Human dispatch must allocate an actual attempt.");
      const now = yield* DateTime.now;
      const active = { ...initial, status: "running" as const, startedAt: now };
      assert.equal(
        (yield* commit(
          "active-native",
          home.id,
          [
            {
              id: EventId.make("active-native"),
              type: "run.updated",
              threadId: home.id,
              runId: active.id,
              occurredAt: now,
              payload: active,
            },
          ],
          "provider.observe",
        )).receipt.status,
        "accepted",
      );
      yield* routines.runNow({ ...scope, taskId, commandId: CommandId.make("queued-fire") });
      const facts = yield* projection.getThreadRecords(home.id, ["runs", "messages"]);
      assert.equal(facts.runs.length, 2);
      assert.equal(facts.runs[0]!.id, active.id);
      const queued = facts.runs[1]!;
      assert.equal(queued.status, "queued");
      assert.equal(
        facts.messages.find((message) => message.id === queued.userMessageId)!.text,
        "Check progress",
      );
      const sql = yield* SqlClient.SqlClient;
      const snapshots = yield* sql<{
        configuration_revision: number;
        configuration_json: string;
      }>`SELECT configuration_revision,configuration_json FROM t3_workflow_v2_assistant_admissions WHERE thread_id=${home.id} ORDER BY created_at,run_id`;
      assert.equal(snapshots.length, 2);
      for (const row of snapshots) {
        const captured = yield* decodeAdmission(row.configuration_json);
        assert.deepStrictEqual(captured.configuration, record.detail.configuration);
        assert.include(captured.snapshot.roleInstructions, configuration.rules);
        assert.include(captured.snapshot.roleInstructions, configuration.prompt);
        assert.equal(captured.snapshot.memoryEpoch, 0);
      }

      assert.deepStrictEqual(
        snapshots.map((row) => row.configuration_revision),
        [record.detail.configuration.revision, record.detail.configuration.revision],
      );
      const sessionId = AuthSessionId.make("routine-human");
      yield* (yield* AuthSessions.AuthSessionRepository).create({
        sessionId,
        subject: "maintainer",
        scopes: [AuthOrchestrationOperateScope],
        method: "browser-session-cookie",
        issuedAt: now,
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
      yield* (yield* AssistantRuntime.AssistantRuntime).lifecycle(
        {
          ...scope,
          commandId: CommandId.make("lifecycle"),
          expectedRevision: record.detail.configuration.revision,
          action,
        },
        sessionId,
      );
      assert.equal(
        (yield* (yield* ScheduledTasks.ScheduledTaskService).get({ id: taskId }))!.enabled,
        false,
      );
      const admission = yield* Admission.RunAdmission;
      const blocked = yield* admission
        .check({
          threadId: home.id,
          runId: queued.id,
          operation: "start",
          now: DateTime.formatIso(now),
        })
        .pipe(Effect.result);
      if (blocked._tag === "Success") assert.equal(blocked.success._tag, "denied");
      else assert.instanceOf(blocked.failure, Admission.RunAdmissionError);
      const promotion = yield* commit(
        "queued-after-lifecycle",
        home.id,
        [
          {
            id: EventId.make("queued-after-lifecycle"),
            type: "run.updated",
            threadId: home.id,
            runId: queued.id,
            occurredAt: now,
            payload: { ...queued, status: "starting", startedAt: now },
          },
        ],
        "run.restart",
      ).pipe(Effect.result);
      if (promotion._tag === "Success") assert.equal(promotion.success.receipt.status, "rejected");
      else assert.instanceOf(promotion.failure, EventSink.EventSinkWriteError);
      assert.equal(
        (yield* projection.getThreadRecords(home.id, ["runs"])).runs.find(
          (run) => run.id === queued.id,
        )!.status,
        "queued",
      );
      assert.deepStrictEqual(
        yield* admission.observeNativeTurn({
          threadId: home.id,
          runId: active.id,
          runAttemptId: initial.activeAttemptId,
          now: DateTime.formatIso(now),
          terminal: false,
        }),
        { stop: false, cancelControlIds: [] },
      );
      assert.equal(
        (yield* projection.getThreadRecords(home.id, ["runs"])).runs.find(
          (run) => run.id === active.id,
        )!.status,
        "running",
      );
      assert.equal(
        (yield* routines
          .runNow({ ...scope, taskId, commandId: CommandId.make("new-after-lifecycle") })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.deepStrictEqual(
        yield* sql<{
          configuration_revision: number;
          configuration_json: string;
        }>`SELECT configuration_revision,configuration_json FROM t3_workflow_v2_assistant_admissions WHERE thread_id=${home.id} ORDER BY created_at,run_id`,
        snapshots,
      );
    }).pipe(Effect.provide(workflow)),
);

it.live(
  "fresh scheduler recovers committed V2 acceptance while the old dispatch ACK is withheld",
  () =>
    Effect.gen(function* () {
      const { routines, scope, taskId, home } = yield* createRoutine();
      const threads = yield* Threads.ThreadManagementService;
      const accepted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const original = threads.sendToThread;
      using spy = vi.spyOn(threads, "sendToThread").mockImplementation((input) =>
        original(input).pipe(
          Effect.tap(() => Deferred.succeed(accepted, undefined)),
          Effect.tap(() => Deferred.await(release)),
        ),
      );
      const input = { ...scope, taskId, commandId: CommandId.make("lost-ack") };
      const pending = yield* routines.runNow(input).pipe(Effect.forkScoped);
      yield* Deferred.await(accepted);
      const originalFire = (yield* routines.fires({ ...scope, taskId }))[0]!;
      assert.isNotNull(originalFire.runId);
      assert.equal(
        (yield* (yield* ScheduledTasks.ScheduledTaskService).get({ id: taskId }))!.lastRunStatus,
        "running",
      );
      const dependencies = yield* Effect.context<Layer.Success<typeof workflow>>();
      const restored = yield* Layer.build(
        Layer.fresh(ScheduledTasks.layer).pipe(Layer.provide(Layer.succeedContext(dependencies))),
      );
      const scheduler = Context.get(restored, ScheduledTasks.ScheduledTaskService);
      assert.equal((yield* scheduler.get({ id: taskId }))!.lastRunStatus, "succeeded");
      assert.equal(
        (yield* scheduler
          .runNow({ id: taskId, commandId: input.commandId })
          .pipe(Effect.provideService(AssistantRoutineMutation, { scope, taskId }))).threadId,
        home.id,
      );
      assert.equal(spy.mock.calls.length, 1);
      assert.equal((yield* routines.fires({ ...scope, taskId }))[0]!.runId, originalFire.runId);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(pending);
      assert.equal((yield* scheduler.get({ id: taskId }))!.runCount, 1);
      assert.equal(
        (yield* (yield* Projections.ProjectionStoreV2).getThreadRecords(home.id, ["runs"])).runs
          .length,
        1,
      );
    }).pipe(Effect.provide(workflow)),
);

it.live("actual scheduler claim rolls back the retained fire when markRunning aborts", () =>
  Effect.gen(function* () {
    const { routines, scope, taskId, home } = yield* createRoutine();
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(
      "CREATE TRIGGER abort_routine_claim BEFORE UPDATE OF last_run_status ON scheduled_tasks WHEN NEW.last_run_status='running' BEGIN SELECT RAISE(ABORT,'fixture rejects markRunning'); END",
    );
    const input = { ...scope, taskId, commandId: CommandId.make("atomic-fire") };
    assert.equal((yield* routines.runNow(input).pipe(Effect.result))._tag, "Failure");
    assert.deepStrictEqual(yield* routines.fires({ ...scope, taskId }), []);
    assert.equal(
      (yield* (yield* ScheduledTasks.ScheduledTaskService).get({ id: taskId }))!.runCount,
      0,
    );
    assert.deepStrictEqual(
      (yield* (yield* Projections.ProjectionStoreV2).getThreadRecords(home.id, ["runs"])).runs,
      [],
    );
    yield* sql.unsafe("DROP TRIGGER abort_routine_claim");
    yield* routines.runNow(input);
    assert.equal((yield* routines.fires({ ...scope, taskId })).length, 1);
  }).pipe(Effect.provide(workflow)),
);

it.live(
  "generic scheduler mutations cannot escape retained routine ownership while ordinary schedules still dispatch",
  () =>
    Effect.gen(function* () {
      const { routine, taskId, home, scope, routines, workspaceRoot } = yield* createRoutine();
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;
      const original = yield* scheduler.get({ id: taskId });
      if (original === null) throw new Error("Routine schedule missing.");
      const ordinaryProject = ProjectId.make("ordinary-routine-project");
      const ordinaryThread = ThreadId.make("ordinary-routine-thread");
      const ordinaryRoot = (yield* Path.Path).join(workspaceRoot, "ordinary");
      yield* (yield* FileSystem.FileSystem).makeDirectory(ordinaryRoot);
      yield* (yield* ProjectService.ProjectService).create({
        commandId: CommandId.make("ordinary-project"),
        projectId: ordinaryProject,
        title: "Ordinary",
        workspaceRoot: ordinaryRoot,
        defaultModelSelection: configuration.modelSelection,
      });
      const now = yield* DateTime.now;
      assert.equal(
        (yield* commit("ordinary-thread", ordinaryThread, [
          {
            id: EventId.make("ordinary-thread"),
            type: "thread.created",
            threadId: ordinaryThread,
            occurredAt: now,
            payload: thread(ordinaryThread, ordinaryProject, now),
          },
        ])).receipt.status,
        "accepted",
      );
      const draft = {
        id: taskId,
        title: "Changed",
        prompt: "Changed",
        enabled: true,
        schedule: { type: "interval" as const, everyMs: 60_000 },
        projectId: home.projectId,
        threadId: home.id,
        workspaceStrategy: { type: "root" as const },
        modelSelection: configuration.modelSelection,
        runtimeMode: configuration.runtimeMode,
        interactionMode: configuration.interactionMode,
      };
      const newDraft = { ...draft };
      const withoutId = {
        title: newDraft.title,
        prompt: newDraft.prompt,
        enabled: newDraft.enabled,
        schedule: newDraft.schedule,
        projectId: newDraft.projectId,
        threadId: newDraft.threadId,
        workspaceStrategy: newDraft.workspaceStrategy,
        modelSelection: newDraft.modelSelection,
        runtimeMode: newDraft.runtimeMode,
        interactionMode: newDraft.interactionMode,
      };
      for (const mutation of [
        scheduler
          .upsert({ ...withoutId, commandId: CommandId.make("raw-assistant-schedule") })
          .pipe(Effect.asVoid),
        scheduler
          .upsert({ ...draft, projectId: ordinaryProject, threadId: ordinaryThread })
          .pipe(Effect.asVoid),
        scheduler.setEnabled({ id: taskId, enabled: false }).pipe(Effect.asVoid),
        scheduler.delete({ id: taskId }).pipe(Effect.asVoid),
        scheduler.runNow({ id: taskId, commandId: CommandId.make("raw-fire") }).pipe(Effect.asVoid),
        scheduler.rotateWebhookToken({ id: taskId }).pipe(Effect.asVoid),
      ]) {
        const rejected = yield* mutation.pipe(Effect.result);
        assert.equal(rejected._tag, "Failure");
        if (rejected._tag === "Failure")
          assert.include(rejected.failure.message.toLowerCase(), "assistant");
      }
      assert.deepStrictEqual(yield* scheduler.get({ id: taskId }), original);
      assert.deepStrictEqual((yield* routines.list(scope))[0]!.binding, routine.binding);
      assert.deepStrictEqual(yield* routines.fires({ ...scope, taskId }), []);
      const ordinary = yield* scheduler.upsert({
        ...withoutId,
        commandId: CommandId.make("ordinary-schedule"),
        projectId: ordinaryProject,
        threadId: ordinaryThread,
      });
      assert.equal((yield* scheduler.runNow({ id: ordinary.task.id })).threadId, ordinaryThread);
      assert.equal(
        (yield* (yield* Projections.ProjectionStoreV2).getThreadRecords(ordinaryThread, ["runs"]))
          .runs.length,
        1,
      );
      yield* scheduler.setEnabled({ id: ordinary.task.id, enabled: false });
      yield* scheduler.delete({ id: ordinary.task.id });
      assert.equal(yield* scheduler.get({ id: ordinary.task.id }), null);
    }).pipe(Effect.provide(workflow)),
);

const gatewayWorkflow = RoutineGateway.layer.pipe(
  Layer.provideMerge(AssistantEvents.layer),
  Layer.provideMerge(workflow),
);

it.live(
  "human webhook handoff returns the current relay endpoint after creation and rotation",
  () =>
    Effect.gen(function* () {
      const { scope, routines } = yield* createRoutine();
      const gateway = yield* RoutineGateway.AssistantRoutineGateway;
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;
      const writer = AuthSessionId.make("webhook-handoff-writer");
      const reader = AuthSessionId.make("webhook-handoff-reader");
      yield* session(writer, [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
      yield* session(reader, [AuthOrchestrationReadScope]);
      const creation = {
        ...scope,
        operation: "upsert" as const,
        commandId: CommandId.make("webhook-handoff-create"),
        title: "Webhook check",
        prompt: "Check incoming work",
        enabled: true,
        schedule: { type: "webhook" as const },
      };
      const created = yield* gateway.write(creation, writer);
      const input = { ...scope, taskId: created.taskId, operation: "webhook" as const };
      assert.equal((yield* gateway.read(input, reader).pipe(Effect.result))._tag, "Failure");
      const handoff = yield* gateway.read(input, writer);
      if (handoff.operation !== "webhook") throw new Error("Webhook handoff was not returned.");
      assert.equal(handoff.remoteAccessRequired, false);
      assert.equal(handoff.url !== null, true);
      const current = yield* scheduler.get({ id: created.taskId });
      assert.equal(handoff.url === current?.webhook?.url, true);
      const before = (yield* routines.list(scope)).find(
        (item) => item.binding.taskId === created.taskId,
      );
      if (!before) throw new Error("Webhook routine was not retained.");
      yield* gateway.read(input, writer);
      assert.equal(
        (yield* routines.list(scope)).find((item) => item.binding.taskId === created.taskId)
          ?.binding.revision,
        before.binding.revision,
      );
      yield* gateway.write(
        { ...input, operation: "rotate-webhook-token", expectedRevision: before.binding.revision },
        writer,
      );
      const rotated = yield* gateway.read(input, writer);
      if (rotated.operation !== "webhook") throw new Error("Rotated handoff was not returned.");
      assert.equal(rotated.url !== null && rotated.url !== handoff.url, true);
      assert.equal(
        rotated.url === (yield* scheduler.get({ id: created.taskId }))?.webhook?.url,
        true,
      );
      yield* gateway.write(creation, writer);
      const replay = yield* gateway.read(input, writer);
      assert.equal(replay.operation === "webhook" && replay.url === rotated.url, true);
      assert.deepStrictEqual(yield* routines.fires({ ...scope, taskId: created.taskId }), []);
    }).pipe(
      Effect.provide(gatewayWorkflow),
      Effect.provideService(
        ScheduledTasks.ScheduledTaskWebhookOrigin,
        Effect.succeed({ relayHookBaseUrl: "https://relay.example.invalid/v1/hooks/fixture" }),
      ),
    ),
);

it.live(
  "webhook handoff requires remote access without inventing an origin and rejects revoked humans",
  () =>
    Effect.gen(function* () {
      const { scope, routines } = yield* createRoutine();
      const gateway = yield* RoutineGateway.AssistantRoutineGateway;
      const writer = AuthSessionId.make("webhook-local-writer");
      yield* session(writer, [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
      const created = yield* gateway.write(
        {
          ...scope,
          operation: "upsert",
          commandId: CommandId.make("webhook-local-create"),
          title: "Local webhook",
          prompt: "Check incoming work",
          enabled: true,
          schedule: { type: "webhook" },
        },
        writer,
      );
      const input = { ...scope, taskId: created.taskId, operation: "webhook" as const };
      const result = yield* gateway.read(input, writer);
      assert.deepStrictEqual(result, {
        operation: "webhook",
        taskId: created.taskId,
        url: null,
        remoteAccessRequired: true,
      });
      yield* (yield* AuthSessions.AuthSessionRepository).revoke({
        sessionId: writer,
        revokedAt: yield* DateTime.now,
      });
      assert.equal((yield* gateway.read(input, writer).pipe(Effect.result))._tag, "Failure");
      assert.deepStrictEqual(yield* routines.fires({ ...scope, taskId: created.taskId }), []);
    }).pipe(Effect.provide(gatewayWorkflow)),
);

it.live("webhook handoff refuses native callers, sibling owners and mutated retained targets", () =>
  Effect.gen(function* () {
    const { scope, routines, home, repository } = yield* createRoutine();
    const gateway = yield* RoutineGateway.AssistantRoutineGateway;
    const writer = AuthSessionId.make("webhook-owner-writer");
    yield* session(writer, [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
    const routine = yield* routines.upsert({
      ...scope,
      commandId: CommandId.make("webhook-owned-create"),
      title: "Owned webhook",
      prompt: "Check incoming work",
      enabled: true,
      schedule: { type: "webhook" },
    });
    const input = { ...scope, taskId: routine.binding.taskId, operation: "webhook" as const };
    assert.equal(
      (yield* gateway
        .readNative(input, {
          threadId: home.id,
          providerSessionId: "native-cannot-request-private-url",
        })
        .pipe(Effect.result))._tag,
      "Failure",
    );
    const sibling = yield* repository.create({
      environmentId,
      commandId: CommandId.make("webhook-sibling"),
      configuration,
    });
    assert.equal(
      (yield* gateway
        .read({ ...input, assistantId: sibling.detail.summary.assistantId }, writer)
        .pipe(Effect.result))._tag,
      "Failure",
    );
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE scheduled_tasks SET thread_id='mutated-webhook-home' WHERE task_id=${routine.binding.taskId}`;
    assert.equal((yield* gateway.read(input, writer).pipe(Effect.result))._tag, "Failure");
    assert.deepStrictEqual(yield* routines.fires({ ...scope, taskId: routine.binding.taskId }), []);
  }).pipe(Effect.provide(gatewayWorkflow)),
);
const session = Effect.fn("AssistantRoutinesIntegration.session")(function* (
  sessionId: AuthSessionId,
  scopes: ReadonlyArray<typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope>,
) {
  yield* (yield* AuthSessions.AuthSessionRepository).create({
    sessionId,
    subject: "maintainer",
    scopes,
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
});

it.live(
  "routine gateway rechecks real human scopes and revocation while explicit human creation remains allowed",
  () =>
    Effect.gen(function* () {
      const { scope, taskId, routines, routine } = yield* createRoutine();
      const gateway = yield* RoutineGateway.AssistantRoutineGateway;
      const reader = AuthSessionId.make("routine-reader");
      const writer = AuthSessionId.make("routine-writer");
      yield* session(reader, [AuthOrchestrationReadScope]);
      yield* session(writer, [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
      const read = { ...scope, operation: "list" as const, limit: 20 };
      assert.equal((yield* gateway.read(read, reader)).operation, "list");
      assert.equal(
        (yield* gateway
          .write(
            {
              ...scope,
              operation: "set-enabled",
              taskId,
              enabled: false,
              expectedRevision: routine.binding.revision,
            },
            reader,
          )
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal((yield* routines.list(scope))[0]!.binding.enabled, true);
      const created = yield* gateway.write(
        {
          ...scope,
          operation: "upsert",
          commandId: CommandId.make("human-create"),
          title: "Human permitted",
          prompt: "Check progress later",
          enabled: true,
          schedule: { type: "interval", everyMs: 60_000 },
        },
        writer,
      );
      assert.notEqual(created.taskId, taskId);
      assert.equal((yield* routines.list(scope)).length, 2);
      const first = (yield* routines.list(scope)).find(
        (item) => item.binding.taskId === created.taskId,
      );
      if (!first) throw new Error("New human routine missing.");
      const edit = {
        ...scope,
        operation: "upsert" as const,
        commandId: CommandId.make("human-edit"),
        taskId: created.taskId,
        expectedRevision: first.binding.revision,
        title: "Edited current title",
        prompt: "Use the latest instructions",
        enabled: true,
        schedule: { type: "interval" as const, everyMs: 120_000 },
      };
      yield* gateway.write(edit, writer);
      const edited = (yield* routines.list(scope)).find(
        (item) => item.binding.taskId === created.taskId,
      );
      if (!edited) throw new Error("Edited routine missing.");
      assert.equal(edited.binding.revision, first.binding.revision + 1);
      assert.equal(edited.task?.prompt, edit.prompt);
      const stale = yield* gateway
        .write(
          {
            ...edit,
            commandId: CommandId.make("stale-human-edit"),
            title: "Stale overwrite",
            prompt: "Outdated instructions",
          },
          writer,
        )
        .pipe(Effect.result);
      assert.equal(stale._tag, "Failure");
      if (stale._tag === "Failure") assert.equal(stale.failure.reason, "conflict");
      assert.deepStrictEqual(
        (yield* routines.list(scope)).find((item) => item.binding.taskId === created.taskId),
        edited,
      );
      yield* gateway.write(
        {
          ...scope,
          operation: "upsert",
          commandId: CommandId.make("human-create"),
          title: "Human permitted",
          prompt: "Check progress later",
          enabled: true,
          schedule: { type: "interval", everyMs: 60_000 },
        },
        writer,
      );
      assert.deepStrictEqual(
        (yield* routines.list(scope)).find((item) => item.binding.taskId === created.taskId),
        edited,
      );
      yield* (yield* AuthSessions.AuthSessionRepository).revoke({
        sessionId: writer,
        revokedAt: yield* DateTime.now,
      });
      assert.equal((yield* gateway.read(read, writer).pipe(Effect.result))._tag, "Failure");
      assert.equal(
        (yield* gateway
          .write(
            {
              ...scope,
              operation: "delete",
              taskId: created.taskId,
              expectedRevision: edited.binding.revision,
            },
            writer,
          )
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal((yield* routines.list(scope)).length, 2);
    }).pipe(Effect.provide(gatewayWorkflow)),
);

it.live(
  "routine native gateway binds canonical current session and refuses creation without consent",
  () =>
    Effect.gen(function* () {
      const { scope, home, workspaceRoot, routines, taskId } = yield* createRoutine();
      const threads = yield* Threads.ThreadManagementService;
      const dispatched = yield* threads.sendToThread({
        projectId: home.projectId,
        threadId: home.id,
        commandId: CommandId.make("native-source"),
        messageId: MessageId.make("native-source"),
        text: "Show my routines",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
      const run = dispatched.run;
      assert.isNotNull(run.activeAttemptId);
      const providerSessionId = ProviderSessionId.make("routine-native-session");
      const providerThreadId = ProviderThreadId.make("routine-native-thread");
      const now = yield* DateTime.now;
      const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
        {
          id: EventId.make("routine-session"),
          type: "provider-session.attached",
          threadId: home.id,
          occurredAt: now,
          payload: {
            id: providerSessionId,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: home.providerInstanceId,
            status: "running",
            cwd: workspaceRoot,
            model: home.modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        },
        {
          id: EventId.make("routine-provider-thread"),
          type: "provider-thread.updated",
          threadId: home.id,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: home.providerInstanceId,
            providerSessionId,
            appThreadId: home.id,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make("routine-running"),
          type: "run.updated",
          threadId: home.id,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, providerThreadId, status: "running", startedAt: now },
        },
      ];
      assert.equal(
        (yield* commit("routine-native-observation", home.id, events, "provider.observe")).receipt
          .status,
        "accepted",
      );
      const gateway = yield* RoutineGateway.AssistantRoutineGateway;
      const caller = { threadId: home.id, providerSessionId };
      const input = { ...scope, operation: "list" as const, limit: 20 };
      const listed = yield* gateway.readNative(input, caller);
      assert.equal(listed.operation, "list");
      if (listed.operation === "list") assert.equal(listed.routines[0]!.taskId, taskId);
      for (const invalid of [
        { ...caller, providerSessionId: "old-session" },
        { ...caller, threadId: ThreadId.make("sibling") },
      ]) {
        assert.equal(
          (yield* gateway.readNative(input, invalid).pipe(Effect.result))._tag,
          "Failure",
        );
      }
      const before = yield* routines.list(scope);
      assert.equal(
        (yield* gateway
          .writeNative(
            {
              ...scope,
              operation: "upsert",
              commandId: CommandId.make("native-create-denied"),
              title: "Unconsented",
              prompt: "Run later",
              enabled: true,
              schedule: { type: "interval", everyMs: 60_000 },
            },
            caller,
          )
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.deepStrictEqual(yield* routines.list(scope), before);
      assert.deepStrictEqual(yield* routines.fires({ ...scope, taskId }), []);
    }).pipe(Effect.provide(gatewayWorkflow)),
);

it.live.each(["acknowledgment-write", "postcommit-callback"] as const)(
  "accepted assistant webhook keeps its replay claim after %s failure",
  (fault) =>
    Effect.gen(function* () {
      const { binding, home } = yield* setup();
      const scope = { environmentId, assistantId: binding.assistantId };
      const routines = yield* Routines.AssistantRoutines;
      const routine = yield* routines.upsert({
        ...scope,
        commandId: CommandId.make("webhook-routine"),
        title: "Webhook",
        prompt: "Inspect delivered issue",
        enabled: true,
        schedule: { type: "webhook", dedupe: { replayKey: "{{headers.delivery-id}}" } },
      });
      const task = routine.task;
      if (!task?.webhook) throw new Error("Webhook URL was not created.");
      const sql = yield* SqlClient.SqlClient;
      if (fault === "acknowledgment-write")
        yield* sql.unsafe(
          "CREATE TRIGGER abort_webhook_ack BEFORE UPDATE OF dispatched ON t3_workflow_v2_assistant_routine_fires BEGIN SELECT RAISE(ABORT,'fixture rejects postcommit acknowledgement'); END",
        );
      const threads = yield* Threads.ThreadManagementService;
      const original = threads.sendToThread;
      using spy = vi.spyOn(threads, "sendToThread").mockImplementation((input) =>
        original(input).pipe(
          Effect.flatMap((result) =>
            fault === "postcommit-callback"
              ? Effect.fail(
                  new Threads.ThreadManagementThreadNotFoundError({
                    projectId: input.projectId,
                    threadId: input.threadId,
                  }),
                )
              : Effect.succeed(result),
          ),
        ),
      );
      const done = yield* Deferred.make<void>();
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (...args) => {
            end(...args);
            if (span.name === "ScheduledTaskService.runWebhookDelivery")
              Deferred.doneUnsafe(done, Effect.void);
          };
          return span;
        },
      });
      const request: ScheduledTasks.WebhookTriggerRequest = {
        hookId: task.id,
        token: task.webhook.path.split("/").at(-1) ?? "",
        method: "POST",
        path: `/api/hooks/${task.id}`,
        query: "",
        headers: { "content-type": "application/json", "delivery-id": "A" },
        body: new TextEncoder().encode("{}"),
        bodyText: "{}",
      };
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;
      const accepted = yield* scheduler.triggerWebhook(request).pipe(Effect.withTracer(tracer));
      assert.equal(accepted._tag, "accepted");
      if (accepted._tag !== "accepted") throw new Error("Initial webhook was refused.");
      assert.equal(accepted.outcome, "accepted");
      yield* Deferred.await(done);
      const before = yield* routines.fires({ ...scope, taskId: task.id });
      assert.equal(before.length, 1);
      assert.isNotNull(before[0]!.runId);
      const receipts = yield* sql<{
        status: string;
      }>`SELECT status FROM orchestration_command_receipts WHERE command_id=${before[0]!.commandId}`;
      assert.equal(receipts[0]!.status, "accepted");
      const keys = yield* sql<{
        delivery_id: string;
      }>`SELECT delivery_id FROM scheduled_task_webhook_replay_keys WHERE task_id=${task.id}`;
      assert.deepStrictEqual(keys, [{ delivery_id: accepted.deliveryId }]);
      if (fault === "acknowledgment-write") yield* sql.unsafe("DROP TRIGGER abort_webhook_ack");
      const replay = yield* scheduler.triggerWebhook(request);
      assert.equal(replay._tag === "accepted" && replay.outcome, "duplicate");
      assert.equal(spy.mock.calls.length, 1);
      assert.deepStrictEqual(yield* routines.fires({ ...scope, taskId: task.id }), before);
      assert.deepStrictEqual(
        yield* sql<{
          delivery_id: string;
        }>`SELECT delivery_id FROM scheduled_task_webhook_replay_keys WHERE task_id=${task.id}`,
        keys,
      );
      assert.equal(
        (yield* (yield* Projections.ProjectionStoreV2).getThreadRecords(home.id, ["runs"])).runs
          .length,
        1,
      );
      const delivery = (yield* scheduler.getWebhookDelivery({
        id: task.id,
        deliveryId: accepted.deliveryId,
      })).delivery;
      if (delivery.error !== null) assert.notInclude(delivery.error, "failed to start");
    }).pipe(Effect.provide(workflow)),
);
