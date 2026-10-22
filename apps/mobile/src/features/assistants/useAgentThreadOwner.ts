import { assistantThreadOwnerState } from "@t3tools/client-runtime/state/assistants";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { assistantsEnvironment } from "../../state/assistants";
import { useEnvironmentQuery } from "../../state/query";
import { useAssistantConnection } from "./useAssistants";

/**
 * Exact owner of a chat on the current connection, keeping offline and unknown distinct from
 * ordinary so callers never treat an unresolved read as permission to diverge from an agent.
 */
export function useAgentThreadOwner(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
) {
  const connection = useAssistantConnection(environmentId);
  const query = useEnvironmentQuery(
    environmentId === null || threadId === null
      ? null
      : assistantsEnvironment.owner({ environmentId, input: { environmentId, threadId } }),
  );
  if (environmentId === null || threadId === null) return { kind: "unknown" as const };
  return assistantThreadOwnerState({
    target: { environmentId, threadId },
    snapshot: query.data ?? null,
    connectionEpoch: connection.epoch,
  });
}

export type AgentThreadOwnerKind = ReturnType<typeof useAgentThreadOwner>["kind"];
