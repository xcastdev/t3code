import { useNavigation } from "@react-navigation/native";
import { use, useMemo, useState } from "react";
import { Platform } from "react-native";

import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import { steadyNavigationThreadShellsAtom } from "../../state/threads";
import { useLaunchingThreads } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { useSelectWorkspaceTab } from "../layout/workspace/useSelectWorkspaceTab";
import { useWorkspaceTabs } from "../layout/workspace/WorkspaceTabsContext";
import { WorkspaceListEmptyDetail } from "../layout/workspace/WorkspaceListEmptyDetail";
import { WorkspaceListHeader } from "../layout/workspace/WorkspaceListHeader";
import { openSettings } from "../settings/settings-navigation";
import { AndroidHomeFabLayout } from "./AndroidHomeFab";
import { HomeAgentsList } from "./HomeAgentsList";
import { buildHomeListFilterMenuItems, homeListFilterEnvironments } from "./home-list-filter-menu";
import { useHomeListOptions } from "./home-list-options";
import {
  runWhenHomeCovered,
  useAtomValueWhileVisible,
  useHomeRouteVisible,
} from "./home-route-visibility";
import { useAgentNavigation } from "./useAgentNavigation";

/** The Agents tab, with the same header, search and environment filter as Chats. */
export function HomeAgentsRouteScreen(props: {
  /** In Android's sidebar column, which draws its own New thread button. */
  readonly sidebar?: boolean;
}) {
  const nativePrimaryColumn = use(NativePrimaryColumnContext);
  const { layout, startNewTask } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const selectTab = useSelectWorkspaceTab();
  const visible = useHomeRouteVisible();
  const threads = useLaunchingThreads(
    useAtomValueWhileVisible(steadyNavigationThreadShellsAtom, visible),
  );
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const workspace = useWorkspaceTabs();
  const [localSearchQuery, setLocalSearchQuery] = useState("");
  const searchQuery = workspace?.state.tabs.agents.query ?? localSearchQuery;
  const setSearchQuery = (query: string) =>
    workspace
      ? workspace.dispatch({ type: "query", query, tab: "agents" })
      : setLocalSearchQuery(query);
  const selectDetail = useSelectWorkspaceDetail();
  // As on Chats: only the stacked layout opens the chat over the list, so it leaves search.
  const clearsSearchOnOpen = Platform.OS !== "android" && !layout.usesSplitView;
  const openThread = (params: ReactNavigation.RootParamList["Thread"]) => {
    if (searchQuery !== "" && clearsSearchOnOpen && workspace)
      runWhenHomeCovered(() => workspace.cancelSearch("agents"));
    selectDetail({ name: "Thread", params });
  };
  const agentNavigation = useAgentNavigation(openThread);
  const environments = homeListFilterEnvironments(workspaceEnvironments);
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const { options, setSelectedEnvironmentId } = useHomeListOptions(availableEnvironmentIds);
  const selectedEnvironmentId = options.selectedEnvironmentId;
  // New agent opens Settings' form in the environment the list shows, or the only connected one.
  const connectedEnvironmentIds = environments
    .filter((environment) => environment.connectionState === "connected")
    .map((environment) => environment.environmentId);
  const newAgentEnvironmentId =
    selectedEnvironmentId ??
    (connectedEnvironmentIds.length === 1 ? connectedEnvironmentIds[0]! : null);

  if (layout.usesSplitView && !nativePrimaryColumn && !props.sidebar) {
    return (
      <WorkspaceListEmptyDetail
        hasConnections={catalogState.hasConnections}
        onAddConnection={() => openSettings(navigation, "SettingsEnvironmentNew")}
        onStartNewTask={startNewTask}
      />
    );
  }

  const list = (
    <>
      <WorkspaceListHeader
        tab="agents"
        accessibilityLabel="T3 Code, Agents"
        onOpenEnvironments={() => openSettings(navigation, "SettingsEnvironments")}
        onOpenSettings={() => selectTab("settings")}
        search={{
          value: searchQuery,
          onChangeText: setSearchQuery,
          placeholder: "Search",
          accessibilityLabel: "Search agents",
        }}
        filter={{
          customized: selectedEnvironmentId !== null,
          items: buildHomeListFilterMenuItems({
            environments,
            projects: [],
            selectedEnvironmentId,
            selectedProjectKey: null,
            onEnvironmentChange: setSelectedEnvironmentId,
            onProjectChange: () => {},
          }),
        }}
      />
      <HomeAgentsList
        environments={environments}
        selectedEnvironmentId={selectedEnvironmentId}
        threads={threads}
        searchQuery={searchQuery}
        onEnvironmentChange={setSelectedEnvironmentId}
        onOpenThread={({ environmentId, threadId }) =>
          openThread({ environmentId: String(environmentId), threadId })
        }
        onOpenAgent={agentNavigation.openAgent}
        onOpenAgentDetails={agentNavigation.openAgentDetails}
        onNewAgent={() => agentNavigation.openNewAgent(newAgentEnvironmentId)}
      />
    </>
  );
  return props.sidebar ? (
    list
  ) : (
    <AndroidHomeFabLayout onStartNewTask={startNewTask}>{list}</AndroidHomeFabLayout>
  );
}
