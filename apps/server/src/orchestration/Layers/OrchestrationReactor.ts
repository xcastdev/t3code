import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import * as ThreadSettlementReactor from "../ThreadSettlementReactor.ts";
import * as PullRequestSyncReactor from "../PullRequestSyncReactor.ts";
import * as ThreadPullRequestReactor from "../ThreadPullRequestReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";
import { McpCatalogReactor } from "../Services/McpCatalogReactor.ts";
import { SkillApplicationReactor } from "../Services/SkillApplicationReactor.ts";
import { SkillCatalogApplicationReactor } from "../Services/SkillCatalogApplicationReactor.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const threadSettlementReactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
  const pullRequestSyncReactor = yield* PullRequestSyncReactor.PullRequestSyncReactor;
  const threadPullRequestReactor = yield* ThreadPullRequestReactor.ThreadPullRequestReactor;
  const agentAwarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
  // Focused orchestration harnesses can omit the catalog reactor. Production
  // uses the required layer below, which makes the dependency explicit while
  // keeping unrelated command/CLI test environments lightweight.
  const mcpCatalogReactor = yield* Effect.serviceOption(McpCatalogReactor);
  const skillApplicationReactor = yield* Effect.serviceOption(SkillApplicationReactor);
  const skillCatalogApplicationReactor = yield* Effect.serviceOption(
    SkillCatalogApplicationReactor,
  );

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    yield* providerCommandReactor.start();
    yield* checkpointReactor.start();
    yield* threadDeletionReactor.start();
    yield* threadPullRequestReactor.start();
    yield* threadSettlementReactor.start();
    yield* pullRequestSyncReactor.start();
    yield* agentAwarenessRelay.start();
    if (mcpCatalogReactor._tag === "Some") yield* mcpCatalogReactor.value.start();
    if (skillApplicationReactor._tag === "Some") yield* skillApplicationReactor.value.start();
    if (skillCatalogApplicationReactor._tag === "Some") {
      yield* skillCatalogApplicationReactor.value.start();
    }
  });

  return {
    start,
    drain: Effect.all(
      [
        mcpCatalogReactor._tag === "Some" ? mcpCatalogReactor.value.drain : Effect.void,
        skillApplicationReactor._tag === "Some" ? skillApplicationReactor.value.drain : Effect.void,
        skillCatalogApplicationReactor._tag === "Some"
          ? skillCatalogApplicationReactor.value.drain
          : Effect.void,
      ],
      { discard: true },
    ),
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);

/** Production composition guard: startup must fail if catalog live reload is
 * not layered, even though isolated CLI/orchestration harnesses may omit it. */
export const makeRequiredOrchestrationReactor = Effect.gen(function* () {
  yield* McpCatalogReactor;
  return yield* makeOrchestrationReactor;
});

export const OrchestrationReactorRequiredLive = Layer.effect(
  OrchestrationReactor,
  makeRequiredOrchestrationReactor,
);
