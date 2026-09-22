import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface SkillCatalogApplicationReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class SkillCatalogApplicationReactor extends Context.Service<
  SkillCatalogApplicationReactor,
  SkillCatalogApplicationReactorShape
>()("t3/orchestration/Services/SkillCatalogApplicationReactor") {}
