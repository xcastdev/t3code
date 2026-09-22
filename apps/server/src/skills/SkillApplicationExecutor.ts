import type { SkillApplicationDetail } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class SkillApplicationExecutionError extends Schema.TaggedError<SkillApplicationExecutionError>()(
  "SkillApplicationExecutionError",
  {
    code: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface SkillApplicationExecutorShape {
  readonly execute: (
    desired: SkillApplicationDetail,
  ) => Effect.Effect<SkillApplicationDetail, SkillApplicationExecutionError>;
}

export class SkillApplicationExecutor extends Context.Service<
  SkillApplicationExecutor,
  SkillApplicationExecutorShape
>()("t3/skills/SkillApplicationExecutor") {}

/** Session preparation already produced the desired provider plan; the reactor
 * durably acknowledges that pending/unsupported state before startup applies it. */
export const SkillApplicationExecutorLive = Layer.succeed(
  SkillApplicationExecutor,
  SkillApplicationExecutor.of({ execute: (desired) => Effect.succeed(desired) }),
);
