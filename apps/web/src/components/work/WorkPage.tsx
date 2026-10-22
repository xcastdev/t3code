import { useNavigate } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ProjectWorkScope } from "@t3tools/client-runtime/project-work";
import type { EnvironmentId, ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";

import { isElectron } from "../../env";
import { WORK_SECTIONS, type WorkRouteSearch, type WorkSection } from "../../routes/-workSearch";
import { useAllEnvironmentProjectSnapshotsReady, useProject } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { Badge } from "../ui/badge";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { WorkEmpty } from "./WorkLayout";
import { WorkIntake } from "./WorkIntake";
import { WorkKnowledge } from "./WorkKnowledge";
import { WorkOverview } from "./WorkOverview";
import { WorkPortfolio } from "./WorkPortfolio";
import { WorkTasks } from "./WorkTasks";
import { useWorkWriter } from "./useWorkWriter";

const SECTION_LABELS: Record<WorkSection, string> = {
  overview: "Overview",
  tasks: "Tasks",
  knowledge: "Knowledge",
  intake: "Intake",
  portfolio: "All projects",
};

export function WorkPage({
  environmentId,
  projectId,
  search,
  onSearchChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly search: WorkRouteSearch;
  readonly onSearchChange: (search: WorkRouteSearch) => void;
}) {
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const projectsReady = useAllEnvironmentProjectSnapshotsReady();
  const environment = useEnvironment(environmentId);
  const writer = useWorkWriter(environmentId);
  const navigate = useNavigate();
  const phase = environment?.connection.phase ?? "disconnected";

  const header = (
    <WorkspacePageHeader electron={isElectron}>
      <WorkspaceBreadcrumb ariaLabel="Work breadcrumb" className="min-w-0 flex-1">
        <WorkspaceBreadcrumbItem>
          <h1>Work</h1>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current className="min-w-0">
          <span className="truncate">{project?.title ?? "Project"}</span>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      {environment ? (
        <Badge variant={phase === "connected" ? "secondary" : "warning"} className="shrink-0">
          {environment.label}
          {phase === "connected" ? "" : " · offline"}
        </Badge>
      ) : null}
    </WorkspacePageHeader>
  );

  if (project === null) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
          {header}
          <WorkspacePageContainer>
            <WorkEmpty
              title={projectsReady ? "Project not found" : "Loading project…"}
              {...(projectsReady
                ? { detail: "This project isn't on the selected environment, or it was removed." }
                : {})}
            />
          </WorkspacePageContainer>
        </div>
      </SidebarInset>
    );
  }

  // The checkout path keeps one environment's project apart from a same-named one elsewhere.
  const scope: ProjectWorkScope = { environmentId, projectId, checkoutPath: project.workspaceRoot };
  const section = search.section;
  const openTask = (taskId: ProjectWorkTaskId | undefined) =>
    onSearchChange(taskId === undefined ? { section: "tasks" } : { section: "tasks", taskId });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {header}
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded" className="@container/work gap-5">
            <ToggleGroup
              aria-label="Work sections"
              value={[section]}
              onValueChange={(next) => {
                const value = next[0];
                if (WORK_SECTIONS.some((section) => section === value))
                  onSearchChange({ section: value as WorkSection });
              }}
            >
              {(Object.keys(SECTION_LABELS) as WorkSection[]).map((value) => (
                <Toggle key={value} value={value}>
                  {SECTION_LABELS[value]}
                </Toggle>
              ))}
            </ToggleGroup>
            {section === "overview" ? (
              <WorkOverview scope={scope} writer={writer} onOpenTask={openTask} />
            ) : section === "tasks" ? (
              <WorkTasks
                scope={scope}
                writer={writer}
                taskId={search.taskId}
                onSelectTask={openTask}
              />
            ) : section === "portfolio" ? (
              <WorkPortfolio
                onOpen={(target) =>
                  void navigate({
                    to: "/work/$environmentId/$projectId",
                    params: { environmentId: target.environmentId, projectId: target.projectId },
                    search:
                      target.taskId === undefined
                        ? { section: "overview" }
                        : { section: "tasks", taskId: target.taskId },
                  })
                }
              />
            ) : section === "knowledge" ? (
              <WorkKnowledge scope={scope} writer={writer} />
            ) : (
              <WorkIntake scope={scope} writer={writer} />
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
