import type { ScheduledTaskError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

// The gateway supplies a live caller check; timer/webhook fires use retained routine authority.
export class AssistantRoutineAuthorization extends Context.Reference<
  Effect.Effect<void, ScheduledTaskError>
>("t3/assistants/AssistantRoutineAuthorization", { defaultValue: () => Effect.void }) {}
