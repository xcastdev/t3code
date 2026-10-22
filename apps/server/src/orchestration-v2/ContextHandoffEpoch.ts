import type { ThreadId, OrchestrationV2ContextHandoff } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { AssistantError } from "../assistants/AssistantRepository.ts";
export class ContextHandoffEpoch extends Context.Service<
  ContextHandoffEpoch,
  {
    readonly capture: (input: {
      threadId: ThreadId;
      items: ReadonlyArray<import("@t3tools/contracts").OrchestrationV2TurnItem>;
    }) => Effect.Effect<
      {
        items: ReadonlyArray<import("@t3tools/contracts").OrchestrationV2TurnItem>;
        omittedItems: number;
        memoryEpoch?: number;
        memoryContextHash?: string;
      },
      AssistantError
    >;
    readonly current: (
      threadId: ThreadId,
    ) => Effect.Effect<
      { memoryEpoch: number; memoryContextHash: string } | undefined,
      AssistantError
    >;
  }
>()("t3/orchestration-v2/ContextHandoffEpoch") {}

export const selectHandoffsForMemoryEpoch = (
  handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>,
  memoryEpoch: number | undefined,
  memoryContextHash?: string,
) =>
  memoryEpoch === undefined
    ? handoffs
    : handoffs.filter(
        (handoff) =>
          handoff.memoryEpoch === memoryEpoch && handoff.memoryContextHash === memoryContextHash,
      );
