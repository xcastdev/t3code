import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ProjectTerminalsPage } from "../components/projectTerminals/ProjectTerminalsPage";

export const Route = createFileRoute("/_chat/terminals/$environmentId/$projectId")({
  validateSearch: (raw: Record<string, unknown>): { terminal?: string } =>
    typeof raw.terminal === "string" && raw.terminal.trim() ? { terminal: raw.terminal } : {},
  component: ProjectTerminalsRouteView,
});

function ProjectTerminalsRouteView() {
  const { environmentId, projectId } = Route.useParams();
  const { terminal } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ProjectTerminalsPage
      key={JSON.stringify([environmentId, projectId])}
      environmentId={EnvironmentId.make(environmentId)}
      projectId={ProjectId.make(projectId)}
      terminalId={terminal}
      onSelectTerminal={(next) =>
        void navigate({ search: next === undefined ? {} : { terminal: next }, replace: true })
      }
    />
  );
}
