import { useNavigation } from "@react-navigation/native";

import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useWorkspaceTabs } from "../layout/workspace/WorkspaceTabsContext";
import { WorkHome } from "./WorkHome";

/**
 * The workspace Work destination: the cross-project home. Projects and tasks open as pages with
 * native Back. `list` is the split sidebar, `detail` the split content, `full` the single pane.
 */
export function WorkTab({ mode = "full" }: { readonly mode?: "full" | "list" | "detail" }) {
  const navigation = useNavigation();
  const bottom = useWorkspaceTabs()?.bottomClearance ?? 16;
  if (mode === "detail")
    return (
      <EmptyState
        variant="plain"
        title="Choose a project"
        detail="Pick a project in the sidebar to see its Work."
      />
    );
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1"
      contentContainerClassName="gap-6 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: bottom + 18 }}
    >
      <WorkHome
        onOpenProject={(environmentId, projectId, section) =>
          navigation.navigate("ProjectWork", {
            environmentId,
            projectId,
            ...(section ? { section } : {}),
          })
        }
        onOpenTask={(environmentId, projectId, taskId) =>
          navigation.navigate("WorkTask", { environmentId, projectId, taskId })
        }
      />
    </ScrollView>
  );
}
