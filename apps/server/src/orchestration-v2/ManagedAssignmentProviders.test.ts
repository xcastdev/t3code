import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2InstructionSnapshot,
  type OrchestrationV2Command,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as InstructionDelivery from "./InstructionDelivery.ts";
import { SkillCatalogService } from "../skills/SkillCatalogService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import { seedOwnedThreadWork } from "./testkit/OwnedRunTestkit.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { runOrchestratorV2Scenario } from "./testkit/OrchestratorScenario.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

const providers = [
  "codex",
  "claudeAgent",
  "opencode",
  "opencode2",
  "pi",
  "cursor",
  "grok",
  "muse",
  "acp",
  "antigravity",
] as const;

const fallbackCapabilities: OrchestrationV2ProviderCapabilities = {
  ...CodexProviderCapabilitiesV2,
  instructionDelivery: { mode: "unsupported", supportsSessionReplacement: false },
  tools: {
    ...CodexProviderCapabilitiesV2.tools,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  context: {
    ...CodexProviderCapabilitiesV2.context,
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
  },
};

function makeFallbackAdapter(
  driverName: string,
  captured: Ref.Ref<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>,
  options?: {
    readonly capabilities: OrchestrationV2ProviderCapabilities;
    readonly acknowledge: boolean;
    readonly getterReads: Ref.Ref<number>;
  },
) {
  const driver = ProviderDriverKind.make(driverName);
  const instanceId = ProviderInstanceId.make(driverName);
  const unused = () => Effect.die("Unexpected native operation in fallback chat");
  const capabilities = options?.capabilities ?? fallbackCapabilities;
  return ProviderAdapter.ProviderAdapterV2.of({
    driver,
    instanceId,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        return {
          driver,
          instanceId,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: input.runtimePolicy.cwd ?? process.cwd(),
            model: input.modelSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromPubSub(events),
          ...(options === undefined
            ? {}
            : {
                getAppliedInstructions: () =>
                  Ref.update(options.getterReads, (count) => count + 1).pipe(
                    Effect.as(input.instructionSnapshot),
                  ),
              }),
          ensureThread: (threadInput) =>
            Effect.succeed({
              id: ProviderThreadId.make(`native:${threadInput.threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadInput.threadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver,
                nativeId: `native:${threadInput.threadId}`,
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              yield* Ref.update(captured, (turns) => [...turns, turn]);
              if (
                options?.acknowledge &&
                turn.instructionSnapshot !== undefined &&
                turn.onInstructionsApplied !== undefined
              ) {
                yield* turn.onInstructionsApplied(turn.instructionSnapshot);
              }
              const completedAt = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(`turn:${turn.runId}`);
              yield* PubSub.publish(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: { driver, nativeId: `turn:${turn.runId}`, strength: "strong" },
                  ordinal: turn.runOrdinal,
                  status: "completed",
                  startedAt: completedAt,
                  completedAt,
                },
              });
              yield* PubSub.publish(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: turn.providerThread.id,
                providerTurnId,
                runOrdinal: turn.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          steerTurn: unused,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: unused,
          readThreadSnapshot: unused,
          rollbackThread: unused,
          forkThread: unused,
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  });
}

it.effect.each(providers)(
  "%s keeps ordinary chat working without instruction, context, tool bridge, or usage support",
  (provider) =>
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(`managed-fallback-${provider}`);
      const captured = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>(
        [],
      );
      const adapter = makeFallbackAdapter(provider, captured);
      const instanceId = ProviderInstanceId.make(provider);
      const modelSelection = { instanceId, model: "test-model" };
      const threadId = ThreadId.make(`fallback:${provider}`);
      const commands: ReadonlyArray<OrchestrationV2Command> = [
        {
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project"),
          createdBy: "user",
          creationSource: "web",
          title: "Ordinary chat",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        },
        ...[1, 2].map((ordinal): OrchestrationV2Command => ({
          type: "message.dispatch",
          commandId: CommandId.make(`send:${ordinal}`),
          threadId,
          messageId: MessageId.make(`message:${ordinal}`),
          createdBy: "user",
          creationSource: "web",
          text: `ordinary ${ordinal}`,
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        })),
      ];
      const result = yield* runOrchestratorV2Scenario({
        name: `fallback-${provider}`,
        commands,
        steps: commands.flatMap((command) => [
          { type: "dispatch" as const, command },
          ...(command.type === "message.dispatch"
            ? [{ type: "await_thread_idle" as const, threadId }]
            : []),
        ]),
      }).pipe(
        Effect.provide(
          layerWithRegistry(
            {
              name: `fallback-${provider}`,
              runtimePolicyOverride: {
                cwd,
                approvalPolicy: "never",
                sandboxPolicy: { type: "readOnly" },
              },
            },
            ProviderAdapterRegistry.layerSingle(adapter),
          ),
        ),
      );
      const projection = result.projections.get(threadId)!;
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["completed", "completed"],
      );
      assert.deepEqual(
        (yield* Ref.get(captured)).map((turn) => turn.message.text),
        ["ordinary 1", "ordinary 2"],
      );
      assert.isTrue(
        (yield* Ref.get(captured)).every((turn) => turn.instructionSnapshot === undefined),
      );
      assert.isTrue(projection.runs.every((run) => run.effectiveInstructions === undefined));
      assert.isTrue(
        projection.providerSessions.every((session) => session.effectiveInstructions === undefined),
      );
      assert.isTrue(projection.providerThreads.every((thread) => thread.contextUsage == null));
    }).pipe(Effect.scoped),
);

const revisionA: OrchestrationV2InstructionSnapshot = {
  configurationHash: "config-a",
  resourceRevision: "resources-a",
  memoryEpoch: 0,
  roleInstructions: "Read only the assigned project",
  toolIds: ["read"],
  skillIds: ["research"],
};
const revisionB: OrchestrationV2InstructionSnapshot = {
  ...revisionA,
  configurationHash: "config-b",
  resourceRevision: "resources-b",
  roleInstructions: "Read the changed assignment",
};

it.effect.each([false, true])(
  "keeps exact historical receipts without changing a successor runtime=%s",
  (replaceRuntime) =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>(
        [],
      );
      const adapter = makeFallbackAdapter("test-receipts", captured);
      const cwd = yield* checkpointWorkspace("instruction-receipts");
      const database = SqlitePersistence.layerMemory;
      const notifications = yield* Ref.make(0);
      const catalog = Layer.mock(SkillCatalogService, {
        notifyApplicationChanged: () => Ref.update(notifications, (count) => count + 1),
      });
      const services = layerWithRegistry(
        {
          name: "instruction-receipts",
          runtimePolicyOverride: {
            cwd,
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly" },
          },
        },
        ProviderAdapterRegistry.layerSingle(adapter),
        { databaseLayer: database },
      ).pipe(Layer.provideMerge(catalog));
      const deliveryLayer = InstructionDelivery.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            services,
            database,
            IdAllocator.layer,
            ProjectionStore.layer.pipe(Layer.provide(database)),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const threadId = ThreadId.make("receipt-thread");
        const modelSelection = { instanceId: adapter.instanceId, model: "test-model" };
        const commands: ReadonlyArray<OrchestrationV2Command> = [
          {
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make("receipt-project"),
            createdBy: "user",
            creationSource: "web",
            title: "Receipt history",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          },
          ...[1, 2].map((ordinal): OrchestrationV2Command => ({
            type: "message.dispatch",
            commandId: CommandId.make(`send:${ordinal}`),
            threadId,
            messageId: MessageId.make(`message:${ordinal}`),
            createdBy: "user",
            creationSource: "web",
            text: `ordinary ${ordinal}`,
            attachments: [],
            modelSelection,
            dispatchMode: { type: "start_immediately" },
          })),
        ];
        yield* runOrchestratorV2Scenario({
          name: "receipt-history",
          commands,
          steps: commands.flatMap((command) => [
            { type: "dispatch" as const, command },
            ...(command.type === "message.dispatch"
              ? [{ type: "await_thread_idle" as const, threadId }]
              : []),
          ]),
        });
        const [first, second] = yield* Ref.get(captured);
        assert.isDefined(first);
        assert.isDefined(second);
        const delivery = yield* InstructionDelivery.InstructionDelivery;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sessionBefore = (yield* store.getThreadRecords(threadId, ["providerSessions"]))
          .providerSessions[0]!;
        const target = (
          turn: ProviderAdapter.ProviderAdapterV2TurnInput,
          snapshot: OrchestrationV2InstructionSnapshot,
        ): InstructionDelivery.InstructionTarget => ({
          threadId,
          runId: turn.runId,
          runAttemptId: turn.attemptId,
          providerThreadId: turn.providerThread.id,
          providerSessionId: turn.providerThread.providerSessionId!,
          runOrdinal: turn.runOrdinal,
          ...(sessionBefore.instructionRuntimeId === undefined
            ? {}
            : { runtimeId: sessionBefore.instructionRuntimeId }),
          snapshot,
        });
        const old = target(first!, revisionA);
        const current = target(second!, revisionB);
        yield* delivery.prepare(old);
        yield* delivery.prepare(current);
        assert.deepEqual(yield* delivery.query({ runAttemptId: old.runAttemptId }), {
          state: "pending",
          requested: revisionA,
          applied: undefined,
        });
        for (const mismatch of [
          { ...revisionA, configurationHash: "wrong" },
          { ...revisionA, resourceRevision: "wrong" },
          { ...revisionA, memoryEpoch: 1 },
          { ...revisionA, roleInstructions: "wrong" },
          { ...revisionA, toolIds: ["write"] },
          { ...revisionA, skillIds: [] },
        ])
          yield* delivery.recordApplied(old, mismatch);
        assert.equal((yield* delivery.query({ runAttemptId: old.runAttemptId }))?.state, "pending");
        assert.equal(yield* Ref.get(notifications), 2);
        if (replaceRuntime) {
          const occurredAt = yield* DateTime.now;
          yield* (yield* EventSink.EventSinkV2).write({
            advanceProviderSessionRuntime: current.providerSessionId,
            events: [
              {
                id: EventId.make("replacement-runtime"),
                type: "provider-session.attached",
                threadId,
                occurredAt,
                payload: {
                  ...sessionBefore,
                  instructionRuntimeId: "successor-runtime",
                  effectiveInstructions: {
                    configurationHash: "config-successor",
                    resourceRevision: "resources-successor",
                    memoryEpoch: 0,
                  },
                },
              },
            ],
          });
        }
        yield* delivery.recordApplied(current, revisionB);
        assert.deepEqual(yield* delivery.query({ runAttemptId: current.runAttemptId }), {
          state: "applied",
          requested: revisionB,
          applied: revisionB,
        });
        yield* delivery.recordApplied(
          { ...old, providerSessionId: ProviderSessionId.make("wrong-session") },
          revisionA,
        );
        assert.equal((yield* delivery.query({ runAttemptId: old.runAttemptId }))?.state, "pending");
        assert.equal(yield* Ref.get(notifications), 3);
        yield* delivery.recordApplied(old, revisionA);
        assert.equal(yield* Ref.get(notifications), 4);
        assert.deepEqual(yield* delivery.query({ runAttemptId: old.runAttemptId }), {
          state: "applied",
          requested: revisionA,
          applied: revisionA,
        });
        const projection = yield* store.getThreadRecords(threadId, ["runs", "providerSessions"]);
        assert.deepEqual(
          projection.runs.map((run) => run.effectiveInstructions),
          [
            { configurationHash: "config-a", resourceRevision: "resources-a", memoryEpoch: 0 },
            { configurationHash: "config-b", resourceRevision: "resources-b", memoryEpoch: 0 },
          ],
        );
        assert.deepEqual(projection.providerSessions.at(-1)?.effectiveInstructions, {
          configurationHash: replaceRuntime ? "config-successor" : "config-b",
          resourceRevision: replaceRuntime ? "resources-successor" : "resources-b",
          memoryEpoch: 0,
        });
      }).pipe(Effect.provide(deliveryLayer));
    }).pipe(Effect.scoped),
);

it.each([
  ["session", true, false, "replace"],
  ["session", false, false, "blocked"],
  ["session", true, true, "blocked"],
  ["turn", false, false, "per-turn"],
  ["turn", false, true, "per-turn"],
  ["unsupported", false, false, "blocked"],
] as const)(
  "%s delivery with replacement=%s shared=%s handles a changed assignment as %s",
  (mode, supportsSessionReplacement, sessionHasOtherThreads, expected) => {
    const capabilities = {
      ...fallbackCapabilities,
      instructionDelivery: { mode, supportsSessionReplacement },
    };
    for (const requestedSnapshot of [revisionB, undefined]) {
      assert.equal(
        InstructionDelivery.instructionDeliveryDecision({
          capabilities,
          previousSnapshot: revisionA,
          requestedSnapshot,
          sessionHasOtherThreads,
        }),
        expected,
      );
    }
  },
);

it("requires replacement even when only resource selection or epoch changes on a session", () => {
  for (const requestedSnapshot of [
    { ...revisionA, toolIds: ["write"] },
    { ...revisionA, skillIds: [] },
    { ...revisionA, memoryEpoch: 1 },
    { ...revisionA, resourceRevision: "new-resources" },
    { ...revisionA, roleInstructions: "Changed role with the same configuration hash" },
  ]) {
    assert.equal(
      InstructionDelivery.instructionDeliveryDecision({
        capabilities: CodexProviderCapabilitiesV2,
        previousSnapshot: revisionA,
        requestedSnapshot,
        sessionHasOtherThreads: false,
      }),
      "replace",
    );
  }
});

it.effect.each([true, false])(
  "managed core start records actual callback=%s and ignores a cached getter for native slash",
  (acknowledge) =>
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(`managed-native-${acknowledge}`);
      const captured = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>(
        [],
      );
      const getterReads = yield* Ref.make(0);
      const adapter = makeFallbackAdapter("managed-native", captured, {
        capabilities: {
          ...fallbackCapabilities,
          instructionDelivery: { mode: "turn", supportsSessionReplacement: false },
        },
        acknowledge,
        getterReads,
      });
      const database = SqlitePersistence.layerMemory;
      const services = layerWithRegistry(
        {
          name: `managed-native-${acknowledge}`,
          runtimePolicyOverride: {
            cwd,
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly" },
          },
        },
        ProviderAdapterRegistry.layerSingle(adapter),
        { databaseLayer: database },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const projects = yield* ProjectStore.ProjectStoreV2;
        const delivery = yield* InstructionDelivery.InstructionDelivery;
        const threadId = ThreadId.make(`managed-native:${acknowledge}`);
        const projectId = ProjectId.make(`managed-native-project:${acknowledge}`);
        const modelSelection = { instanceId: adapter.instanceId, model: "test-model" };
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* projects.apply({
          sequence: 0,
          eventId: EventId.make("seed-project"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Managed",
            workspaceRoot: cwd,
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId,
          createdBy: "user",
          creationSource: "web",
          title: "Managed",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        yield* seedOwnedThreadWork({ projectId, threadId, modelSelection, now });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:prepared`),
          threadId,
          messageId: MessageId.make(`${threadId}:prepared`),
          createdBy: "user",
          creationSource: "web",
          text: acknowledge ? "Read the assigned project" : "/status",
          attachments: [],
          dispatchMode: { type: "defer_start" },
        });
        const prepared = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        yield* orchestrator.dispatch({
          type: "prepared-run.release",
          commandId: CommandId.make(`${threadId}:release`),
          threadId,
          runId: prepared.id,
        });
        yield* worker.drain();
        const turns = yield* Ref.get(captured);
        assert.lengthOf(turns, 1);
        const turn = turns[0]!;
        assert.equal(turn.instructionSnapshot?.roleInstructions, "Read the code");
        assert.deepEqual(turn.instructionSnapshot?.toolIds, ["read"]);
        const receipt = yield* delivery.query({ runAttemptId: turn.attemptId });
        assert.equal(receipt?.state, acknowledge ? "applied" : "pending");
        assert.equal(yield* Ref.get(getterReads), 0);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const run = projection.runs[0]!;
        if (acknowledge) {
          assert.deepEqual(run.effectiveInstructions, {
            configurationHash: turn.instructionSnapshot!.configurationHash,
            resourceRevision: turn.instructionSnapshot!.resourceRevision,
            memoryEpoch: 0,
          });
        } else {
          assert.isUndefined(run.effectiveInstructions);
          assert.isUndefined(projection.providerSessions[0]?.effectiveInstructions);
        }
      }).pipe(
        Effect.provide(
          InstructionDelivery.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                services,
                database,
                IdAllocator.layer,
                ProjectionStore.layer.pipe(Layer.provide(database)),
                ProjectStore.layer.pipe(Layer.provide(database)),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped),
);
