import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ProjectWorkScope } from "@t3tools/client-runtime/project-work";
import {
  type EnvironmentId,
  type ProjectId,
  ProjectWorkTaskId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { type RightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import type { WorkSection } from "../../routes/-workSearch";
import { useProject } from "../../state/entities";
import { ScrollArea } from "../ui/scroll-area";
import { useWorkWriter } from "./useWorkWriter";
import { WorkEmpty } from "./WorkLayout";
import { WorkIntake } from "./WorkIntake";
import { WorkKnowledge } from "./WorkKnowledge";
import { WorkOverview } from "./WorkOverview";
import { WorkTaskDetail } from "./WorkTaskDetail";
import { WorkTasks } from "./WorkTasks";
import { WorkTeam } from "./WorkTeam";

/** The thread's project Work in the right panel; tasks open as tabs of their own. */
export function WorkPanel({
  threadRef,
  environmentId,
  projectId,
  surface,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly surface: Extract<RightPanelSurface, { kind: "work" | "work-task" }>;
}) {
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const writer = useWorkWriter(environmentId);
  if (project === null) return <WorkEmpty title="Project not found" />;

  // The project's own checkout, not the thread's worktree, identifies its Work.
  const scope: ProjectWorkScope = { environmentId, projectId, checkoutPath: project.workspaceRoot };
  const openView = (view: WorkSection) => useRightPanelStore.getState().openWork(threadRef, view);
  const openTask = (taskId: ProjectWorkTaskId | undefined, title?: string) => {
    if (taskId !== undefined) useRightPanelStore.getState().openWorkTask(threadRef, taskId, title);
  };
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="@container/work flex min-w-0 flex-col gap-4 p-4">
        {surface.kind === "work-task" ? (
          <WorkTaskDetail
            key={surface.taskId}
            scope={scope}
            taskId={ProjectWorkTaskId.make(surface.taskId)}
            writer={writer}
            onOpenTask={openTask}
            onBack={() => openView("tasks")}
          />
        ) : surface.view === "overview" ? (
          <WorkOverview
            scope={scope}
            writer={writer}
            onOpenTask={openTask}
            onOpenTeam={() => openView("team")}
          />
        ) : surface.view === "tasks" ? (
          <WorkTasks scope={scope} writer={writer} taskId={undefined} onSelectTask={openTask} />
        ) : surface.view === "team" ? (
          <WorkTeam scope={scope} writer={writer} onOpenTask={openTask} />
        ) : surface.view === "knowledge" ? (
          <WorkKnowledge scope={scope} writer={writer} onOpenTask={openTask} />
        ) : (
          <WorkIntake scope={scope} writer={writer} />
        )}
      </div>
    </ScrollArea>
  );
}
