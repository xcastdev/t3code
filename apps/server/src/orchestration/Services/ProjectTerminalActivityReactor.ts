import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ProjectTerminalActivityReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class ProjectTerminalActivityReactor extends Context.Service<
  ProjectTerminalActivityReactor,
  ProjectTerminalActivityReactorShape
>()("t3/orchestration/Services/ProjectTerminalActivityReactor") {}
