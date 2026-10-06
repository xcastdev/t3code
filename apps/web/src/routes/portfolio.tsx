import { createFileRoute, redirect } from "@tanstack/react-router";

import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { PortfolioPage } from "../features/projectTeams/PortfolioPage";

export const Route = createFileRoute("/portfolio")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: PortfolioRouteView,
});

function PortfolioRouteView() {
  const navigate = Route.useNavigate();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron} className="border-b border-border">
        <h1 className="text-sm font-medium">Portfolio</h1>
      </WorkspacePageHeader>
      <WorkspacePageContainer width="expanded" className="min-h-0 flex-1 gap-4 overflow-y-auto">
        <PortfolioPage
          onOpenProject={(params) => {
            void navigate({
              to: "/work/$environmentId/$projectId",
              params,
              search: { tab: "supervision" },
            });
          }}
          onOpenTask={({ taskId, ...params }) => {
            void navigate({
              to: "/work/$environmentId/$projectId",
              params,
              search: { tab: "tasks", taskId },
            });
          }}
          onOpenWorker={({ threadId, environmentId }) => {
            void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
          }}
        />
      </WorkspacePageContainer>
    </SidebarInset>
  );
}
