import type { AssistantSummary, EnvironmentId } from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";

import { openSettings } from "../settings/settings-navigation";
import { useAdaptiveWorkspaceLayout } from "../layout/adaptive-workspace-context";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";

type ThreadParams = ReactNavigation.RootParamList["Thread"];

/** Opens agents the way the Agents list does, from the list or the compose menu. */
export function useAgentNavigation(openThread?: (params: ThreadParams) => void) {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const { layout } = useAdaptiveWorkspaceLayout();
  // Columns show agent pages beside the Settings list; a phone pushes them over the current tab,
  // so Back returns to Chats or Agents instead of the Settings list.
  const openAgentsPage = <Name extends "SettingsAgent" | "SettingsAgents">(
    name: Name,
    params: ReactNavigation.RootParamList[Name],
  ) => {
    if (layout.usesSplitView) openSettings(navigation, name, ...([params] as never));
    else navigation.dispatch(StackActions.push(name, params));
  };
  const showThread =
    openThread ?? ((params: ThreadParams) => selectDetail({ name: "Thread", params }));
  const openAgentDetails = (agent: AssistantSummary) =>
    openAgentsPage("SettingsAgent", {
      environmentId: agent.environmentId,
      assistantId: agent.assistantId,
    });
  return {
    openAgentDetails,
    /** Its Home chat once set up; until then its page, which shows the progress. */
    openAgent: (agent: AssistantSummary) =>
      agent.provisioningState === "ready"
        ? showThread({
            environmentId: String(agent.environmentId),
            threadId: String(agent.binding.canonicalThreadId),
          })
        : openAgentDetails(agent),
    /** Settings' create form, in `environmentId` when one is known. */
    openNewAgent: (environmentId: EnvironmentId | null) =>
      openAgentsPage(
        "SettingsAgents",
        environmentId === null ? undefined : { createIn: environmentId },
      ),
  };
}
