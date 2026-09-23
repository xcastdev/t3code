import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface SkillApplicationReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class SkillApplicationReactor extends Context.Service<
  SkillApplicationReactor,
  SkillApplicationReactorShape
>()("t3/orchestration/Services/SkillApplicationReactor") {}
