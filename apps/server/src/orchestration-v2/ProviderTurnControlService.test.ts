import { assert, it, vi } from "@effect/vitest";
import {
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunAdmission from "./RunAdmission.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function makeProjection(input: {
  readonly now: DateTime.Utc;
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  readonly attemptId: RunAttemptId;
}): OrchestrationV2ThreadProjection {
  const runId = RunId.make("run:restart-session");
  const nodeId = NodeId.make("node:restart-session");
  return {
    thread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make("project:restart-session"),
      title: "Restart session",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/workspace",
      activeProviderThreadId: input.providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [
      {
        id: input.attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId: input.providerThread.id,
        providerTurnId: input.providerTurnId,
        reason: "initial",
        status: "superseded",
        startedAt: input.now,
        completedAt: input.now,
      },
    ],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [input.providerThread],
    providerTurns: [
      {
        id: input.providerTurnId,
        providerThreadId: input.providerThread.id,
        nodeId,
        runAttemptId: input.attemptId,
        nativeTurnRef: {
          driver,
          nativeId: "native-turn:restart-session",
          strength: "strong",
        },
        ordinal: 1,
        status: "running",
        startedAt: input.now,
        completedAt: null,
      },
    ],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: input.now,
  };
}

it.effect(
  "interrupts the historical session only for the exact committed restart replacement",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-session");
      const oldSessionId = ProviderSessionId.make("provider-session:restart-session:old");
      const replacementSessionId = ProviderSessionId.make(
        "provider-session:restart-session:replacement",
      );
      const unrelatedSessionId = ProviderSessionId.make(
        "provider-session:restart-session:unrelated",
      );
      const providerThreadId = ProviderThreadId.make("provider-thread:restart-session");
      const providerTurnId = ProviderTurnId.make("provider-turn:restart-session");
      const attemptId = RunAttemptId.make("run-attempt:restart-session");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: replacementSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver,
          nativeId: "native-thread:restart-session",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const projection = yield* Ref.make(
        makeProjection({ now, threadId, providerThread, providerTurnId, attemptId }),
      );
      const interruptedThread = yield* Ref.make<OrchestrationV2ProviderThread | null>(null);
      const providerSession = {
        id: oldSessionId,
        driver,
        providerInstanceId,
        status: "running" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: providerInstanceId,
        driver,
        providerSessionId: oldSessionId,
        providerSession,
        events: Stream.empty,
        ensureThread: () => Effect.die("unused ensureThread"),
        resumeThread: () => Effect.die("unused resumeThread"),
        startTurn: () => Effect.die("unused startTurn"),
        steerTurn: () => Effect.die("unused steerTurn"),
        interruptTurn: ({ providerThread: target }) =>
          Effect.all(
            [
              Ref.set(interruptedThread, target),
              Ref.update(projection, (current) => ({
                ...current,
                providerTurns: current.providerTurns.map((turn) =>
                  turn.id === providerTurnId
                    ? { ...turn, status: "interrupted" as const, completedAt: now }
                    : turn,
                ),
              })),
            ],
            { discard: true },
          ),
        respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
        readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
        rollbackThread: () => Effect.die("unused rollbackThread"),
        forkThread: () => Effect.die("unused forkThread"),
      };
      const layerProjection = Layer.succeed(
        ProjectionStore.ProjectionStoreV2,
        ProjectionStore.ProjectionStoreV2.of({
          apply: () => Effect.void,
          getLimitRecoveryCandidates: () => Effect.die("unused getLimitRecoveryCandidates"),
          getShellSnapshot: () => Effect.die("unused getShellSnapshot"),
          readShellSnapshot: () => Effect.die("unused readShellSnapshot"),
          getThreadShell: () => Effect.die("unused getThreadShell"),
          getThread: () => Ref.get(projection).pipe(Effect.map((state) => state.thread)),
          getSettlementCandidates: () => Effect.die("unused getSettlementCandidates"),
          getThreadsWithPullRequests: () => Effect.die("unused getThreadsWithPullRequests"),
          getThreadWorktreePaths: () => Effect.die("unused getThreadWorktreePaths"),
          getThreadProjection: () => Effect.die("control effects must not load transcript"),
          getTurnStartContext: () => Effect.die("unused"),
          getTurnStartHistory: () => Effect.die("unused"),
          getRuntimeRecoveryProjection: () => Effect.die("unused getRuntimeRecoveryProjection"),
          getPlan: () => Effect.die("unused"),
          hasUnpairedRunInterruptRequest: () => Effect.die("unused interrupt read"),
          getThreadAttachmentIds: () => Effect.die("Unused attachment lookup"),
          searchThread: () => Effect.die("unused"),
          searchThreadStream: () => Stream.empty,
          getThreadHistoryPage: () => Effect.die("unused"),
          getTimelinePage: () => Effect.die("Unused timeline read"),
          getMessageCount: () => Effect.die("unused message count"),
          getNextTurnItemOrdinal: () => Effect.die("unused ordinal read"),
          getTurnItem: () => Effect.die("unused turn item read"),
          getThreadRecords: () => Effect.die("unused record read"),
          getRuntimeRequest: () => Effect.die("unused getRuntimeRequest"),
          getRunningTurnContext: () => Effect.die("unused getRunningTurnContext"),
          getThreadProviderContext: () => Effect.die("unused getThreadProviderContext"),
          getRuntimeResponseContext: () => Effect.die("unused getRuntimeResponseContext"),
          getPendingNativeUserInputs: () => Effect.die("unused getPendingNativeUserInputs"),
          getProviderControlContext: (_threadId, target) =>
            Ref.get(projection).pipe(
              Effect.map((current) => ({
                providerThread: current.providerThreads.find(
                  (thread) => thread.id === target.providerThreadId,
                ),
                providerTurn: current.providerTurns.find(
                  (turn) => turn.id === target.providerTurnId,
                ),
                attempt: current.attempts.find((attempt) => attempt.id === target.attemptId),
                message: undefined,
                run: undefined,
              })),
            ),
          getCheckpointContext: () => Effect.die("not used"),
          getCheckpointRollbackContext: () => Effect.die("unused rollback context"),
          getCheckpointCaptureContext: () => Effect.die("not used"),
          getRunMessage: () => Effect.die("not used"),
          isNodeStored: () => Effect.die("not used"),
          canStartQueuedRun: () => Effect.die("not used"),
          getRecoveryThreadIds: () => Effect.die("unused getRecoveryThreadIds"),
          getUnreadableThreadIds: () => Effect.die("unused getUnreadableThreadIds"),
          getThreadSnapshot: () => Effect.die("unused getThreadSnapshot"),
          getThreadSnapshotWindow: () => Effect.die("unused getThreadSnapshotWindow"),
        }),
      );
      const layerSessionManager = Layer.succeed(
        ProviderSessionManager.ProviderSessionManagerV2,
        ProviderSessionManager.ProviderSessionManagerV2.of({
          shutdown: Effect.void,
          open: () => Effect.die("unused open"),
          get: (providerSessionId) =>
            Effect.succeed(
              providerSessionId === oldSessionId ? Option.some(runtime) : Option.none(),
            ),
          isLive: (providerSessionId) => Effect.succeed(providerSessionId === oldSessionId),
          close: () => Effect.void,
          closeInstance: () => Effect.void,
          release: () => Effect.void,
          detach: () => Effect.void,
        }),
      );
      const layerControl = ProviderTurnControlService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(layerProjection, layerSessionManager, RunAdmission.layerOrdinary),
        ),
      );

      const [ordinaryInterrupt, unrelatedRestart] = yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        const ordinary = yield* Effect.exit(
          control.interrupt({
            threadId,
            providerSessionId: oldSessionId,
            providerThreadId,
            providerTurnId,
          }),
        );
        const unrelated = yield* Effect.exit(
          control.interruptAndAwaitTerminal({
            threadId,
            providerSessionId: oldSessionId,
            replacementProviderSessionId: unrelatedSessionId,
            providerThreadId,
            providerTurnId,
            interruptedAttemptId: attemptId,
          }),
        );
        return [ordinary, unrelated] as const;
      }).pipe(Effect.provide(layerControl));

      assert.isTrue(Exit.isFailure(ordinaryInterrupt));
      assert.isTrue(Exit.isFailure(unrelatedRestart));
      assert.isNull(yield* Ref.get(interruptedThread));

      yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        yield* control.interruptAndAwaitTerminal({
          threadId,
          providerSessionId: oldSessionId,
          replacementProviderSessionId: replacementSessionId,
          providerThreadId,
          providerTurnId,
          interruptedAttemptId: attemptId,
        });
      }).pipe(Effect.provide(layerControl));

      const interrupted = yield* Ref.get(interruptedThread);
      assert.isNotNull(interrupted);
      assert.equal(interrupted?.providerSessionId, oldSessionId);
      assert.equal(interrupted?.id, providerThreadId);
      assert.equal(interrupted?.nativeThreadRef?.nativeId, "native-thread:restart-session");
    }),
);

it.effect.each(["ordinary", "revoked"] as const)(
  "checks %s ownership at the native steer boundary",
  (state) => {
    const threadId = ThreadId.make("owned-steer-thread");
    const providerSessionId = ProviderSessionId.make("owned-steer-session");
    const providerThreadId = ProviderThreadId.make("owned-steer-provider-thread");
    const providerTurnId = ProviderTurnId.make("owned-steer-turn");
    const runId = RunId.make("owned-steer-run");
    const messageId = MessageId.make("owned-steer-message");
    let revoked = false;
    const steerTurn = vi.fn(() => Effect.void);
    const check = vi.fn(() =>
      Effect.sync(() =>
        revoked
          ? { _tag: "denied" as const, reason: "owner archived" }
          : { _tag: "ordinary" as const },
      ),
    );
    const layer = ProviderTurnControlService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(RunAdmission.RunAdmission)({ check }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getProviderControlContext: () =>
              Effect.succeed({
                providerThread: { id: providerThreadId, providerSessionId },
                providerTurn: { id: providerTurnId, providerThreadId, status: "running" },
                run: { id: runId },
                message: { id: messageId, text: "Continue", attachments: [] },
              } as never),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: () =>
              Effect.sync(() => {
                revoked = state === "revoked";
                return Option.some({ steerTurn } as never);
              }),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
      const exit = yield* Effect.exit(
        service.steer({ threadId, providerSessionId, providerThreadId, providerTurnId, messageId }),
      );
      assert.equal(exit._tag, state === "revoked" ? "Failure" : "Success");
      assert.equal(steerTurn.mock.calls.length, state === "revoked" ? 0 : 1);
      assert.equal(check.mock.calls.length, 1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each(["attempt", "session", "final-check"] as const)(
  "rejects an old steer when the %s changes across native authorization",
  (replacement) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("steer-race-thread");
      const providerSessionId = ProviderSessionId.make("steer-race-old-session");
      const providerThreadId = ProviderThreadId.make("steer-race-provider-thread");
      const providerTurnId = ProviderTurnId.make("steer-race-old-turn");
      const runId = RunId.make("steer-race-run");
      const oldAttempt = RunAttemptId.make("steer-race-old-attempt");
      const newAttempt = RunAttemptId.make("steer-race-new-attempt");
      const messageId = MessageId.make("steer-race-message");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const finalEntered = yield* Deferred.make<void>();
      const finalRelease = yield* Deferred.make<void>();
      let checkCount = 0;
      let lastNativeTarget: RunAdmission.NativeTarget | undefined;
      let attempt = oldAttempt;
      let currentSession = providerSessionId;
      const steerTurn = vi.fn(() => Effect.void);
      const layer = ProviderTurnControlService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(RunAdmission.RunAdmission)({
              check: (checkInput) =>
                Effect.gen(function* () {
                  checkCount += 1;
                  if (replacement === "final-check" && checkCount === 2) {
                    yield* Deferred.succeed(finalEntered, undefined);
                    yield* Deferred.await(finalRelease);
                  }
                  lastNativeTarget = checkInput.nativeTarget;
                  if (
                    checkInput.nativeTarget !== undefined &&
                    checkInput.nativeTarget.providerSessionId !== currentSession
                  ) {
                    return { _tag: "denied" as const, reason: "native-target-stale" };
                  }
                  return {
                    _tag: "admitted" as const,
                    owner: {
                      projectId: ProjectId.make("race-project"),
                      bindingId: "race-binding",
                      rootId: "race-root",
                      generation: 2,
                      fence: 2,
                      threadId,
                      runId,
                      runAttemptId: attempt,
                      expiresAt: "2099-01-01T00:00:00Z",
                      configuration: {
                        providerInstanceId: "codex",
                        model: "gpt-5.4",
                        instructionsHash: "hash",
                        toolIds: [],
                        skillIds: [],
                        runtimeVersion: "v1",
                        maxTokens: 1000,
                        maxDurationMs: 1000,
                        paidFallback: false,
                      },
                    },
                  };
                }),
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getProviderControlContext: () =>
                Effect.succeed({
                  providerThread: { id: providerThreadId, providerSessionId: currentSession },
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId,
                    runAttemptId: oldAttempt,
                    status: "running",
                  },
                  run: { id: runId },
                  message: { id: messageId, text: "Continue", attachments: [] },
                } as never),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(Option.some({ steerTurn } as never)),
                ),
            }),
          ),
        ),
      );
      const operation = Effect.gen(function* () {
        yield* (yield* ProviderTurnControlService.ProviderTurnControlServiceV2).steer({
          threadId,
          providerSessionId,
          providerThreadId,
          providerTurnId,
          messageId,
        });
      }).pipe(Effect.provide(layer));
      const fiber = yield* operation.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      if (replacement === "final-check") {
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(finalEntered);
        currentSession = ProviderSessionId.make("replacement-session");
        yield* Deferred.succeed(finalRelease, undefined);
      } else {
        if (replacement === "attempt") attempt = newAttempt;
        else currentSession = ProviderSessionId.make("replacement-session");
        yield* Deferred.succeed(release, undefined);
      }
      assert.equal((yield* Fiber.await(fiber))._tag, "Failure");
      assert.equal(steerTurn.mock.calls.length, 0);
      if (replacement === "final-check") {
        assert.deepEqual(lastNativeTarget, {
          runAttemptId: oldAttempt,
          providerThreadId,
          providerSessionId,
          providerTurnId,
        });
      }
    }),
);
