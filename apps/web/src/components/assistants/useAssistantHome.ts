import { assistantThreadOwnerState } from "@t3tools/client-runtime/state/assistants";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { assistantsEnvironment } from "../../state/assistants";
import { useEnvironmentQuery } from "../../state/query";
import { useAssistantConnection } from "./useAssistants";

/**
 * The agent that owns this thread, from the exact owner read for this thread
 * on its current connection. Chat, palette, Settings and deep links all resolve
 * the same owner; anything stale or offline resolves to no owner here.
 */
export function useAssistantThreadOwner(
  target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null,
) {
  return useAssistantThreadOwnership(target).owner;
}

/** The owner plus how it resolved, so callers can tell ordinary from not-yet-known. */
export function useAssistantThreadOwnership(
  target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null,
) {
  const connection = useAssistantConnection(target?.environmentId ?? null);
  const query = useEnvironmentQuery(
    target === null
      ? null
      : assistantsEnvironment.owner({ environmentId: target.environmentId, input: target }),
  );
  const state =
    target === null
      ? null
      : assistantThreadOwnerState({
          target,
          snapshot: query.data ?? null,
          connectionEpoch: connection.epoch,
        });
  const owned = state?.kind === "canonical" || state?.kind === "child" ? state : null;
  // Only an owned thread reads its agent, for the name; ordinary threads read nothing more.
  const detail = useEnvironmentQuery(
    owned === null
      ? null
      : assistantsEnvironment.detail({
          environmentId: owned.owner.environmentId,
          input: { environmentId: owned.owner.environmentId, assistantId: owned.owner.assistantId },
        }),
  );
  return {
    kind: state?.kind ?? null,
    owner:
      owned === null
        ? null
        : {
            kind: owned.kind,
            environmentId: owned.owner.environmentId,
            assistantId: owned.owner.assistantId,
            canonicalThreadId: owned.owner.canonicalThreadId,
            name: detail.data?.summary.name ?? "Agent",
          },
  };
}

export type AssistantThreadOwnerView = NonNullable<ReturnType<typeof useAssistantThreadOwner>>;
