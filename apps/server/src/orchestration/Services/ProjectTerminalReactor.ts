/** ProjectTerminalReactor - Project deletion cleanup and receipt service. */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { TerminalToolError } from "@t3tools/contracts";

export interface ProjectTerminalReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drainThrough: (sequence: number) => Effect.Effect<void, TerminalToolError>;
  /** Drain through the latest committed orchestration event before shutdown. */
  readonly drain: Effect.Effect<void, TerminalToolError>;
}

export class ProjectTerminalReactor extends Context.Service<
  ProjectTerminalReactor,
  ProjectTerminalReactorShape
>()("t3/orchestration/Services/ProjectTerminalReactor") {}
