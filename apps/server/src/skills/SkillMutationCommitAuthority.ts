import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ManagedSkillRepositoryError } from "./ManagedSkillRepository.ts";

/** The authenticated bridge rechecks durable grants immediately before a synchronous swap. */
export class SkillMutationCommitAuthority extends Context.Service<
  SkillMutationCommitAuthority,
  {
    readonly commit: (action: () => void) => Effect.Effect<void, ManagedSkillRepositoryError>;
    readonly transaction?: <A, E>(
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | ManagedSkillRepositoryError>;
  }
>()("t3/skills/SkillMutationCommitAuthority") {}
