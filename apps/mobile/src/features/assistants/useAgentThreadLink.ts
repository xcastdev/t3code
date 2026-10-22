import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { assistantsEnvironment } from "../../state/assistants";
import { useEnvironmentQuery } from "../../state/query";
import { useAgentThreadOwner } from "./useAgentThreadOwner";

/**
 * The agent that owns this chat, from the exact owner read on the current
 * connection; null for ordinary threads, while offline, or while unknown.
 * Canonical homes and their children both link to the same agent; a canonical
 * home's link opens its Configuration, which owns that chat's settings. The result
 * is stable while the owner and name are, so native headers don't re-key.
 */
export function useAgentThreadLink(environmentId: EnvironmentId, threadId: ThreadId) {
  const navigation = useNavigation();
  const state = useAgentThreadOwner(environmentId, threadId);
  const owned = state.kind === "canonical" || state.kind === "child" ? state : null;
  const assistantId = owned?.owner.assistantId ?? null;
  const kind = owned?.kind ?? null;
  const detail = useEnvironmentQuery(
    assistantId === null
      ? null
      : assistantsEnvironment.detail({
          environmentId,
          input: { environmentId, assistantId },
        }),
  );
  const name = detail.data?.summary.name ?? "Agent";
  return useMemo(() => {
    if (assistantId === null || kind === null) return null;
    return {
      kind,
      name,
      label: kind === "canonical" ? `Agent · ${name}` : `Part of ${name}'s work`,
      open: () =>
        navigation.navigate("SettingsSheet", {
          screen: "SettingsContent",
          params: {
            screen: "SettingsAgent",
            params: {
              environmentId,
              assistantId,
              section: kind === "canonical" ? "configuration" : "overview",
            },
          },
        }),
    };
  }, [assistantId, environmentId, kind, name, navigation]);
}
