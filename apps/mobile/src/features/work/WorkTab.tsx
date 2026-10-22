import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useCallback } from "react";
import { BackHandler, Platform, View } from "react-native";

import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useProject } from "../../state/entities";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { WorkProjectContent, WorkProjectList } from "./WorkScreens";
import { WorkTaskContent } from "./WorkTaskScreen";
import { WorkText } from "./WorkParts";
import { backWorkLocation, openWorkTask, type WorkLocation } from "./workNavigation";

/**
 * Where the Work tab was left: checkout, section and open task. It outlives the
 * pane so switching tabs, or the split sidebar and detail, return to the same place.
 */
const workLocationAtom = Atom.make<WorkLocation | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:work-tab:location"),
);

export function useOpenWorkProject() {
  const setLocation = useAtomSet(workLocationAtom);
  return (environmentId: EnvironmentId, projectId: ProjectId) =>
    setLocation({ environmentId, projectId, section: "overview", tasks: [] });
}

/**
 * The workspace Work destination. `list` is the split sidebar (choose a
 * checkout), `detail` the split content, and `full` the single-pane tab.
 */
export function WorkTab({ mode = "full" }: { readonly mode?: "full" | "list" | "detail" }) {
  const location = useAtomValue(workLocationAtom);
  const setLocation = useAtomSet(workLocationAtom);
  const openProject = useOpenWorkProject();
  const bottom = useWorkspaceTabs()?.bottomClearance ?? 16;
  const project = useProject(
    location === null ? null : scopeProjectRef(location.environmentId, location.projectId),
  );
  const previous = backWorkLocation(location, mode);
  const back = previous === undefined ? null : () => setLocation(previous);
  // Hidden tabs run no effects, and Home stays mounted but blurred under Settings,
  // so only the visible Work pane on the focused screen claims hardware Back.
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android" || back === null) return;
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        back();
        return true;
      });
      return () => subscription.remove();
    }, [back]),
  );

  const showList = mode === "list" || (mode === "full" && location === null);
  const taskId = location?.tasks.at(-1) ?? null;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1"
      contentContainerClassName="gap-5 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: bottom + 18 }}
    >
      {showList ? (
        <WorkProjectList
          onOpenProject={openProject}
          onOpenTask={(environmentId, projectId, taskId) =>
            setLocation(openWorkTask(location, { environmentId, projectId, taskId }))
          }
        />
      ) : location === null ? (
        <EmptyState
          variant="plain"
          title="Choose a project"
          detail="Pick a checkout in the sidebar to see its Work."
        />
      ) : (
        <>
          {back ? (
            <View className="flex-row">
              <Button
                label={location.tasks.length > 0 ? "Back" : "All projects"}
                icon="chevron.left"
                tone="text"
                onPress={back}
              />
            </View>
          ) : null}
          {project === null ? (
            <WorkText muted>
              This project isn't on the selected environment, or it was removed.
            </WorkText>
          ) : taskId !== null ? (
            <WorkTaskContent
              key={`${location.environmentId}:${location.projectId}:${taskId}`}
              scope={{
                environmentId: location.environmentId,
                projectId: location.projectId,
                checkoutPath: project.workspaceRoot,
              }}
              taskId={taskId}
              onOpenTask={(next) =>
                setLocation(openWorkTask(location, { ...location, taskId: next }))
              }
            />
          ) : (
            <WorkProjectContent
              key={`${location.environmentId}:${location.projectId}`}
              scope={{
                environmentId: location.environmentId,
                projectId: location.projectId,
                checkoutPath: project.workspaceRoot,
              }}
              section={location.section}
              onSectionChange={(section) => setLocation({ ...location, section })}
              onOpenTask={(next) =>
                setLocation(openWorkTask({ ...location, tasks: [] }, { ...location, taskId: next }))
              }
            />
          )}
        </>
      )}
    </ScrollView>
  );
}
