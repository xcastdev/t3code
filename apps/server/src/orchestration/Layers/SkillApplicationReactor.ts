import {
  CommandId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type SkillApplicationDetail,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../../serverActivation.ts";
import {
  SkillApplicationExecutor,
  type SkillApplicationExecutionError,
} from "../../skills/SkillApplicationExecutor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  SkillApplicationReactor,
  type SkillApplicationReactorShape,
} from "../Services/SkillApplicationReactor.ts";

type DesiredEvent = Extract<OrchestrationEvent, { type: "thread.skill-application.desired" }>;
type ReceiptCommand = Extract<OrchestrationCommand, { type: "thread.skill-application.receipt" }>;

const failedApplication = (
  desired: SkillApplicationDetail,
  attemptedAt: string,
): SkillApplicationDetail => ({
  ...desired,
  status: "failed",
  failure: {
    code: "provider_skill_apply_failed",
    message: "The provider could not apply the desired managed skill catalog.",
  },
  attemptedAt,
  outcomes: desired.outcomes.map((outcome) => ({
    ...outcome,
    status: "failed",
    reason: {
      code: "provider_skill_apply_failed",
      message: "The provider could not apply this managed skill.",
    },
  })),
});

export const makeSkillApplicationReceipt = Effect.fn("SkillApplicationReactor.makeReceipt")(
  function* (input: {
    readonly event: DesiredEvent;
    readonly execute: (
      desired: SkillApplicationDetail,
    ) => Effect.Effect<SkillApplicationDetail, SkillApplicationExecutionError>;
  }): Effect.fn.Return<ReceiptCommand> {
    const attemptedAt = DateTime.formatIso(yield* DateTime.now);
    const result = yield* input.execute(input.event.payload.application).pipe(Effect.exit);
    const application =
      result._tag === "Success"
        ? result.value
        : failedApplication(input.event.payload.application, attemptedAt);
    return {
      type: "thread.skill-application.receipt",
      commandId: CommandId.make(
        `server:skill-application:${input.event.payload.threadId}:${application.providerInstanceId}:${application.desiredRevision}`,
      ),
      threadId: input.event.payload.threadId,
      application,
      updatedAt: attemptedAt,
    };
  },
);

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const executor = yield* SkillApplicationExecutor;
  const worker = yield* makeDrainableWorker((event: DesiredEvent) =>
    makeSkillApplicationReceipt({ event, execute: executor.execute }).pipe(
      Effect.flatMap(engine.dispatch),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("skill application reactor failed to process event", {
              threadId: event.payload.threadId,
              providerInstanceId: event.payload.application.providerInstanceId,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const start: SkillApplicationReactorShape["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        event.type === "thread.skill-application.desired" ? worker.enqueue(event) : Effect.void,
      ),
    );
  return { start, drain: worker.drain } satisfies SkillApplicationReactorShape;
});

export const SkillApplicationReactorLive = Layer.effect(SkillApplicationReactor, make);
