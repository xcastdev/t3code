import { assert, it, vi } from "@effect/vitest";
import {
  NodeId,
  RunId,
  RunAttemptId,
  ProjectId,
  ProviderTurnId,
  ProviderThreadId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunAdmission from "./RunAdmission.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";

it.effect("rejects expired runtime requests before invoking the live adapter", () => {
  const threadId = ThreadId.make("thread-runtime-request-expired");
  const providerSessionId = ProviderSessionId.make("provider-session-runtime-request-expired");
  const requestId = RuntimeRequestId.make("request-expired");
  const respondToRuntimeRequest = vi.fn(
    (_input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput) => Effect.void,
  );
  const getSession = vi.fn(() =>
    Effect.succeed(
      Option.some({
        respondToRuntimeRequest,
      } as never),
    ),
  );
  const projection = {
    runtimeRequests: [
      {
        id: requestId,
        nodeId: NodeId.make("node-runtime-request-expired"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "expired",
        responseCapability: {
          type: "live",
          providerSessionId,
        },
        createdAt: DateTime.makeUnsafe("2026-07-29T00:00:00.000Z"),
        resolvedAt: DateTime.makeUnsafe("2026-07-29T00:00:01.000Z"),
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const layerTest = RuntimeRequestService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        RunAdmission.layerOrdinary,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRuntimeRequest: (_threadId, requestId) =>
            Effect.succeed(projection.runtimeRequests.find((request) => request.id === requestId)),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: getSession,
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
    const error = yield* service
      .respond({
        threadId,
        providerSessionId,
        requestId,
        decision: "accept",
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "request-not-ready");
    assert.equal(
      error.message,
      `Runtime request ${requestId} on thread ${threadId} is not ready for response execution.`,
    );
    assert.isUndefined(error.cause);
    assert.equal(getSession.mock.calls.length, 0);
    assert.equal(respondToRuntimeRequest.mock.calls.length, 0);
  }).pipe(Effect.provide(layerTest));
});

it.effect.each(["ordinary", "revoked"] as const)(
  "checks %s ownership after resolving the live response session",
  (state) => {
    const threadId = ThreadId.make("owned-runtime-request");
    const providerSessionId = ProviderSessionId.make("owned-runtime-session");
    const requestId = RuntimeRequestId.make("owned-runtime-request");
    let revoked = false;
    const respondToRuntimeRequest = vi.fn(() => Effect.void);
    const check = vi.fn(() =>
      Effect.sync(() =>
        revoked
          ? { _tag: "denied" as const, reason: "owner archived" }
          : { _tag: "ordinary" as const },
      ),
    );
    const layer = RuntimeRequestService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(RunAdmission.RunAdmission)({ check }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRuntimeRequest: () =>
              Effect.succeed({
                status: "resolved",
                responseCapability: { type: "live", providerSessionId },
              } as never),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: () =>
              Effect.sync(() => {
                revoked = state === "revoked";
                return Option.some({ respondToRuntimeRequest } as never);
              }),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
      const exit = yield* Effect.exit(
        service.respond({ threadId, providerSessionId, requestId, decision: "accept" }),
      );
      assert.equal(exit._tag, state === "revoked" ? "Failure" : "Success");
      assert.equal(respondToRuntimeRequest.mock.calls.length, state === "revoked" ? 0 : 1);
      assert.equal(check.mock.calls.length, 1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each(["attempt", "session", "final-check"] as const)(
  "rejects an old response when the %s changes across native authorization",
  (replacement) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("response-race-thread");
      const providerSessionId = ProviderSessionId.make("response-race-old-session");
      const providerThreadId = ProviderThreadId.make("response-race-provider-thread");
      const providerTurnId = ProviderTurnId.make("response-race-old-turn");
      const runId = RunId.make("response-race-run");
      const oldAttempt = RunAttemptId.make("response-race-old-attempt");
      const newAttempt = RunAttemptId.make("response-race-new-attempt");
      const nodeId = NodeId.make("response-race-node");
      const requestId = RuntimeRequestId.make("response-race-request");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const finalEntered = yield* Deferred.make<void>();
      const finalRelease = yield* Deferred.make<void>();
      let checkCount = 0;
      let lastNativeTarget: RunAdmission.NativeTarget | undefined;
      let attempt = oldAttempt;
      let currentSession = providerSessionId;
      const request = {
        id: requestId,
        nodeId,
        providerTurnId,
        status: "resolved",
        responseCapability: { type: "live", providerSessionId },
      } as const;
      const respondToRuntimeRequest = vi.fn(() => Effect.void);
      const layer = RuntimeRequestService.layer.pipe(
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
              getRuntimeRequest: () => Effect.succeed(request as never),
              getRuntimeResponseContext: () =>
                Effect.succeed({
                  request,
                  node: { id: nodeId, runId, providerTurnId, providerThreadId },
                } as never),
              getThreadRecords: () =>
                Effect.succeed({
                  providerTurns: [
                    { id: providerTurnId, providerThreadId, runAttemptId: oldAttempt },
                  ],
                  providerThreads: [{ id: providerThreadId, providerSessionId: currentSession }],
                } as never),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(Option.some({ respondToRuntimeRequest } as never)),
                ),
            }),
          ),
        ),
      );
      const operation = Effect.gen(function* () {
        yield* (yield* RuntimeRequestService.RuntimeRequestServiceV2).respond({
          threadId,
          providerSessionId,
          requestId,
          decision: "accept",
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
      assert.equal(respondToRuntimeRequest.mock.calls.length, 0);
      if (replacement === "final-check") {
        assert.deepEqual(lastNativeTarget, {
          runAttemptId: oldAttempt,
          providerThreadId,
          providerSessionId,
          providerTurnId,
          nodeId,
        });
      }
    }),
);
