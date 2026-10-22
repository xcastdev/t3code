import {
  ProviderApprovalDecision,
  ProviderSessionId,
  ProviderUserInputAnswers,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunAdmission from "./RunAdmission.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

export class RuntimeRequestResponseExecutionError extends Schema.TaggedError<RuntimeRequestResponseExecutionError>()(
  "RuntimeRequestResponseExecutionError",
  {
    reason: Schema.Literals([
      "request-missing",
      "request-not-ready",
      "request-not-resumable",
      "provider-session-not-active",
      "unexpected-failure",
    ]),
    threadId: ThreadId,
    providerSessionId: ProviderSessionId,
    requestId: RuntimeRequestId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "request-missing":
        return `Runtime request ${this.requestId} no longer exists on thread ${this.threadId}.`;
      case "request-not-ready":
        return `Runtime request ${this.requestId} on thread ${this.threadId} is not ready for response execution.`;
      case "request-not-resumable":
        return `Runtime request ${this.requestId} on thread ${this.threadId} is not resumable on provider session ${this.providerSessionId}.`;
      case "provider-session-not-active":
        return `Provider session ${this.providerSessionId} is not active for runtime request ${this.requestId} on thread ${this.threadId}.`;
      case "unexpected-failure":
        return `Failed to respond to runtime request ${this.requestId} on thread ${this.threadId} via provider session ${this.providerSessionId}.`;
    }
  }
}

const isRuntimeRequestResponseExecutionError = Schema.is(RuntimeRequestResponseExecutionError);

export interface RuntimeRequestServiceV2Shape {
  readonly respond: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly requestId: RuntimeRequestId;
    readonly decision?: ProviderApprovalDecision;
    readonly answers?: ProviderUserInputAnswers;
  }) => Effect.Effect<void, RuntimeRequestResponseExecutionError>;
}

export class RuntimeRequestServiceV2 extends Context.Service<
  RuntimeRequestServiceV2,
  RuntimeRequestServiceV2Shape
>()("t3/orchestration-v2/RuntimeRequestService/RuntimeRequestServiceV2") {}

export const layer: Layer.Layer<
  RuntimeRequestServiceV2,
  never,
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | RunAdmission.RunAdmission
> = Layer.effect(
  RuntimeRequestServiceV2,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const admission = yield* RunAdmission.RunAdmission;

    return RuntimeRequestServiceV2.of({
      respond: Effect.fn("RuntimeRequestService.respond")(
        function* (input) {
          const request = yield* projections.getRuntimeRequest(input.threadId, input.requestId);
          if (request === undefined) {
            return yield* new RuntimeRequestResponseExecutionError({
              reason: "request-missing",
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
              requestId: input.requestId,
            });
          }
          // Dispatch validates the request while it is pending, then persists the
          // resolved projection before this effect is executed.
          if (request.status !== "resolved") {
            return yield* new RuntimeRequestResponseExecutionError({
              reason: "request-not-ready",
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
              requestId: input.requestId,
            });
          }
          if (
            request.responseCapability.type !== "live" ||
            request.responseCapability.providerSessionId !== input.providerSessionId
          ) {
            return yield* new RuntimeRequestResponseExecutionError({
              reason: "request-not-resumable",
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
              requestId: input.requestId,
            });
          }
          const session = yield* sessions.get(input.providerSessionId);
          if (Option.isNone(session)) {
            return yield* new RuntimeRequestResponseExecutionError({
              reason: "provider-session-not-active",
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
              requestId: input.requestId,
            });
          }
          const permitted = yield* admission.check({
            threadId: input.threadId,
            operation: "continue",
            now: DateTime.formatIso(yield* DateTime.now),
          });
          if (permitted._tag === "denied" || permitted._tag === "expired") {
            return yield* new RuntimeRequestResponseExecutionError({
              reason: "request-not-resumable",
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
              requestId: input.requestId,
            });
          }
          if (permitted._tag === "admitted") {
            const context = yield* projections.getRuntimeResponseContext(
              input.threadId,
              input.requestId,
            );
            const runId = context.node?.runId;
            const records = yield* projections.getThreadRecords(input.threadId, [
              "providerTurns",
              "providerThreads",
            ]);
            const targetTurn = records.providerTurns.find(
              (turn) => turn.id === request.providerTurnId,
            );
            const targetThread = records.providerThreads.find(
              (thread) => thread.id === targetTurn?.providerThreadId,
            );
            const current =
              runId == null ||
              targetTurn?.runAttemptId == null ||
              targetThread === undefined ||
              context.node === undefined
                ? undefined
                : yield* admission.check({
                    threadId: input.threadId,
                    runId,
                    operation: "continue",
                    nativeTarget: {
                      runAttemptId: targetTurn.runAttemptId,
                      providerThreadId: targetThread.id,
                      providerSessionId: input.providerSessionId,
                      providerTurnId: targetTurn.id,
                      nodeId: context.node.id,
                    },
                    now: DateTime.formatIso(yield* DateTime.now),
                  });
            if (
              current?._tag !== "admitted" ||
              current.owner.bindingId !== permitted.owner.bindingId ||
              current.owner.generation !== permitted.owner.generation ||
              current.owner.fence !== permitted.owner.fence ||
              current.owner.runId !== runId ||
              current.owner.runAttemptId === undefined ||
              targetTurn?.runAttemptId !== current.owner.runAttemptId ||
              context.request?.providerTurnId == null ||
              context.request.providerTurnId !== request.providerTurnId ||
              context.node?.providerTurnId !== context.request.providerTurnId ||
              context.node?.providerThreadId !== targetThread?.id ||
              targetThread?.providerSessionId !== input.providerSessionId ||
              context.request?.status !== "resolved" ||
              context.request.responseCapability.type !== "live" ||
              context.request.responseCapability.providerSessionId !== input.providerSessionId
            ) {
              return yield* new RuntimeRequestResponseExecutionError({
                reason: "request-not-resumable",
                threadId: input.threadId,
                providerSessionId: input.providerSessionId,
                requestId: input.requestId,
              });
            }
          }
          yield* session.value.respondToRuntimeRequest({
            requestId: input.requestId,
            ...(input.decision === undefined ? {} : { decision: input.decision }),
            ...(input.answers === undefined ? {} : { answers: input.answers }),
          });
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isRuntimeRequestResponseExecutionError(cause)
                ? cause
                : new RuntimeRequestResponseExecutionError({
                    reason: "unexpected-failure",
                    threadId: input.threadId,
                    providerSessionId: input.providerSessionId,
                    requestId: input.requestId,
                    cause,
                  }),
            ),
          ),
      ),
    });
  }),
);
