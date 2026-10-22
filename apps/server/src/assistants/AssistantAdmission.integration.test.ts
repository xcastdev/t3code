import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
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
import * as Continuation from "../orchestration-v2/ProviderContinuationService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AssistantConfigurationSnapshot,
  OrchestrationV2InstructionSnapshot,
  AuthSessionId,
  AuthOrchestrationOperateScope,
  ProjectWorkTaskId,
  CommandId,
  EventId,
  MessageId,
  McpDefinitionId,
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderSessionId,
  ProviderTurnId,
  RuntimeRequestId,
  type OrchestrationV2ProviderSession,
  ProjectId,
  RunId,
  RunAttemptId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as NativeRequests from "../orchestration-v2/RuntimeRequestService.ts";
import * as NativeSessions from "../orchestration-v2/ProviderSessionManager.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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
import * as NativeResources from "./AssistantNativeResources.ts";
import * as Repository from "./AssistantRepository.ts";
import * as WorkRepository from "../projectWork/ProjectWorkRepository.ts";
import * as WorkEvents from "../projectWork/ProjectWorkEventBus.ts";
import { seedOwnedThreadWork } from "../orchestration-v2/testkit/OwnedRunTestkit.ts";
import { reconcileWorkBindings } from "./OwnedBindingReconciliation.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as WorkRuntime from "../projectWork/ProjectWorkRuntime.ts";
import * as WorkGateway from "../projectWork/ProjectWorkGateway.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import { configuration, environmentId } from "./AssistantTestHelpers.ts";

const isAdmissionError = Schema.is(Admission.RunAdmissionError);
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
  Repository.layer,
).pipe(Layer.provideMerge(database), Layer.provideMerge(platform));

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
const commit = Effect.fn("AssistantAdmissionIntegration.commit")(function* (
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
const setup = Effect.fn("AssistantAdmissionIntegration.setup")(function* (
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
const createRun = Effect.fn("AssistantAdmissionIntegration.createRun")(function* (
  home: OrchestrationV2AppThread,
  name: string,
  status: "preparing" | "queued" = "preparing",
  ordinal = 1,
  native?: Pick<OrchestrationV2Run, "activeAttemptId" | "providerThreadId" | "rootNodeId">,
) {
  const run: OrchestrationV2Run = {
    id: RunId.make(name),
    threadId: home.id,
    ordinal,
    providerInstanceId: home.modelSelection.instanceId,
    modelSelection: home.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`${name}:message`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: yield* DateTime.now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
    ...native,
  };
  const result = yield* commit(
    `${name}:create`,
    home.id,
    [
      {
        id: EventId.make(`${name}:created`),
        type: "run.created",
        threadId: home.id,
        runId: run.id,
        occurredAt: run.requestedAt,
        payload: run,
      },
    ],
    "message.dispatch",
  );
  return { run, result };
});

it.live(
  "raw project updates, moves and deletes cannot mutate an assistant's reserved backing project",
  () =>
    Effect.gen(function* () {
      const { binding, workspaceRoot } = yield* setup();
      const projects = yield* ProjectService.ProjectService;
      for (const operation of [
        projects.update({
          commandId: CommandId.make("raw-project-title"),
          projectId: binding.backingProjectId,
          title: "Raw title",
        }),
        projects.update({
          commandId: CommandId.make("raw-project-move"),
          projectId: binding.backingProjectId,
          workspaceRoot: `${workspaceRoot}-moved`,
        }),
        projects.delete({
          commandId: CommandId.make("raw-project-delete"),
          projectId: binding.backingProjectId,
          force: true,
        }),
      ])
        assert.equal((yield* operation.pipe(Effect.result))._tag, "Failure");
      const after = Option.getOrThrow(yield* projects.getById(binding.backingProjectId));
      assert.equal(after.workspaceRoot, workspaceRoot);
      assert.equal(after.deletedAt, null);
      assert.equal(after.title, "Assistant");
    }).pipe(Effect.provide(testLayer)),
);

it.live(
  "actual event-sink guards reject backing siblings, batch deletion, moves, and unowned forks atomically",
  () =>
    Effect.gen(function* () {
      const { home, binding } = yield* setup();
      const now = yield* DateTime.now;
      const sibling = thread(ThreadId.make("raw-sibling"), binding.backingProjectId, now);
      const batchOrdinary = thread(
        ThreadId.make("ordinary-in-batch"),
        ProjectId.make("ordinary-project"),
        now,
      );
      const fork = {
        ...sibling,
        id: ThreadId.make("raw-fork"),
        lineage: {
          parentThreadId: home.id,
          relationshipToParent: "fork" as const,
          rootThreadId: home.id,
        },
      };
      for (const [name, commandType, events] of [
        [
          "raw-sibling",
          "thread.create",
          [
            {
              id: EventId.make("sibling"),
              type: "thread.created",
              threadId: sibling.id,
              occurredAt: now,
              payload: sibling,
            },
          ],
        ],
        [
          "raw-batch-delete",
          "threads.delete",
          [
            {
              id: EventId.make("ordinary-batch-create"),
              type: "thread.created",
              threadId: batchOrdinary.id,
              occurredAt: now,
              payload: batchOrdinary,
            },
            {
              id: EventId.make("delete"),
              type: "thread.deleted",
              threadId: home.id,
              occurredAt: now,
              payload: { ...home, deletedAt: now },
            },
          ],
        ],
        [
          "raw-home-move",
          "thread.metadata.update",
          [
            {
              id: EventId.make("move"),
              type: "thread.metadata-updated",
              threadId: home.id,
              occurredAt: now,
              payload: { ...home, projectId: ProjectId.make("escaped") },
            },
          ],
        ],
        [
          "raw-home-model",
          "thread.model.set",
          [
            {
              id: EventId.make("model-change"),
              type: "thread.model-selection-updated",
              threadId: home.id,
              occurredAt: now,
              payload: {
                ...home,
                modelSelection: { ...home.modelSelection, model: "unconfigured-model" },
              },
            },
          ],
        ],
        [
          "raw-home-runtime",
          "thread.runtime-mode.set",
          [
            {
              id: EventId.make("runtime-change"),
              type: "thread.runtime-mode-updated",
              threadId: home.id,
              occurredAt: now,
              payload: { ...home, runtimeMode: "full-access" },
            },
          ],
        ],
        [
          "raw-fork",
          "thread.fork",
          [
            {
              id: EventId.make("fork"),
              type: "thread.created",
              threadId: fork.id,
              occurredAt: now,
              payload: fork,
            },
          ],
        ],
      ] as const) {
        const result = yield* commit(name, home.id, events, commandType).pipe(Effect.result);
        if (result._tag === "Success") {
          assert.equal(result.success.receipt.status, "rejected", name);
          assert.deepStrictEqual(result.success.storedEvents, []);
        } else assert.isTrue(isAdmissionError(result.failure.cause), name);
      }
      const projections = yield* Projections.ProjectionStoreV2;
      assert.equal(yield* projections.getThreadShell(sibling.id), null);
      assert.equal(yield* projections.getThreadShell(batchOrdinary.id), null);
      assert.equal(yield* projections.getThreadShell(fork.id), null);
      assert.equal(
        (yield* projections.getThreadShell(home.id))!.projectId,
        binding.backingProjectId,
      );
      assert.equal((yield* projections.getThreadShell(home.id))!.deletedAt, null);
      assert.deepStrictEqual(
        (yield* projections.getThreadShell(home.id))!.modelSelection,
        home.modelSelection,
      );
      assert.equal((yield* projections.getThreadShell(home.id))!.runtimeMode, home.runtimeMode);
      assert.equal(
        (yield* (yield* Repository.AssistantRepository).get({
          environmentId,
          assistantId: binding.assistantId,
        })).detail.configuration.revision,
        0,
      );
    }).pipe(Effect.provide(testLayer)),
);

it.live(
  "canonical admission retains exact configuration without invented budgets or deadline controls; ordinary threads stay ordinary",
  () =>
    Effect.gen(function* () {
      const { home, binding, record } = yield* setup();
      const { run, result } = yield* createRun(home, "assistant-prepared");
      assert.equal(result.receipt.status, "accepted");
      const admission = yield* Admission.RunAdmission;
      const admitted = yield* admission.check({
        threadId: home.id,
        runId: run.id,
        now: DateTime.formatIso(yield* DateTime.now),
        operation: "preparation",
      });
      assert.equal(admitted._tag, "admitted");
      if (admitted._tag !== "admitted") return yield* Effect.die("Assistant was not admitted");
      assert.equal(admitted.owner.ownerKind, "assistant");
      assert.equal(admitted.owner.bindingId, binding.assistantId);
      assert.equal(admitted.owner.expiresAt, null);
      assert.isUndefined(admitted.owner.configuration.maxTokens);
      assert.isUndefined(admitted.owner.configuration.maxDurationMs);
      assert.isUndefined(admitted.control);
      assert.include(
        admitted.owner.configuration.instructionSnapshot!.roleInstructions!,
        record.detail.configuration.configuration.prompt,
      );
      const sql = yield* SqlClient.SqlClient;
      const retained = yield* sql<{
        configuration_json: string;
      }>`SELECT configuration_json FROM t3_workflow_v2_assistant_admissions WHERE thread_id=${home.id}`;
      assert.equal(retained.length, 1);
      const captured = yield* decodeAdmission(retained[0]!.configuration_json);
      assert.deepStrictEqual(captured.configuration, record.detail.configuration);
      assert.deepStrictEqual(captured.snapshot, admitted.owner.configuration.instructionSnapshot);
      assert.equal((yield* sql`SELECT * FROM t3_workflow_v2_admission_controls`).length, 0);
      const ordinary = thread(
        ThreadId.make("ordinary"),
        ProjectId.make("ordinary-project"),
        yield* DateTime.now,
      );
      assert.equal(
        (yield* commit("ordinary-create", ordinary.id, [
          {
            id: EventId.make("ordinary-created"),
            type: "thread.created",
            threadId: ordinary.id,
            occurredAt: yield* DateTime.now,
            payload: ordinary,
          },
        ])).receipt.status,
        "accepted",
      );
      assert.equal(
        (yield* admission.check({
          threadId: ordinary.id,
          now: DateTime.formatIso(yield* DateTime.now),
        }))._tag,
        "ordinary",
      );
    }).pipe(Effect.provide(testLayer)),
);

it.live.each(["configuration", "disable"] as const)(
  "queued assistant start refuses %s drift without creating provider effects",
  (mode) =>
    Effect.gen(function* () {
      const { home, binding, repository, record } = yield* setup();
      const { run, result } = yield* createRun(home, "queued-assistant", "queued");
      assert.equal(result.receipt.status, "accepted");
      if (mode === "configuration")
        yield* repository.updateConfiguration({
          environmentId,
          assistantId: binding.assistantId,
          commandId: CommandId.make("revise-queued-config"),
          expectedRevision: record.detail.configuration.revision,
          configuration: { ...configuration, prompt: "New prompt" },
        });
      else
        yield* repository.lifecycle({
          environmentId,
          assistantId: binding.assistantId,
          commandId: CommandId.make("disable-queued"),
          expectedRevision: record.detail.configuration.revision,
          action: "disable",
        });
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql`SELECT * FROM orchestration_v2_projection_runs WHERE thread_id=${home.id}`)
          .length,
        1,
      );
      const beforeStart = yield* (yield* Admission.RunAdmission).check({
        threadId: home.id,
        runId: run.id,
        operation: "start",
        now: DateTime.formatIso(yield* DateTime.now),
      });
      assert.equal(beforeStart._tag, "denied");
      const promoted = yield* commit(
        "promote-stale-assistant",
        home.id,
        [
          {
            id: EventId.make("promote"),
            type: "run.updated",
            threadId: home.id,
            runId: run.id,
            occurredAt: yield* DateTime.now,
            payload: {
              ...run,
              status: "starting",
              activeAttemptId: RunAttemptId.make("refused-attempt"),
            },
          },
        ],
        "queued-run.promote",
      );
      assert.equal(promoted.receipt.status, "rejected");
      assert.deepStrictEqual(
        yield* (yield* Outbox.EffectOutboxV2).listByCommandId(
          CommandId.make("promote-stale-assistant"),
        ),
        [],
      );
      assert.equal(
        (yield* (yield* Projections.ProjectionStoreV2).getThreadRecords(home.id, ["runs"])).runs[0]!
          .status,
        "queued",
      );
    }).pipe(Effect.provide(testLayer)),
);

const serviceGuardLayer = Layer.mergeAll(
  WorkRuntime.coreLayer.pipe(Layer.provideMerge(AuthSessions.layer)),
  ScheduledTasks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Scheduler.layer,
        Layer.mock(Launch.ThreadLaunchService)({}),
        Layer.mock(Threads.ThreadManagementService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(Folders.ManagedProjectFolders)({
          namedProjectsRoot: "/unused",
          isScratchProject: () => Effect.succeed(false),
        }),
      ),
    ),
  ),
).pipe(Layer.provideMerge(testLayer));
it.live(
  "actual Work and scheduler services refuse an assistant backing project before retaining work or automations",
  () =>
    Effect.gen(function* () {
      const { binding } = yield* setup();
      yield* (yield* AuthSessions.AuthSessionRepository).create({
        sessionId: AuthSessionId.make("assistant-owner"),
        subject: "maintainer",
        scopes: [AuthOrchestrationOperateScope],
        method: "browser-session-cookie",
        issuedAt: yield* DateTime.now,
        expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00.000Z"),
        client: {
          label: null,
          ipAddress: null,
          userAgent: null,
          deviceType: "unknown",
          os: null,
          browser: null,
        },
      });
      const work = yield* WorkGateway.ProjectWorkGateway;
      const deniedWork = yield* work
        .write(
          {
            type: "project-work.task.create",
            projectId: binding.backingProjectId,
            taskId: ProjectWorkTaskId.make("forbidden-work"),
            commandId: CommandId.make("raw-assistant-work"),
            title: "Work escape",
            createdAt: DateTime.formatIso(yield* DateTime.now),
          },
          {
            environmentId,
            projectId: binding.backingProjectId,
            actor: { kind: "human", id: "maintainer" },
            source: { kind: "web", id: "assistant-owner" },
          },
        )
        .pipe(Effect.result);
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const deniedSchedule = yield* tasks
        .upsert({
          title: "Routine escape",
          prompt: "Should not run",
          enabled: true,
          schedule: { type: "interval", everyMs: 60000 },
          projectId: binding.backingProjectId,
          threadId: binding.canonicalThreadId,
          workspaceStrategy: { type: "root" },
          modelSelection: configuration.modelSelection,
          runtimeMode: configuration.runtimeMode,
          interactionMode: configuration.interactionMode,
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.result);
      assert.equal(deniedSchedule._tag, "Failure");
      assert.equal(deniedWork._tag, "Failure");
      assert.deepStrictEqual((yield* tasks.list()).tasks, []);
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM t3_workflow_v2_work_tasks WHERE project_id=${binding.backingProjectId}`,
        [],
      );
    }).pipe(Effect.provide(serviceGuardLayer)),
);

it.live(
  "stock target movement quarantines and fences Work after 139 healthy bindings without rewriting healthy or ordinary projects",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projects = yield* ProjectService.ProjectService;
      const projectStore = yield* ProjectStore.ProjectStoreV2;
      const config = yield* Config.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const now = yield* DateTime.now;
      const at = DateTime.formatIso(now);
      const targetProject = ProjectId.make("stock-work-target");
      const healthyProject = ProjectId.make("healthy-work-target");
      const ordinaryProject = ProjectId.make("unrelated-ordinary-target");
      const targetThread = ThreadId.make("stock-work-thread");
      const healthyThread = ThreadId.make("healthy-work-thread");
      const ordinaryThread = ThreadId.make("unrelated-ordinary-thread");
      const roots = new Map<ProjectId, string>();
      for (const [projectId, threadId] of [
        [targetProject, targetThread],
        [healthyProject, healthyThread],
        [ordinaryProject, ordinaryThread],
      ] as const) {
        const root = path.join(config.baseDir, projectId);
        roots.set(projectId, root);
        yield* fs.makeDirectory(root, { recursive: true });
        yield* projects.create({
          projectId,
          commandId: CommandId.make(`${projectId}:create`),
          title: projectId,
          workspaceRoot: root,
          defaultModelSelection: configuration.modelSelection,
        });
        const shell = thread(threadId, projectId, now);
        assert.equal(
          (yield* commit(`${threadId}:create`, threadId, [
            {
              id: EventId.make(`${threadId}:created`),
              type: "thread.created",
              threadId,
              occurredAt: now,
              payload: shell,
            },
          ])).receipt.status,
          "accepted",
        );
        if (projectId === ordinaryProject) continue;
        yield* seedOwnedThreadWork({
          projectId,
          threadId,
          modelSelection: configuration.modelSelection,
          now: at,
        });
        const state = yield* WorkRepository.readCurrentState(sql, projectId);
        const binding = state.foundationRecords!.find((record) => record.kind === "run-binding");
        if (binding?.kind !== "run-binding") return yield* Effect.die("Missing owned Work binding");
        yield* sql.withTransaction(
          WorkRepository.appendAdmissionFoundationRecords(
            sql,
            projectId,
            `${threadId}:ready`,
            [
              {
                ...binding,
                workspaceState: "ready",
                workspaceKind: "root",
                worktree: root,
                revision: binding.revision + 1,
              },
            ],
            at,
          ),
        );
      }
      const before = yield* WorkRepository.readCurrentState(sql, targetProject);
      const binding = before.foundationRecords!.find((record) => record.kind === "run-binding");
      if (binding?.kind !== "run-binding") return yield* Effect.die("Missing target Work binding");
      const healthyState = yield* WorkRepository.readCurrentState(sql, healthyProject);
      const healthyBinding = healthyState.foundationRecords!.find(
        (value) => value.kind === "run-binding",
      );
      if (healthyBinding?.kind !== "run-binding")
        return yield* Effect.die("Missing healthy Work binding");
      yield* sql.withTransaction(
        WorkRepository.appendAdmissionFoundationRecords(
          sql,
          healthyProject,
          "healthy-pagination-fixture",
          Array.from({ length: 138 }, (_, index) => ({
            ...healthyBinding,
            revision: 0,
            recordId: `zz-page-${String(index).padStart(3, "0")}`,
          })),
          at,
        ),
      );
      const healthyBefore = yield* WorkRepository.readCurrentState(sql, healthyProject);
      assert.equal(
        healthyBefore.foundationRecords!.filter((value) => value.kind === "run-binding").length,
        139,
      );
      const ordinaryBefore = yield* projectStore.get(ordinaryProject);
      yield* projectStore.apply({
        sequence: 0,
        eventId: EventId.make("stock-project-moved"),
        aggregateKind: "project",
        aggregateId: targetProject,
        occurredAt: at,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.meta-updated",
        payload: {
          projectId: targetProject,
          workspaceRoot: `${roots.get(targetProject)!}-moved`,
          updatedAt: at,
        },
      });
      yield* reconcileWorkBindings();
      const after = yield* WorkRepository.readCurrentState(sql, targetProject);
      const fenced = after.foundationRecords!.find(
        (record) => record.recordId === binding.recordId,
      );
      if (fenced?.kind !== "run-binding")
        return yield* Effect.die("Missing reconciled Work binding");
      assert.equal(fenced.status, "quarantined");
      assert.equal(fenced.revision, binding.revision + 1);
      assert.equal(fenced.leaseGeneration, binding.leaseGeneration + 1);
      assert.equal(fenced.generation, binding.generation);
      assert.equal(after.revision, before.revision + 1);
      assert.deepStrictEqual(
        yield* WorkRepository.readCurrentState(sql, healthyProject),
        healthyBefore,
      );
      assert.deepStrictEqual(yield* projectStore.get(ordinaryProject), ordinaryBefore);
      const admission = yield* Admission.RunAdmission;
      assert.equal(
        (yield* sql.withTransaction(
          admission.commit({
            commandId: "quarantined-work-create",
            threadId: targetThread,
            projectId: targetProject,
            runId: RunId.make("forbidden-stock-target-run"),
            now: at,
            operation: "create",
          }),
        ))._tag,
        "denied",
      );
      assert.equal(
        (yield* admission.check({ threadId: ordinaryThread, now: at }))._tag,
        "ordinary",
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM t3_workflow_v2_run_admissions WHERE thread_id=${targetThread}`,
        [],
      );
      yield* reconcileWorkBindings();
      assert.deepStrictEqual(yield* WorkRepository.readCurrentState(sql, targetProject), after);
    }).pipe(Effect.provide(testLayer)),
);

it.live.each(["disable", "archive"] as const)(
  "an existing native turn answers approvals and questions after %s while future admission and stale sessions remain fenced",
  (action) =>
    Effect.gen(function* () {
      const { home, binding, repository, record, workspaceRoot } = yield* setup();
      const now = yield* DateTime.now;
      const nodeId = NodeId.make("native-node");
      const attemptId = RunAttemptId.make("native-attempt");
      const providerThreadId = ProviderThreadId.make("native-thread");
      const providerSessionId = ProviderSessionId.make("native-session");
      const providerTurnId = ProviderTurnId.make("native-turn");
      const { run, result } = yield* createRun(home, "native-run", "preparing", 1, {
        activeAttemptId: attemptId,
        providerThreadId,
        rootNodeId: nodeId,
      });
      assert.equal(result.receipt.status, "accepted");
      const providerSession: OrchestrationV2ProviderSession = {
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
      };
      const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
        {
          id: EventId.make("native-session"),
          type: "provider-session.attached",
          threadId: home.id,
          occurredAt: now,
          payload: providerSession,
        },
        {
          id: EventId.make("native-thread"),
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
          id: EventId.make("native-running"),
          type: "run.updated",
          threadId: home.id,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "running", startedAt: now },
        },
        {
          id: EventId.make("native-attempt"),
          type: "run-attempt.created",
          threadId: home.id,
          runId: run.id,
          occurredAt: now,
          payload: {
            id: attemptId,
            runId: run.id,
            attemptOrdinal: 1,
            rootNodeId: nodeId,
            providerInstanceId: home.providerInstanceId,
            providerThreadId,
            providerTurnId,
            reason: "initial",
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        },
        {
          id: EventId.make("native-node"),
          type: "node.updated",
          threadId: home.id,
          runId: run.id,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId: home.id,
            runId: run.id,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "root_turn",
            status: "running",
            countsForRun: true,
            providerThreadId,
            providerTurnId,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          id: EventId.make("native-turn"),
          type: "provider-turn.updated",
          threadId: home.id,
          runId: run.id,
          occurredAt: now,
          payload: {
            id: providerTurnId,
            providerThreadId,
            nodeId,
            runAttemptId: attemptId,
            nativeTurnRef: null,
            ordinal: 1,
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        },
        ...(["command", "user_input"] as const).map((kind): OrchestrationV2DomainEvent => ({
          id: EventId.make(`native-${kind}`),
          type: "runtime-request.updated",
          threadId: home.id,
          runId: run.id,
          nodeId,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make(`native-${kind}`),
            nodeId,
            providerTurnId,
            nativeRequestRef: null,
            kind,
            status: "resolved",
            responseCapability: { type: "live", providerSessionId },
            createdAt: now,
            resolvedAt: now,
          },
        })),
      ];
      assert.equal(
        (yield* commit("native-observations", home.id, events, "provider.event")).receipt.status,
        "accepted",
      );
      const acknowledgements: Array<ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput> =
        [];
      const unexpected = () => Effect.die("Unexpected native execution");
      const session: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: home.providerInstanceId,
        driver: ProviderDriverKind.make("codex"),
        providerSessionId,
        providerSession,
        events: Stream.empty,
        ensureThread: unexpected,
        resumeThread: unexpected,
        startTurn: unexpected,
        steerTurn: unexpected,
        interruptTurn: unexpected,
        readThreadSnapshot: unexpected,
        rollbackThread: unexpected,
        forkThread: unexpected,
        respondToRuntimeRequest: (input) =>
          Effect.sync(() => {
            acknowledgements.push(input);
          }),
      };
      const native = NativeRequests.layer.pipe(
        Layer.provide(
          Layer.mock(NativeSessions.ProviderSessionManagerV2)({
            get: (id) =>
              Effect.succeed(id === providerSessionId ? Option.some(session) : Option.none()),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* NativeRequests.RuntimeRequestServiceV2;
        yield* service.respond({
          threadId: home.id,
          providerSessionId,
          requestId: RuntimeRequestId.make("native-command"),
          decision: "accept",
        });
        yield* repository.lifecycle({
          environmentId,
          assistantId: binding.assistantId,
          commandId: CommandId.make(`native-${action}`),
          expectedRevision: record.detail.configuration.revision,
          action,
        });
        yield* service.respond({
          threadId: home.id,
          providerSessionId,
          requestId: RuntimeRequestId.make("native-user_input"),
          answers: { choice: ["continue"] },
        });
        assert.deepStrictEqual(acknowledgements, [
          { requestId: RuntimeRequestId.make("native-command"), decision: "accept" },
          {
            requestId: RuntimeRequestId.make("native-user_input"),
            answers: { choice: ["continue"] },
          },
        ]);
        const stale = yield* service
          .respond({
            threadId: home.id,
            providerSessionId: ProviderSessionId.make("stale-session"),
            requestId: RuntimeRequestId.make("native-command"),
            decision: "accept",
          })
          .pipe(Effect.flip);
        assert.equal(stale.reason, "request-not-resumable");
        const admission = yield* Admission.RunAdmission;
        const observed = yield* admission.observeNativeTurn({
          threadId: home.id,
          runId: run.id,
          runAttemptId: attemptId,
          now: DateTime.formatIso(now),
          terminal: false,
        });
        assert.deepStrictEqual(observed, { stop: false, cancelControlIds: [] });
        const oldAttemptId = RunAttemptId.make("native-old-attempt");
        assert.deepStrictEqual(
          yield* admission.observeNativeTurn({
            threadId: home.id,
            runId: run.id,
            runAttemptId: oldAttemptId,
            now: DateTime.formatIso(now),
            terminal: false,
          }),
          { stop: true, cancelControlIds: [] },
        );
        assert.equal(
          (yield* admission.reconcileNative({
            threadId: home.id,
            runId: run.id,
            runAttemptId: oldAttemptId,
            now: DateTime.formatIso(now),
            accepted: true,
            uncertain: false,
          }))._tag,
          "denied",
        );
        assert.equal(
          (yield* admission.reconcileNative({
            threadId: home.id,
            runId: run.id,
            runAttemptId: attemptId,
            now: DateTime.formatIso(now),
            accepted: true,
            uncertain: false,
          }))._tag,
          "admitted",
        );
        assert.equal(
          (yield* admission.check({
            threadId: home.id,
            operation: "continue",
            now: DateTime.formatIso(now),
            originSessionId: providerSessionId,
          }))._tag,
          "admitted",
        );
        assert.equal(
          (yield* admission.check({
            threadId: home.id,
            operation: "continue",
            now: DateTime.formatIso(now),
            originSessionId: "stale-session",
          }))._tag,
          "denied",
        );
        const next = yield* createRun(home, "future-run", "queued", 2);
        assert.equal(next.result.receipt.status, "rejected");
        assert.equal(acknowledgements.length, 2);
      }).pipe(Effect.provide(native));
    }).pipe(Effect.provide(testLayer)),
);

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
const continuationPorts = Layer.mergeAll(
  nativeBoundary,
  adapters,
  CommandPolicy.layer,
  Receipts.layer,
  ContextHandoff.layer.pipe(Layer.provide(IdAllocator.layer)),
  ProviderSwitch.layer.pipe(Layer.provide(adapters)),
  RuntimePolicy.layer,
  ThreadFork.layer,
  IdAllocator.layer,
  ContinuationRequests.layer,
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
const continuationThreads = Threads.layer.pipe(
  Layer.provideMerge(Orchestrator.layer.pipe(Layer.provideMerge(continuationPorts))),
);
const continuationLayer = Continuation.layer.pipe(
  Layer.provideMerge(continuationThreads),
  Layer.provideMerge(testLayer),
);

it.live.each(["active", "archived", "revised"] as const)(
  "delegated completion from a completed parent honors %s assistant authority through real thread dispatch",
  (mode) =>
    Effect.gen(function* () {
      const { home, repository, binding, record } = yield* setup();
      const providerThreadId = ProviderThreadId.make("completed-native-thread");
      const messageId = MessageId.make("delegated-completion-message");
      const taskId = NodeId.make("completed-delegated-task");
      const now = yield* DateTime.now;
      const { run, result } = yield* createRun(home, "completed-source", "preparing", 1, {
        activeAttemptId: null,
        rootNodeId: null,
        providerThreadId,
      });
      assert.equal(result.receipt.status, "accepted");
      assert.equal(
        (yield* commit(
          "completed-source-observation",
          home.id,
          [
            {
              id: EventId.make("completed-source-observation"),
              type: "run.updated",
              threadId: home.id,
              runId: run.id,
              occurredAt: now,
              payload: {
                ...run,
                status: "completed",
                startedAt: now,
                completedAt: now,
                delegatedCompletion: {
                  disposition: "open",
                  nextGeneration: 2,
                  delivery: { generation: 1, messageId, taskIds: [taskId] },
                },
              },
            },
          ],
          "provider.event",
        )).receipt.status,
        "accepted",
      );
      if (mode === "archived")
        yield* repository.lifecycle({
          environmentId,
          assistantId: binding.assistantId,
          commandId: CommandId.make("archive-completed-parent"),
          expectedRevision: record.detail.configuration.revision,
          action: "archive",
        });
      if (mode === "revised")
        yield* repository.updateConfiguration({
          environmentId,
          assistantId: binding.assistantId,
          commandId: CommandId.make("revise-completed-parent"),
          expectedRevision: record.detail.configuration.revision,
          configuration: { ...configuration, prompt: "Revised next turn prompt" },
        });
      const cleared = yield* Deferred.make<void>();
      yield* (yield* ContinuationRequests.ProviderContinuationRequests).offer({
        threadId: home.id,
        providerThreadId,
        driver: ProviderDriverKind.make("codex"),
        detail: null,
        clearIfCurrent: () => Deferred.succeed(cleared, undefined).pipe(Effect.asVoid),
        delegatedCompletion: { parentRunId: run.id, generation: 1, messageId },
      });
      if (mode !== "active") {
        yield* Deferred.await(cleared);
        const unchanged = yield* (yield* Projections.ProjectionStoreV2).getThreadRecords(home.id, [
          "messages",
          "runs",
        ]);
        assert.equal(unchanged.messages.length, 0);
        assert.equal(unchanged.runs.length, 1);
        assert.equal(unchanged.runs[0]!.status, "completed");
        assert.deepStrictEqual(unchanged.runs[0]!.delegatedCompletion?.delivery?.taskIds, [taskId]);
        assert.equal(
          (yield* (yield* Admission.RunAdmission).check({
            threadId: home.id,
            runId: run.id,
            operation: "completion",
            now: DateTime.formatIso(now),
          }))._tag,
          "admitted",
        );
        return;
      }
      const stored = yield* (yield* EventSink.EventSinkV2)
        .stream({ threadId: home.id, eventType: "message.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "message.updated" && stored.event.payload.id === messageId,
          ),
          Stream.runHead,
        );
      assert.isTrue(Option.isSome(stored));
      const records = yield* (yield* Projections.ProjectionStoreV2).getThreadRecords(home.id, [
        "messages",
        "runs",
      ]);
      const message = records.messages.find((value) => value.id === messageId);
      assert.equal(message?.createdBy, "agent");
      assert.include(message!.text, taskId);
      assert.equal(records.runs.length, 2);
      const continuation = records.runs.find((value) => value.userMessageId === messageId);
      assert.isDefined(continuation);
      const checked = yield* (yield* Admission.RunAdmission).check({
        threadId: home.id,
        runId: continuation!.id,
        operation: "preparation",
        now: DateTime.formatIso(now),
      });
      assert.equal(checked._tag, "admitted");
      if (checked._tag === "admitted") assert.equal(checked.owner.ownerKind, "assistant");
    }).pipe(Effect.provide(continuationLayer)),
);

it.live(
  "retained assistant children cannot become ordinary by moving their project and lineage",
  () =>
    Effect.gen(function* () {
      const { home } = yield* setup();
      const now = yield* DateTime.now;
      const childId = ThreadId.make("retained-child");
      const child: OrchestrationV2AppThread = {
        ...thread(childId, home.projectId, now),
        lineage: {
          parentThreadId: home.id,
          relationshipToParent: "subagent",
          rootThreadId: home.id,
        },
      };
      assert.equal(
        (yield* commit(
          "create-retained-child",
          childId,
          [
            {
              id: EventId.make("retained-child-created"),
              type: "thread.created",
              threadId: childId,
              occurredAt: now,
              payload: child,
            },
          ],
          "delegated_task.request",
        )).receipt.status,
        "accepted",
      );
      const retained = yield* createRun(child, "retained-child-run");
      assert.equal(retained.result.receipt.status, "accepted");
      const config = yield* Config.ServerConfig;
      const ordinaryProject = ProjectId.make("stock-ordinary-project");
      yield* (yield* ProjectService.ProjectService).create({
        projectId: ordinaryProject,
        commandId: CommandId.make("stock-ordinary-project"),
        title: "Ordinary",
        workspaceRoot: config.baseDir,
        defaultModelSelection: configuration.modelSelection,
      });
      const ordinary = thread(ThreadId.make("unrelated-ordinary-child"), ordinaryProject, now);
      assert.equal(
        (yield* commit("ordinary-child-created", ordinary.id, [
          {
            id: EventId.make("ordinary-child-created"),
            type: "thread.created",
            threadId: ordinary.id,
            occurredAt: now,
            payload: ordinary,
          },
        ])).receipt.status,
        "accepted",
      );
      const sql = yield* SqlClient.SqlClient;
      const admissionRows =
        yield* sql`SELECT * FROM t3_workflow_v2_assistant_admissions WHERE thread_id=${childId}`;
      assert.equal(admissionRows.length, 1);
      yield* sql`UPDATE orchestration_v2_projection_threads SET project_id=${ordinaryProject},payload_json=json_set(payload_json,'$.projectId',${ordinaryProject},'$.lineage.parentThreadId',NULL,'$.lineage.rootThreadId',${childId},'$.lineage.relationshipToParent',NULL) WHERE thread_id=${childId}`;
      const admission = yield* Admission.RunAdmission;
      assert.equal(
        (yield* admission.check({
          threadId: childId,
          runId: retained.run.id,
          operation: "continue",
          now: DateTime.formatIso(now),
        }))._tag,
        "denied",
      );
      assert.equal(
        (yield* sql.withTransaction(
          admission.commit({
            commandId: "moved-child-new-run",
            threadId: childId,
            projectId: ordinaryProject,
            runId: RunId.make("moved-child-new-run"),
            operation: "create",
            now: DateTime.formatIso(now),
          }),
        ))._tag,
        "denied",
      );
      assert.equal(
        (yield* admission.check({
          threadId: ordinary.id,
          operation: "continue",
          now: DateTime.formatIso(now),
        }))._tag,
        "ordinary",
      );
      const resources = yield* NativeResources.AssistantNativeResources;
      assert.deepStrictEqual(yield* resources.tools(childId, "stock-session"), []);
      assert.isUndefined(yield* resources.tools(ordinary.id, "ordinary-session"));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM t3_workflow_v2_assistant_admissions WHERE thread_id=${childId}`,
        admissionRows,
      );
      assert.equal(
        (yield* (yield* Projections.ProjectionStoreV2).getThreadRecords(childId, ["runs"])).runs
          .length,
        1,
      );
    }).pipe(Effect.provide(NativeResources.layer.pipe(Layer.provideMerge(testLayer)))),
);

it.live(
  "detaching only retained child lineage revokes selected native tools without changing its project or session",
  () =>
    Effect.gen(function* () {
      const { home } = yield* setup({
        ...configuration,
        resources: {
          ...configuration.resources,
          mcpTools: [{ definitionId: McpDefinitionId.make("definition"), toolNames: ["read"] }],
        },
      });
      const now = yield* DateTime.now;
      const childId = ThreadId.make("lineage-only-child");
      const providerThreadId = ProviderThreadId.make("lineage-only-provider-thread");
      const providerSessionId = ProviderSessionId.make("lineage-only-native-session");
      const child: OrchestrationV2AppThread = {
        ...thread(childId, home.projectId, now),
        lineage: {
          parentThreadId: home.id,
          relationshipToParent: "subagent",
          rootThreadId: home.id,
        },
      };
      assert.equal(
        (yield* commit(
          "lineage-only-child",
          childId,
          [
            {
              id: EventId.make("lineage-only-child"),
              type: "thread.created",
              threadId: childId,
              occurredAt: now,
              payload: child,
            },
          ],
          "delegated_task.request",
        )).receipt.status,
        "accepted",
      );
      const retained = yield* createRun(child, "lineage-only-run", "preparing", 1, {
        activeAttemptId: null,
        providerThreadId,
        rootNodeId: null,
      });
      assert.equal(retained.result.receipt.status, "accepted");
      assert.equal(
        (yield* commit(
          "lineage-only-native-observation",
          childId,
          [
            {
              id: EventId.make("lineage-only-running"),
              type: "run.updated",
              threadId: childId,
              runId: retained.run.id,
              occurredAt: now,
              payload: { ...retained.run, status: "running", startedAt: now },
            },
            {
              id: EventId.make("lineage-only-provider-thread"),
              type: "provider-thread.updated",
              threadId: childId,
              occurredAt: now,
              payload: {
                id: providerThreadId,
                driver: ProviderDriverKind.make("codex"),
                providerInstanceId: child.providerInstanceId,
                providerSessionId,
                appThreadId: childId,
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
          ],
          "provider.event",
        )).receipt.status,
        "accepted",
      );
      const resources = yield* NativeResources.AssistantNativeResources;
      assert.deepStrictEqual(yield* resources.tools(childId, providerSessionId), [
        "definition:read",
      ]);
      const admission = yield* Admission.RunAdmission;
      assert.equal(
        (yield* admission.check({
          threadId: childId,
          runId: retained.run.id,
          operation: "continue",
          now: DateTime.formatIso(now),
        }))._tag,
        "admitted",
      );
      const sql = yield* SqlClient.SqlClient;
      const rowsBefore =
        yield* sql`SELECT * FROM t3_workflow_v2_assistant_admissions WHERE thread_id=${childId}`;
      const factsBefore = yield* (yield* Projections.ProjectionStoreV2).getThreadRecords(childId, [
        "runs",
        "providerThreads",
      ]);
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.parentThreadId',NULL) WHERE thread_id=${childId}`;
      assert.deepStrictEqual(yield* resources.tools(childId, providerSessionId), []);
      assert.equal(
        (yield* admission.check({
          threadId: childId,
          runId: retained.run.id,
          operation: "continue",
          now: DateTime.formatIso(now),
        }))._tag,
        "denied",
      );
      assert.equal(
        (yield* sql.withTransaction(
          admission.commit({
            commandId: "detached-child-new-run",
            threadId: childId,
            projectId: home.projectId,
            runId: RunId.make("detached-child-new-run"),
            operation: "create",
            now: DateTime.formatIso(now),
          }),
        ))._tag,
        "denied",
      );
      const factsAfter = yield* (yield* Projections.ProjectionStoreV2).getThreadRecords(childId, [
        "runs",
        "providerThreads",
      ]);
      assert.deepStrictEqual(factsAfter.runs, factsBefore.runs);
      assert.deepStrictEqual(factsAfter.providerThreads, factsBefore.providerThreads);
      assert.deepStrictEqual(factsAfter.thread, {
        ...factsBefore.thread,
        lineage: { ...factsBefore.thread.lineage, parentThreadId: null },
      });
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM t3_workflow_v2_assistant_admissions WHERE thread_id=${childId}`,
        rowsBefore,
      );
    }).pipe(Effect.provide(NativeResources.layer.pipe(Layer.provideMerge(testLayer)))),
);
