import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface McpCatalogReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class McpCatalogReactor extends Context.Service<McpCatalogReactor, McpCatalogReactorShape>()(
  "t3/orchestration/Services/McpCatalogReactor",
) {}
