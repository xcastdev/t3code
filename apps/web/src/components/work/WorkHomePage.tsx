import { useNavigate } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { WorkPortfolio } from "./WorkPortfolio";

/** Work across every connected project; each project and task opens as its own page. */
export function WorkHomePage() {
  const navigate = useNavigate();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Work breadcrumb" className="min-w-0 flex-1">
            <WorkspaceBreadcrumbItem current>
              <h1>Work</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded" className="@container/work gap-6">
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
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
