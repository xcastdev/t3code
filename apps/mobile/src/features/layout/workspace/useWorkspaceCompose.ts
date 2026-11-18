import { useAdaptiveWorkspaceLayout } from "../adaptive-workspace-context";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";

/** What the compose button starts on the selected tab; null where the tab has nothing to start. */
export function useWorkspaceCompose() {
  const workspace = useWorkspaceTabs();
  const { startNewTask } = useAdaptiveWorkspaceLayout();
  const tab = workspace?.state.selectedTab;
  if (!workspace || workspace.settingsOpen || (tab !== "threads" && tab !== "agents")) return null;
  return { label: "New chat", onPress: startNewTask } as const;
}
