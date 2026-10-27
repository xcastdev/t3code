import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { assistantsEnvironment } from "../../state/assistants";
import { useEnvironmentQuery } from "../../state/query";
import { openSettings } from "../settings/settings-navigation";
import { useAgentThreadOwner } from "./useAgentThreadOwner";

/** Canonical homes open the owning agent's configuration; child chats open its overview. */
export function useAgentThreadLink(environmentId: EnvironmentId | null, threadId: ThreadId | null) {
  const navigation = useNavigation();
  const state = useAgentThreadOwner(environmentId, threadId);
  const owned = state.kind === "canonical" || state.kind === "child" ? state : null;
  const assistantId = owned?.owner.assistantId ?? null;
  const kind = owned?.kind ?? null;
  const detail = useEnvironmentQuery(
    assistantId === null || environmentId === null
      ? null
      : assistantsEnvironment.detail({
          environmentId,
          input: { environmentId, assistantId },
        }),
  );
  const name = detail.data?.summary.name ?? "Agent";
  return useMemo(() => {
    if (assistantId === null || kind === null || environmentId === null) return null;
    return {
      kind,
      name,
      label: kind === "canonical" ? `Agent · ${name}` : `Part of ${name}'s work`,
      open: () =>
        openSettings(navigation, "SettingsAgent", {
          environmentId,
          assistantId,
          section: kind === "canonical" ? "configuration" : "overview",
        }),
    };
  }, [assistantId, environmentId, kind, name, navigation]);
}
