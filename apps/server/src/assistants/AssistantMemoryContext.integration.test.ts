import { assert, it } from "@effect/vitest";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Handoffs from "../orchestration-v2/ContextHandoffService.ts";
import { selectHandoffsForMemoryEpoch } from "../orchestration-v2/ContextHandoffEpoch.ts";
import { deliverContextHandoffs } from "../orchestration-v2/ContextHandoffDelivery.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  CommandId,
  ContextHandoffId,
  EventId,
  MessageId,
  ProjectId,
  ProviderThreadId,
  ProviderSessionId,
  ProviderDriverKind,
  type OrchestrationV2ProviderThread,
  RunId,
  RunAttemptId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  TextGenerationError,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Processing from "../projectWork/memory/ProjectMemoryProcessing.ts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { OrchestrationV2InstructionSnapshot } from "@t3tools/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Config from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Persistence from "../persistence/Sqlite.ts";
import * as Runner from "../processRunner.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Admission from "../orchestration-v2/RunAdmission.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Enrichment from "../project/ProjectEnrichmentService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as Settings from "../serverSettings.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as MemoryGateway from "./AssistantMemoryGateway.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import * as Repository from "./AssistantRepository.ts";
import * as Memory from "./AssistantMemory.ts";
import * as MemoryLayers from "./AssistantMemoryLayers.ts";
import * as MemoryActivity from "./AssistantMemoryActivity.ts";
import * as MemoryRuntime from "./AssistantMemoryRuntime.ts";
import * as Sources from "./AssistantMemorySources.ts";
import * as Resources from "./AssistantResources.ts";
import { sourceTuple } from "../projectWork/memory/ProjectMemoryRepository.ts";
import { instructionDeliveryDecision } from "../orchestration-v2/InstructionDelivery.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { configuration, environmentId } from "./AssistantTestHelpers.ts";
const decodeRetainedInstruction = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ snapshot: OrchestrationV2InstructionSnapshot })),
);
const decodeCompanionRequest = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      operationKey: Schema.String,
      operation: Schema.Literals(["index", "cleanup"]),
    }),
  ),
);
const database = Persistence.layerMemory;
const platform = Layer.mergeAll(
  NodeServices.layer,
  Config.layerTest(process.cwd(), { prefix: "t3-assistant-memory-context-" }).pipe(
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

const fixture = () => {
  const inputs: Generation.MemoryExtractionInput[] = [];
  const extractionStarted = Deferred.makeUnsafe<Generation.MemoryExtractionInput>();
  const cleanupStarted = Deferred.makeUnsafe<void>();
  const releaseCleanup = Deferred.makeUnsafe<void>();
  const companionRequests: Array<{ operationKey: string; operation: "index" | "cleanup" }> = [];
  const runnerBoundary = Layer.effect(
    Runner.ProcessRunner,
    Effect.gen(function* () {
      const actual = yield* Runner.ProcessRunner;
      return Runner.ProcessRunner.of({
        ...actual,
        run: Effect.fn("AssistantMemoryContextIntegration.run")(function* (
          input: Runner.ProcessRunInput,
        ) {
          if (input.command !== "/assistant-memory-companion-fixture")
            return yield* actual.run(input);
          const request = yield* decodeCompanionRequest(input.stdin ?? "").pipe(Effect.orDie);
          companionRequests.push(request);
          if (request.operation === "cleanup") {
            yield* Deferred.succeed(cleanupStarted, undefined);
            yield* Deferred.await(releaseCleanup);
          }
          return {
            stdout: JSON.stringify({ ...request, complete: true }),
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
      });
    }),
  ).pipe(Layer.provide(Runner.layer), Layer.provide(NodeServices.layer));
  let unavailable = false;
  const unused = () => Effect.die("Unexpected optional external route");
  const external = Layer.mergeAll(
    runnerBoundary,
    Layer.succeed(Generation.TextGeneration, {
      generateCommitMessage: unused,
      generateBranchName: unused,
      generateThreadTitle: unused,
      generatePrContent: unused,
      generateReviewGuide: unused,
      extractMemoryFacts: Effect.fn("AssistantMemoryContextIntegration.extract")(function* (
        input: Generation.MemoryExtractionInput,
      ) {
        inputs.push(input);
        yield* Deferred.succeed(extractionStarted, input);
        if (unavailable)
          return yield* new TextGenerationError({
            operation: "extractMemoryFacts",
            detail: "fixture provider unavailable",
          });
        return {
          facts: [{ key: "editor.preference", body: input.sourceText, quote: input.sourceText }],
        };
      }),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("No external network route is authorized")),
    ),
    Layer.mock(Secrets.ServerSecretStore)({ get: unused }),
  );
  const layer = Layer.mergeAll(
    Sources.layer,
    Resources.layer.pipe(Layer.provide(MemoryLayers.layerInstructionContext)),
    RuntimeLayer.layerEventSink,
    RuntimeLayer.layerRunAdmission,
    RuntimeLayer.layerProjectService,
    Handoffs.layer.pipe(
      Layer.provide(IdAllocator.layer),
      Layer.provide(MemoryLayers.layerHandoffEpoch),
    ),
  ).pipe(
    Layer.provideMerge(RuntimeLayer.layerAssistantMemoryGateway),
    Layer.provideMerge(MemoryLayers.layer),
    Layer.provideMerge(MemoryActivity.layer),
    Layer.provideMerge(AuthSessions.layer),
    Layer.provideMerge(Projections.layer),
    Layer.provideMerge(Repository.layer),
    Layer.provideMerge(ProjectStore.layer),
    Layer.provideMerge(database),
    Layer.provideMerge(platform),
    Layer.provideMerge(external),
  );
  return {
    layer,
    inputs,
    extractionStarted,
    cleanupStarted,
    releaseCleanup,
    companionRequests,
    failExtraction: () => {
      unavailable = true;
    },
  };
};
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
const commit = Effect.fn("AssistantMemoryContextIntegration.commit")(function* (
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
const setup = Effect.fn("AssistantMemoryContextIntegration.setup")(function* (
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
const createRun = Effect.fn("AssistantMemoryContextIntegration.createRun")(function* (
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

const settle = Effect.fn("AssistantMemoryContextIntegration.settle")(function* (
  home: OrchestrationV2AppThread,
  name: string,
  text: string,
  options?: { createdBy?: "user" | "agent"; attemptId?: RunAttemptId; ordinal?: number },
) {
  const { run, result } = yield* createRun(home, name, "preparing", options?.ordinal ?? 1, {
    activeAttemptId: options?.attemptId ?? RunAttemptId.make(`${name}:attempt`),
    providerThreadId: null,
    rootNodeId: null,
  });
  assert.equal(result.receipt.status, "accepted");
  const now = yield* DateTime.now;
  const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
    {
      id: EventId.make(`${name}:user`),
      type: "message.updated",
      threadId: home.id,
      runId: run.id,
      occurredAt: now,
      payload: {
        id: run.userMessageId,
        threadId: home.id,
        runId: run.id,
        nodeId: null,
        createdBy: options?.createdBy ?? "user",
        creationSource: "web",
        role: "user",
        text,
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      id: EventId.make(`${name}:completed`),
      type: "run.updated",
      threadId: home.id,
      runId: run.id,
      occurredAt: now,
      payload: {
        ...run,
        status: "completed",
        startedAt: now,
        completedAt: now,
      },
    },
  ];
  assert.equal(
    (yield* commit(`${name}:settled`, home.id, events, "provider.event")).receipt.status,
    "accepted",
  );
  return { run, now };
});

it.live(
  "canonical terminal USER evidence captures once through the live V2 event worker and SQL memory processing",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { home, record, binding, repository, workspaceRoot } = yield* setup();
      yield* Effect.gen(function* () {
        const { run } = yield* settle(home, "canonical-memory", "I prefer the dark editor theme.");
        yield* repository.updateConfiguration({
          environmentId,
          assistantId: binding.assistantId,
          commandId: CommandId.make("change-config-after-source"),
          expectedRevision: record.detail.configuration.revision,
          configuration: { ...configuration, prompt: "New prompt applies to later runs" },
        });
        const evidence = yield* (yield* Sources.AssistantSettledMemorySource).forRun(
          home.id,
          run.id,
        );
        assert.isNotNull(evidence);
        if (evidence === null) return yield* Effect.die("Missing canonical source");
        assert.equal(evidence.configurationRevision, record.detail.configuration.revision);
        assert.deepStrictEqual(evidence.modelSelection, run.modelSelection);
        assert.equal(evidence.cwd, workspaceRoot);
        yield* Deferred.await(f.extractionStarted);
        const memory = yield* Memory.AssistantMemory;
        const captured = yield* memory.capture(evidence);
        yield* memory.process(captured.operationKey);
        const replay = yield* memory.capture(evidence);
        assert.equal(replay.operationKey, captured.operationKey);
        assert.equal(f.inputs.length, 1);
        assert.deepStrictEqual(f.inputs[0], {
          sourceText: evidence.content,
          modelSelection: evidence.modelSelection,
          cwd: workspaceRoot,
        });
        const sql = yield* SqlClient.SqlClient;
        assert.equal(
          (yield* sql`SELECT * FROM t3_workflow_v2_assistant_memory_receipts`).length,
          1,
        );
        assert.equal((yield* sql`SELECT * FROM t3_workflow_v2_memory_processing`).length, 1);
        const current = yield* repository.get({ environmentId, assistantId: binding.assistantId });
        const context = yield* memory.context(current);
        const snapshot = yield* (yield* Resources.AssistantResources).prepare(current, home.id);
        assert.include(context.text, evidence.content);
        assert.include(snapshot.roleInstructions!, evidence.content);
        assert.equal(snapshot.memoryEpoch, context.memoryEpoch);
        assert.isAtMost(context.text.length, 12000);
      }).pipe(Effect.provide(MemoryRuntime.workerLayer));
    }).pipe(Effect.provide(f.layer));
  },
);

it.live(
  "correction and forget replace the next resource context while SQL recall survives model and index outage",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { home, record } = yield* setup();
      const { run } = yield* settle(home, "editable-memory", "I prefer the dark editor theme.");
      const evidence = yield* (yield* Sources.AssistantSettledMemorySource).forRun(home.id, run.id);
      if (evidence === null) return yield* Effect.die("Missing canonical source");
      const memory = yield* Memory.AssistantMemory;
      const first = yield* memory.capture(evidence);
      yield* memory.process(first.operationKey);
      const resources = yield* Resources.AssistantResources;
      const before = yield* resources.prepare(record, home.id);
      const handoffs = yield* Handoffs.ContextHandoffServiceV2;
      const providerThread: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("memory-native-thread"),
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: home.providerInstanceId,
        providerSessionId: null,
        appThreadId: home.id,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: yield* DateTime.now,
        updatedAt: yield* DateTime.now,
      };
      const oldHandoff = yield* handoffs.prepare({
        threadId: home.id,
        targetRunId: run.id,
        fromProviderThreadIds: [],
        toProviderThreadId: providerThread.id,
      });
      assert.equal(oldHandoff.memoryEpoch, before.memoryEpoch);
      const cached = { ...oldHandoff, summaryText: before.roleInstructions! };
      assert.equal(
        (yield* commit(
          "cache-old-personal-summary",
          home.id,
          [
            {
              id: EventId.make("cache-old-personal-summary"),
              type: "context-handoff.updated",
              threadId: home.id,
              runId: run.id,
              occurredAt: yield* DateTime.now,
              payload: cached,
            },
          ],
          "provider.event",
        )).receipt.status,
        "accepted",
      );

      const queued = yield* createRun(home, "queued-before-correction", "queued", 2);
      assert.equal(queued.result.receipt.status, "accepted");
      const tuple = sourceTuple(
        { environmentId, owner: first.source.owner, ownerRevision: record.ownerRevision },
        first.source,
      );
      const corrected = yield* memory.edit({
        previous: tuple,
        content: "I prefer the light editor theme.",
      });
      yield* memory.process(corrected.operationKey);
      const after = yield* resources.prepare(record, home.id);
      assert.isAbove(after.memoryEpoch!, before.memoryEpoch!);
      assert.include(after.roleInstructions!, "light editor");
      assert.notInclude(after.roleInstructions!, "dark editor");
      const cachedRecords = yield* (yield* Projections.ProjectionStoreV2).getThreadRecords(
        home.id,
        ["contextHandoffs"],
      );
      const obsolete = cachedRecords.contextHandoffs.filter((value) => value.id === cached.id);
      assert.equal(obsolete.length, 1);
      assert.include(obsolete[0]!.summaryText, "dark editor");
      assert.equal(selectHandoffsForMemoryEpoch(obsolete, undefined).length, 1);
      const eventSink = yield* EventSink.EventSinkV2;
      const deliverCurrent = Effect.fn("AssistantMemoryContextIntegration.deliverCurrent")(
        function* (memoryEpoch: number, memoryContextHash: string | undefined) {
          const delivery = yield* deliverContextHandoffs({
            handoffs: selectHandoffsForMemoryEpoch(obsolete, memoryEpoch, memoryContextHash),
            providerThread,
            budget: 12000,
            alreadyDeliveredItemIds: new Set<string>(),
            inject: () => Effect.die("Stale private summary reached native history injection"),
            persist: (handoff) =>
              commit(
                `handoff:${handoff.id}`,
                home.id,
                [
                  {
                    id: EventId.make(`handoff:${handoff.id}`),
                    type: "context-handoff.updated",
                    threadId: home.id,
                    runId: run.id,
                    occurredAt: handoff.updatedAt,
                    payload: handoff,
                  },
                ],
                "provider.event",
              ).pipe(Effect.provideService(EventSink.EventSinkV2, eventSink), Effect.asVoid),
          });
          assert.equal(delivery.context, "");
          yield* delivery.delivered;
        },
      );
      yield* deliverCurrent(after.memoryEpoch!, after.memoryContextHash);

      assert.equal(
        (yield* (yield* Admission.RunAdmission).check({
          threadId: home.id,
          runId: queued.run.id,
          operation: "start",
          now: DateTime.formatIso(yield* DateTime.now),
        }))._tag,
        "denied",
      );
      assert.equal(
        instructionDeliveryDecision({
          capabilities: CodexProviderCapabilitiesV2,
          previousSnapshot: before,
          requestedSnapshot: after,
          sessionHasOtherThreads: false,
        }),
        "replace",
      );
      f.failExtraction();
      const outage = yield* resources.prepare(record, home.id);
      assert.deepStrictEqual(outage, after);
      assert.equal(f.inputs.length, 2);
      yield* memory.forget(
        sourceTuple(
          { environmentId, owner: corrected.source.owner, ownerRevision: record.ownerRevision },
          corrected.source,
        ),
      );
      const forgotten = yield* resources.prepare(record, home.id);
      assert.isAbove(forgotten.memoryEpoch!, after.memoryEpoch!);
      assert.notInclude(forgotten.roleInstructions!, "dark editor");
      assert.notInclude(forgotten.roleInstructions!, "light editor");
      yield* deliverCurrent(forgotten.memoryEpoch!, forgotten.memoryContextHash);
      const freshHandoff = yield* handoffs.prepare({
        threadId: home.id,
        targetRunId: run.id,
        fromProviderThreadIds: [],
        toProviderThreadId: providerThread.id,
      });
      assert.equal(freshHandoff.memoryEpoch, forgotten.memoryEpoch);
      assert.equal(
        selectHandoffsForMemoryEpoch(
          [cached, freshHandoff],
          forgotten.memoryEpoch,
          forgotten.memoryContextHash,
        ).length,
        1,
      );

      assert.equal(
        instructionDeliveryDecision({
          capabilities: CodexProviderCapabilitiesV2,
          previousSnapshot: after,
          requestedSnapshot: forgotten,
          sessionHasOtherThreads: false,
        }),
        "replace",
      );
      const next = yield* createRun(home, "next-after-forget", "preparing", 3);
      assert.equal(next.result.receipt.status, "accepted");
      const rows = yield* (yield* SqlClient.SqlClient)<{
        configuration_json: string;
      }>`SELECT configuration_json FROM t3_workflow_v2_assistant_admissions WHERE run_id=${next.run.id}`;
      const retained = yield* decodeRetainedInstruction(rows[0]!.configuration_json);
      assert.equal(retained.snapshot.memoryEpoch, forgotten.memoryEpoch);
      assert.notInclude(retained.snapshot.roleInstructions!, "dark editor");
      assert.notInclude(retained.snapshot.roleInstructions!, "light editor");
      const visible = yield* (yield* Projections.ProjectionStoreV2).getThreadRecords(home.id, [
        "messages",
      ]);
      assert.equal(visible.messages[0]!.text, evidence.content);
      assert.equal(f.inputs.length, 2);
    }).pipe(Effect.provide(f.layer));
  },
);

it.live(
  "child and sibling context receive no implicit personal memory; forged and stale canonical sources deny",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { home, record, binding } = yield* setup();
      const { run } = yield* settle(home, "protected-memory", "I prefer the dark editor theme.", {
        attemptId: RunAttemptId.make("captured-attempt"),
      });
      const sources = yield* Sources.AssistantSettledMemorySource;
      const evidence = yield* sources.forRun(home.id, run.id);
      if (evidence === null) return yield* Effect.die("Missing canonical source");
      const memory = yield* Memory.AssistantMemory;
      const captured = yield* memory.capture(evidence);
      yield* memory.process(captured.operationKey);
      const resources = yield* Resources.AssistantResources;
      const child = {
        ...thread(ThreadId.make("memory-child"), home.projectId, yield* DateTime.now),
        lineage: {
          parentThreadId: home.id,
          relationshipToParent: "subagent" as const,
          rootThreadId: home.id,
        },
      };
      assert.equal(
        (yield* commit(
          "memory-child",
          child.id,
          [
            {
              id: EventId.make("memory-child"),
              type: "thread.created",
              threadId: child.id,
              occurredAt: yield* DateTime.now,
              payload: child,
            },
          ],
          "delegated_task.request",
        )).receipt.status,
        "accepted",
      );
      const childRun = yield* settle(child, "child-memory", "A child must not capture this.");
      assert.equal(yield* sources.forRun(child.id, childRun.run.id), null);
      const childSnapshot = yield* resources.prepare(record, child.id);
      assert.equal(childSnapshot.memoryEpoch, 0);
      assert.notInclude(childSnapshot.roleInstructions!, "dark editor");
      const sibling = yield* (yield* Repository.AssistantRepository).create({
        environmentId,
        commandId: CommandId.make("sibling-owner"),
        configuration: { ...configuration, name: "Sibling" },
      });
      const siblingContext = yield* memory.context(sibling);
      assert.equal(siblingContext.text, "");
      assert.equal(
        (yield* Effect.result(
          memory.capture({ ...evidence, assistantId: sibling.detail.summary.assistantId }),
        ))._tag,
        "Failure",
      );
      const synthetic = yield* settle(
        home,
        "synthetic-memory",
        "Agent-generated user-role text is not a human source.",
        { createdBy: "agent", ordinal: 2 },
      );
      assert.equal(yield* sources.forRun(home.id, synthetic.run.id), null);
      const stale = yield* Effect.result(memory.capture({ ...evidence, content: "Forged text" }));
      assert.equal(stale._tag, "Failure");
      const beforeInvalidation = yield* resources.prepare(record, home.id);
      const handoffs = yield* Handoffs.ContextHandoffServiceV2;
      const priorHandoff = yield* handoffs.prepare({
        threadId: home.id,
        targetRunId: run.id,
        fromProviderThreadIds: [],
        toProviderThreadId: ProviderThreadId.make("stale-source-native-thread"),
      });
      const queued = yield* createRun(home, "queued-before-source-invalidation", "queued", 3);
      assert.equal(queued.result.receipt.status, "accepted");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.activeAttemptId','replacement-attempt') WHERE run_id=${run.id}`;
      assert.equal(yield* sources.forRun(home.id, run.id), null);
      assert.equal((yield* Effect.result(memory.capture(evidence)))._tag, "Failure");
      assert.equal((yield* memory.context(record)).text, "");
      const afterInvalidation = yield* resources.prepare(record, home.id);
      assert.equal(afterInvalidation.memoryEpoch, beforeInvalidation.memoryEpoch);
      assert.notEqual(afterInvalidation.memoryContextHash, beforeInvalidation.memoryContextHash);
      assert.notEqual(afterInvalidation.resourceRevision, beforeInvalidation.resourceRevision);
      assert.equal(
        selectHandoffsForMemoryEpoch(
          [priorHandoff],
          afterInvalidation.memoryEpoch,
          afterInvalidation.memoryContextHash,
        ).length,
        0,
      );
      assert.equal(
        (yield* (yield* Admission.RunAdmission).check({
          threadId: home.id,
          runId: queued.run.id,
          operation: "start",
          now: DateTime.formatIso(yield* DateTime.now),
        }))._tag,
        "denied",
      );
      assert.equal(
        instructionDeliveryDecision({
          capabilities: CodexProviderCapabilitiesV2,
          previousSnapshot: beforeInvalidation,
          requestedSnapshot: afterInvalidation,
          sessionHasOtherThreads: false,
        }),
        "replace",
      );

      assert.equal(
        (yield* sql`SELECT * FROM t3_workflow_v2_assistant_memory_receipts WHERE assistant_id=${binding.assistantId}`)
          .length,
        1,
      );
    }).pipe(Effect.provide(f.layer));
  },
);

it.live(
  "actual authenticated memory gateway keeps read scope and canonical native owner/session authority separate",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { home, record, binding, workspaceRoot } = yield* setup();
      const settled = yield* settle(home, "gateway-source", "I prefer the dark editor theme.");
      const evidence = yield* (yield* Sources.AssistantSettledMemorySource).forRun(
        home.id,
        settled.run.id,
      );
      if (evidence === null) return yield* Effect.die("Missing canonical source");
      const memory = yield* Memory.AssistantMemory;
      const captured = yield* memory.capture(evidence);
      yield* memory.process(captured.operationKey);
      const providerThreadId = ProviderThreadId.make("gateway-native-thread");
      const sessionId = "gateway-native-session";
      const active = yield* createRun(home, "gateway-active", "preparing", 2, {
        activeAttemptId: RunAttemptId.make("gateway-active-attempt"),
        providerThreadId,
        rootNodeId: null,
      });
      assert.equal(active.result.receipt.status, "accepted");
      const now = yield* DateTime.now;
      assert.equal(
        (yield* commit(
          "gateway-native",
          home.id,
          [
            {
              id: EventId.make("gateway-live-session"),
              type: "provider-session.attached",
              threadId: home.id,
              occurredAt: now,
              payload: {
                id: ProviderSessionId.make(sessionId),
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
              id: EventId.make("gateway-running"),
              type: "run.updated",
              threadId: home.id,
              runId: active.run.id,
              occurredAt: now,
              payload: { ...active.run, status: "running", startedAt: now },
            },
            {
              id: EventId.make("gateway-native-thread"),
              type: "provider-thread.updated",
              threadId: home.id,
              occurredAt: now,
              payload: {
                id: providerThreadId,
                driver: ProviderDriverKind.make("codex"),
                providerInstanceId: home.providerInstanceId,
                providerSessionId: ProviderSessionId.make(sessionId),
                appThreadId: home.id,
                ownerNodeId: null,
                nativeThreadRef: null,
                nativeConversationHeadRef: null,
                status: "active",
                firstRunOrdinal: 1,
                lastRunOrdinal: 2,
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
      const auth = yield* AuthSessions.AuthSessionRepository;
      const humanId = AuthSessionId.make("memory-read-session");
      yield* auth.create({
        sessionId: humanId,
        subject: "maintainer",
        scopes: [AuthOrchestrationReadScope],
        method: "browser-session-cookie",
        issuedAt: now,
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
      const gateway = yield* MemoryGateway.AssistantMemoryGateway;
      const scope = { environmentId, assistantId: binding.assistantId };
      const human = yield* gateway.read({ ...scope, operation: "context" }, humanId);
      assert.equal(human.operation, "context");
      if (human.operation === "context") assert.include(human.text, evidence.content);
      const source = {
        sourceId: captured.source.sourceId,
        sourceRevision: captured.source.sourceRevision,
        generation: captured.source.generation,
        contentHash: captured.source.contentHash,
      };
      assert.equal(
        (yield* Effect.result(gateway.write({ ...scope, operation: "forget", source }, humanId)))
          ._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(
          gateway.read(
            { ...scope, operation: "context" },
            AuthSessionId.make("forged-memory-session"),
          ),
        ))._tag,
        "Failure",
      );
      yield* auth.revoke({ sessionId: humanId, revokedAt: now });
      assert.equal(
        (yield* Effect.result(gateway.read({ ...scope, operation: "context" }, humanId)))._tag,
        "Failure",
      );
      const caller = { threadId: home.id, providerSessionId: sessionId };
      const native = yield* gateway.readNative({ ...scope, operation: "context" }, caller);
      assert.deepStrictEqual(native, human);
      assert.equal(
        (yield* Effect.result(
          gateway.readNative(
            { ...scope, operation: "context" },
            { ...caller, providerSessionId: "stale-native-session" },
          ),
        ))._tag,
        "Failure",
      );
      const sibling = yield* (yield* Repository.AssistantRepository).create({
        environmentId,
        commandId: CommandId.make("gateway-sibling"),
        configuration: { ...configuration, name: "Sibling" },
      });
      assert.equal(
        (yield* Effect.result(
          gateway.readNative(
            {
              environmentId,
              assistantId: sibling.detail.summary.assistantId,
              operation: "context",
            },
            caller,
          ),
        ))._tag,
        "Failure",
      );
      const childId = ThreadId.make("delegated-memory-caller");
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
          "gateway-delegated-child",
          childId,
          [
            {
              id: EventId.make("gateway-delegated-child"),
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
      assert.equal(
        (yield* Effect.result(
          gateway.readNative({ ...scope, operation: "context" }, { ...caller, threadId: childId }),
        ))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(
          gateway.writeNative(
            { ...scope, operation: "configure", expectedRevision: 0, configuration: {} },
            caller,
          ),
        ))._tag,
        "Failure",
      );
      const sourcesBeforeNativeEdit = yield* memory.list({
        environmentId,
        owner: captured.source.owner,
        ownerRevision: record.ownerRevision,
        limit: 32,
      });
      assert.equal(
        (yield* Effect.result(
          gateway.writeNative(
            {
              ...scope,
              operation: "edit",
              source,
              content: "The user now prefers invented private data.",
            },
            caller,
          ),
        ))._tag,
        "Failure",
      );
      assert.deepStrictEqual(
        yield* memory.list({
          environmentId,
          owner: captured.source.owner,
          ownerRevision: record.ownerRevision,
          limit: 32,
        }),
        sourcesBeforeNativeEdit,
      );
      yield* gateway.writeNative({ ...scope, operation: "forget", source }, caller);
      assert.equal((yield* memory.context(record)).text, "");
    }).pipe(Effect.provide(f.layer));
  },
);

it.live(
  "a fresh replacement handoff excludes forgotten USER spans and their old assistant echo while visible history remains",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { home, record } = yield* setup();
      const forgottenText = "I prefer the dark editor theme.";
      const echoText = "You prefer the dark editor theme.";
      const retainedText = "Please help prepare the release notes.";
      const first = yield* settle(home, "replacement-source", forgottenText);
      const sources = yield* Sources.AssistantSettledMemorySource;
      const evidence = yield* sources.forRun(home.id, first.run.id);
      if (evidence === null) return yield* Effect.die("Missing canonical source");
      const memory = yield* Memory.AssistantMemory;
      const captured = yield* memory.capture(evidence);
      yield* memory.process(captured.operationKey);
      const later = yield* settle(home, "replacement-unrelated", retainedText, { ordinal: 2 });
      const now = yield* DateTime.now;
      const base = {
        threadId: home.id,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status: "completed" as const,
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      };
      const items: ReadonlyArray<OrchestrationV2TurnItem> = [
        {
          ...base,
          id: TurnItemId.make("replacement-user-item"),
          runId: first.run.id,
          ordinal: 1,
          type: "user_message",
          messageId: first.run.userMessageId,
          createdBy: "user",
          creationSource: "web",
          inputIntent: "turn_start",
          text: forgottenText,
          attachments: [],
        },
        {
          ...base,
          id: TurnItemId.make("replacement-echo-item"),
          runId: first.run.id,
          ordinal: 2,
          type: "assistant_message",
          messageId: MessageId.make("replacement-echo"),
          text: echoText,
          streaming: false,
        },
        {
          ...base,
          id: TurnItemId.make("replacement-retained-item"),
          runId: later.run.id,
          ordinal: 3,
          type: "user_message",
          messageId: later.run.userMessageId,
          createdBy: "user",
          creationSource: "web",
          inputIntent: "turn_start",
          text: retainedText,
          attachments: [],
        },
      ];
      assert.equal(
        (yield* commit(
          "replacement-visible-history",
          home.id,
          [
            {
              id: EventId.make("replacement-echo-message"),
              type: "message.updated",
              threadId: home.id,
              runId: first.run.id,
              occurredAt: now,
              payload: {
                id: MessageId.make("replacement-echo"),
                threadId: home.id,
                runId: first.run.id,
                nodeId: null,
                createdBy: "agent",
                creationSource: "server",
                role: "assistant",
                text: echoText,
                attachments: [],
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
            },
            ...items.map((item): OrchestrationV2DomainEvent => ({
              id: EventId.make(`${item.id}:event`),
              type: "turn-item.updated",
              threadId: home.id,
              ...(item.runId === null ? {} : { runId: item.runId }),
              occurredAt: now,
              payload: item,
            })),
          ],
          "provider.event",
        )).receipt.status,
        "accepted",
      );
      yield* memory.forget(
        sourceTuple(
          { environmentId, owner: captured.source.owner, ownerRevision: record.ownerRevision },
          captured.source,
        ),
      );
      const snapshot = yield* (yield* Resources.AssistantResources).prepare(record, home.id);
      assert.notInclude(snapshot.roleInstructions!, forgottenText);
      const next = yield* createRun(home, "replacement-next", "preparing", 3);
      assert.equal(next.result.receipt.status, "accepted");
      const projections = yield* Projections.ProjectionStoreV2;
      const history = yield* projections.getTurnStartHistory(home.id);
      assert.equal(history.length, 3);
      const records = yield* projections.getThreadRecords(home.id, ["runs", "messages"]);
      const providerThread: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("replacement-native-thread"),
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: home.providerInstanceId,
        providerSessionId: null,
        appThreadId: home.id,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "fresh-after-forget",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 3,
        lastRunOrdinal: 3,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const fresh = yield* (yield* Handoffs.ContextHandoffServiceV2).prepareProviderHandoff({
        threadId: home.id,
        targetRunId: next.run.id,
        transferId: null,
        fromProviderThreadIds: [],
        toProviderThreadId: providerThread.id,
        fromProviderInstanceId: home.providerInstanceId,
        toProviderInstanceId: home.providerInstanceId,
        coveredRunOrdinals: { from: 1, to: 2 },
        strategy: "full_thread_summary",
        runs: records.runs,
        items: history.filter(
          (item) =>
            item.runId === null ||
            records.runs.some((run) => run.id === item.runId && run.ordinal < next.run.ordinal),
        ),
        createdAt: now,
      });
      assert.equal(fresh.memoryEpoch, snapshot.memoryEpoch);
      assert.equal(fresh.memoryContextHash, snapshot.memoryContextHash);
      const selected = selectHandoffsForMemoryEpoch(
        [fresh],
        snapshot.memoryEpoch,
        snapshot.memoryContextHash,
      );
      assert.equal(selected.length, 1);
      const nativePayloads: string[] = [];
      const sink = yield* EventSink.EventSinkV2;
      const delivery = yield* deliverContextHandoffs({
        handoffs: selected,
        providerThread,
        budget: 12000,
        alreadyDeliveredItemIds: new Set<string>(),
        inject: (payload) =>
          Effect.sync(() => {
            nativePayloads.push(
              [payload.context, ...payload.messages.map((item) => item.text)].join("\n"),
            );
            return true;
          }),
        persist: (handoff) =>
          sink
            .write({
              events: [
                {
                  id: EventId.make(`replacement-delivery:${handoff.delivery?.status}`),
                  type: "context-handoff.updated",
                  threadId: home.id,
                  runId: next.run.id,
                  occurredAt: now,
                  payload: handoff,
                },
              ],
            })
            .pipe(Effect.asVoid),
      });
      yield* delivery.delivered;
      assert.equal(nativePayloads.length, 1);
      assert.include(nativePayloads[0]!, retainedText);
      assert.notInclude(nativePayloads[0]!, forgottenText);
      assert.notInclude(nativePayloads[0]!, echoText);
      const visible = yield* projections.getThreadRecords(home.id, ["messages"]);
      assert.isTrue(visible.messages.some((message) => message.text === forgottenText));
      assert.isTrue(visible.messages.some((message) => message.text === echoText));
    }).pipe(Effect.provide(f.layer));
  },
);

it.live.each(["forget", "edit"] as const)(
  "an assistant-only %s wake drains shared indexed-source cleanup without Work activity or restart",
  (operation) => {
    const f = fixture();
    return Effect.gen(function* () {
      const { home, record, binding, workspaceRoot } = yield* setup();
      const { run } = yield* settle(
        home,
        "assistant-cleanup-source",
        "I prefer the dark editor theme.",
      );
      const evidence = yield* (yield* Sources.AssistantSettledMemorySource).forRun(home.id, run.id);
      if (evidence === null) return yield* Effect.die("Missing canonical source");
      const memory = yield* Memory.AssistantMemory;
      const captured = yield* memory.capture(evidence);
      yield* memory.process(captured.operationKey);
      const processing = yield* Processing.ProjectMemoryProcessing;
      yield* processing.index(captured.operationKey, {
        environmentId,
        owner: captured.source.owner,
        enabled: true,
        embeddingEnabled: true,
        command: "/assistant-memory-companion-fixture",
        args: [],
        cwd: workspaceRoot,
      });
      assert.equal(
        f.companionRequests.filter((request) => request.operation === "index").length,
        1,
      );
      const now = yield* DateTime.now;
      const sessionId = AuthSessionId.make("assistant-cleanup-human");
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
      yield* Effect.gen(function* () {
        const events = yield* EventSink.EventSinkV2;
        const sequence = yield* events.latestSequence();
        const selector = {
          sourceId: captured.source.sourceId,
          sourceRevision: captured.source.sourceRevision,
          generation: captured.source.generation,
          contentHash: captured.source.contentHash,
        };
        yield* (yield* MemoryGateway.AssistantMemoryGateway).write(
          operation === "edit"
            ? {
                environmentId,
                assistantId: binding.assistantId,
                operation: "edit",
                source: selector,
                content: "I prefer the light editor theme.",
              }
            : {
                environmentId,
                assistantId: binding.assistantId,
                operation: "forget",
                source: selector,
              },
          sessionId,
        );
        yield* Deferred.await(f.cleanupStarted);
        const sql = yield* SqlClient.SqlClient;
        assert.equal(
          (yield* sql<{ status: string }>`SELECT status FROM t3_workflow_v2_memory_cleanup`)[0]!
            .status,
          "uncertain",
        );
        yield* Deferred.succeed(f.releaseCleanup, undefined);
        assert.deepStrictEqual(yield* processing.cleanup(), []);
        assert.equal(
          (yield* sql<{ status: string }>`SELECT status FROM t3_workflow_v2_memory_cleanup`)[0]!
            .status,
          "completed",
        );
        assert.equal(
          (yield* sql<{
            status: string;
          }>`SELECT status FROM t3_workflow_v2_memory_processing WHERE operation_key=${captured.operationKey}`)[0]!
            .status,
          "stale",
        );
        assert.equal(
          f.companionRequests.filter((request) => request.operation === "cleanup").length,
          1,
        );
        assert.equal(yield* events.latestSequence(), sequence);
        const context = yield* memory.context(record);
        if (operation === "edit") assert.include(context.text, "light editor");
        else assert.equal(context.text, "");
      }).pipe(Effect.provide(MemoryRuntime.workerLayer));
    }).pipe(Effect.provide(f.layer));
  },
);

it.live(
  "same-epoch source authority drift omits provider output from an old admitted context while retaining USER intent",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { home, record } = yield* setup();
      const original = yield* settle(home, "same-epoch-source", "I prefer the dark editor theme.");
      const evidence = yield* (yield* Sources.AssistantSettledMemorySource).forRun(
        home.id,
        original.run.id,
      );
      if (evidence === null) return yield* Effect.die("Missing canonical source");
      const memory = yield* Memory.AssistantMemory;
      const captured = yield* memory.capture(evidence);
      yield* memory.process(captured.operationKey);
      const resources = yield* Resources.AssistantResources;
      const before = yield* resources.prepare(record, home.id);
      assert.include(before.roleInstructions!, "dark editor");
      const derived = yield* createRun(home, "same-epoch-derived", "preparing", 2);
      assert.equal(derived.result.receipt.status, "accepted");
      const intent = "Please summarize the changelog.";
      const echo = "You prefer the dark editor theme.";
      const now = yield* DateTime.now;
      const base = {
        threadId: home.id,
        runId: derived.run.id,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status: "completed" as const,
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      };
      const items: ReadonlyArray<OrchestrationV2TurnItem> = [
        {
          ...base,
          id: TurnItemId.make("same-epoch-intent"),
          ordinal: 1,
          type: "user_message",
          messageId: derived.run.userMessageId,
          createdBy: "user",
          creationSource: "web",
          inputIntent: "turn_start",
          text: intent,
          attachments: [],
        },
        {
          ...base,
          id: TurnItemId.make("same-epoch-derived-echo"),
          ordinal: 2,
          type: "assistant_message",
          messageId: MessageId.make("same-epoch-derived-echo"),
          text: echo,
          streaming: false,
        },
      ];
      assert.equal(
        (yield* commit(
          "same-epoch-derived-observation",
          home.id,
          [
            {
              id: EventId.make("same-epoch-intent-message"),
              type: "message.updated",
              threadId: home.id,
              runId: derived.run.id,
              occurredAt: now,
              payload: {
                id: derived.run.userMessageId,
                threadId: home.id,
                runId: derived.run.id,
                nodeId: null,
                createdBy: "user",
                creationSource: "web",
                role: "user",
                text: intent,
                attachments: [],
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
            },
            {
              id: EventId.make("same-epoch-echo-message"),
              type: "message.updated",
              threadId: home.id,
              runId: derived.run.id,
              occurredAt: now,
              payload: {
                id: MessageId.make("same-epoch-derived-echo"),
                threadId: home.id,
                runId: derived.run.id,
                nodeId: null,
                createdBy: "agent",
                creationSource: "server",
                role: "assistant",
                text: echo,
                attachments: [],
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
            },
            ...items.map((item): OrchestrationV2DomainEvent => ({
              id: EventId.make(`${item.id}:event`),
              type: "turn-item.updated",
              threadId: home.id,
              runId: derived.run.id,
              occurredAt: now,
              payload: item,
            })),
            {
              id: EventId.make("same-epoch-derived-completed"),
              type: "run.updated",
              threadId: home.id,
              runId: derived.run.id,
              occurredAt: now,
              payload: { ...derived.run, status: "completed", startedAt: now, completedAt: now },
            },
          ],
          "provider.event",
        )).receipt.status,
        "accepted",
      );
      const sql = yield* SqlClient.SqlClient;
      const admitted = yield* sql<{
        configuration_json: string;
      }>`SELECT configuration_json FROM t3_workflow_v2_assistant_admissions WHERE run_id=${derived.run.id}`;
      assert.equal(
        (yield* decodeRetainedInstruction(admitted[0]!.configuration_json)).snapshot
          .memoryContextHash,
        before.memoryContextHash,
      );
      yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.activeAttemptId','same-epoch-replacement-attempt') WHERE run_id=${original.run.id}`;
      const after = yield* resources.prepare(record, home.id);
      assert.equal(after.memoryEpoch, before.memoryEpoch);
      assert.notEqual(after.memoryContextHash, before.memoryContextHash);
      assert.notInclude(after.roleInstructions!, "dark editor");
      assert.equal(
        (yield* sql<{
          status: string;
        }>`SELECT status FROM t3_workflow_v2_memory_sources WHERE source_id=${captured.source.sourceId}`)[0]!
          .status,
        "current",
      );
      assert.equal((yield* sql`SELECT 1 FROM t3_workflow_v2_memory_forgotten`).length, 0);
      assert.equal(
        (yield* sql`SELECT 1 FROM t3_workflow_v2_memory_grants WHERE revoked_at IS NOT NULL`)
          .length,
        0,
      );
      const next = yield* createRun(home, "same-epoch-next", "preparing", 3);
      assert.equal(next.result.receipt.status, "accepted");
      const projections = yield* Projections.ProjectionStoreV2;
      const records = yield* projections.getThreadRecords(home.id, ["runs"]);
      const history = yield* projections.getTurnStartHistory(home.id);
      const providerThread: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("same-epoch-native"),
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: home.providerInstanceId,
        providerSessionId: null,
        appThreadId: home.id,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "same-epoch-fresh",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 3,
        lastRunOrdinal: 3,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const fresh = yield* (yield* Handoffs.ContextHandoffServiceV2).prepareProviderHandoff({
        threadId: home.id,
        targetRunId: next.run.id,
        transferId: null,
        fromProviderThreadIds: [],
        toProviderThreadId: providerThread.id,
        fromProviderInstanceId: home.providerInstanceId,
        toProviderInstanceId: home.providerInstanceId,
        coveredRunOrdinals: { from: 1, to: 2 },
        strategy: "full_thread_summary",
        runs: records.runs,
        items: history,
        createdAt: now,
      });
      assert.equal(fresh.memoryEpoch, after.memoryEpoch);
      assert.equal(fresh.memoryContextHash, after.memoryContextHash);
      const payloads: string[] = [];
      const sink = yield* EventSink.EventSinkV2;
      const delivery = yield* deliverContextHandoffs({
        handoffs: selectHandoffsForMemoryEpoch([fresh], after.memoryEpoch, after.memoryContextHash),
        providerThread,
        budget: 12000,
        alreadyDeliveredItemIds: new Set<string>(),
        inject: (payload) =>
          Effect.sync(() => {
            payloads.push(
              [payload.context, ...payload.messages.map((item) => item.text)].join("\n"),
            );
            return true;
          }),
        persist: (handoff) =>
          sink
            .write({
              events: [
                {
                  id: EventId.make(`same-epoch-delivery:${handoff.delivery?.status}`),
                  type: "context-handoff.updated",
                  threadId: home.id,
                  runId: next.run.id,
                  occurredAt: now,
                  payload: handoff,
                },
              ],
            })
            .pipe(Effect.asVoid),
      });
      yield* delivery.delivered;
      assert.equal(payloads.length, 1);
      assert.include(payloads[0]!, intent);
      assert.notInclude(payloads[0]!, echo);
      const visible = yield* projections.getThreadRecords(home.id, ["messages"]);
      assert.isTrue(visible.messages.some((message) => message.text === echo));
    }).pipe(Effect.provide(f.layer));
  },
);

it.live.each([
  { budget: 1400, count: 1 },
  { budget: 1800, count: 1 },
  { budget: 1800, count: 3 },
] as const)(
  "protected history delivery preserves its prohibition at $budget tokens across $count handoffs",
  ({ budget, count }) => {
    const f = fixture();
    return Effect.gen(function* () {
      const { home, record } = yield* setup();
      const forgotten = "I prefer the dark editor theme.";
      const { run } = yield* settle(home, "budget-protected-source", forgotten);
      const evidence = yield* (yield* Sources.AssistantSettledMemorySource).forRun(home.id, run.id);
      if (evidence === null) return yield* Effect.die("Missing canonical source");
      const memory = yield* Memory.AssistantMemory;
      const captured = yield* memory.capture(evidence);
      yield* memory.process(captured.operationKey);
      const now = yield* DateTime.now;
      const item: OrchestrationV2TurnItem = {
        id: TurnItemId.make("protected-budget-source-item"),
        threadId: home.id,
        runId: run.id,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "user_message",
        messageId: run.userMessageId,
        createdBy: "user",
        creationSource: "web",
        inputIntent: "turn_start",
        text: forgotten,
        attachments: [],
      };
      yield* memory.forget(
        sourceTuple(
          { environmentId, owner: captured.source.owner, ownerRevision: record.ownerRevision },
          captured.source,
        ),
      );
      const providerThread: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("protected-budget-native"),
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: home.providerInstanceId,
        providerSessionId: null,
        appThreadId: home.id,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "protected-budget-native",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const service = yield* Handoffs.ContextHandoffServiceV2;
      const fresh = yield* service.prepareProviderHandoff({
        threadId: home.id,
        targetRunId: run.id,
        transferId: null,
        fromProviderThreadIds: [],
        toProviderThreadId: providerThread.id,
        fromProviderInstanceId: home.providerInstanceId,
        toProviderInstanceId: home.providerInstanceId,
        coveredRunOrdinals: { from: 1, to: 1 },
        strategy: "full_thread_summary",
        runs: [run],
        items: [item],
        createdAt: now,
      });
      assert.equal(fresh.protectedHistoryOmissions, true);
      const manual = yield* service.prepare({
        threadId: home.id,
        targetRunId: run.id,
        fromProviderThreadIds: [],
        toProviderThreadId: providerThread.id,
      });
      const pending =
        count === 1
          ? [fresh]
          : [
              fresh,
              { ...fresh, id: ContextHandoffId.make("protected-budget-second") },
              {
                ...manual,
                summaryText: "Opaque cached summary: Recover history with t3_thread_read.",
              },
            ];
      const payloads: string[] = [];
      const sink = yield* EventSink.EventSinkV2;
      const delivery = yield* deliverContextHandoffs({
        handoffs: pending,
        providerThread,
        budget,
        alreadyDeliveredItemIds: new Set<string>(),
        inject: (payload) =>
          Effect.sync(() => {
            payloads.push(
              [payload.context, ...payload.messages.map((message) => message.text)].join("\n"),
            );
            return true;
          }),
        persist: (handoff) =>
          sink
            .write({
              events: [
                {
                  id: EventId.make(`protected-budget:${handoff.id}:${handoff.delivery?.status}`),
                  type: "context-handoff.updated",
                  threadId: home.id,
                  runId: run.id,
                  occurredAt: now,
                  payload: handoff,
                },
              ],
            })
            .pipe(Effect.asVoid),
      });
      yield* delivery.delivered;
      assert.equal(payloads.length, 1);
      assert.include(payloads[0]!, "omitted");
      assert.include(payloads[0]!, "Do not restore excluded personal information");
      assert.notInclude(payloads[0]!, "t3_thread_read");
      assert.notInclude(payloads[0]!, "Recover history");
      assert.notInclude(payloads[0]!, "Opaque cached summary");
      assert.notInclude(payloads[0]!, forgotten);
    }).pipe(Effect.provide(f.layer));
  },
);
