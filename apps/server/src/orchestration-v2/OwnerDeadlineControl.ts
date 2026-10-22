import * as Result from "effect/Result";
import { CommandId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { OwnerDeadlineControlPayload } from "./EffectOutbox.ts";
import * as RunAdmission from "./RunAdmission.ts";

export class OwnerDeadlineControlError extends Schema.TaggedError<OwnerDeadlineControlError>()(
  "OwnerDeadlineControlError",
  { controlId: Schema.String, cause: Schema.Defect() },
) {}

const isOwnerDeadlineControlError = Schema.is(OwnerDeadlineControlError);

/** Commits a stop for the exact target run, without waiting for native drain or finalization. */
export class OwnerDeadlineStop extends Context.Service<
  OwnerDeadlineStop,
  {
    readonly stop: (input: {
      readonly control: OwnerDeadlineControlPayload;
      readonly commandId: CommandId;
    }) => Effect.Effect<void, OwnerDeadlineControlError>;
  }
>()("t3/orchestration-v2/OwnerDeadlineControl/OwnerDeadlineStop") {}

export class OwnerDeadlineControl extends Context.Service<
  OwnerDeadlineControl,
  {
    readonly handle: (
      control: OwnerDeadlineControlPayload,
    ) => Effect.Effect<{ readonly rescheduleAt?: string }, OwnerDeadlineControlError>;
  }
>()("t3/orchestration-v2/OwnerDeadlineControl") {}

export const layer = Layer.effect(
  OwnerDeadlineControl,
  Effect.gen(function* () {
    const admission = yield* RunAdmission.RunAdmission;
    const stops = yield* OwnerDeadlineStop;
    return OwnerDeadlineControl.of({
      handle: Effect.fn("OwnerDeadlineControl.handle")(
        function* (control) {
          // Process-loss recovery resets availableAt; the retained deadline remains authoritative.
          const now = DateTime.formatIso(yield* DateTime.now);
          const decision = yield* admission.deadline({ ...control, now });
          if (decision._tag === "early") return { rescheduleAt: decision.availableAt };
          if (decision._tag === "stale") return {};
          const results = yield* Effect.forEach(
            decision.targets,
            (target) =>
              stops
                .stop({
                  control: target,
                  commandId: CommandId.make(`${target.controlId}:stop`),
                })
                .pipe(Effect.result),
            { concurrency: "unbounded" },
          );
          for (const result of results) if (Result.isFailure(result)) return yield* result.failure;
          return {};
        },
        (effect, control) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isOwnerDeadlineControlError(cause)
                ? cause
                : new OwnerDeadlineControlError({ controlId: control.controlId, cause }),
            ),
          ),
      ),
    });
  }),
);
