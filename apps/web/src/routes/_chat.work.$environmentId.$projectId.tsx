import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute, type SearchSchemaInput } from "@tanstack/react-router";

import { WorkPage } from "../components/work/WorkPage";
import { validateWorkRouteSearch } from "./-workSearch";

export const Route = createFileRoute("/_chat/work/$environmentId/$projectId")({
  validateSearch: (search: { section?: unknown; taskId?: unknown } & SearchSchemaInput) =>
    validateWorkRouteSearch(search),
  component: WorkRouteView,
});

function WorkRouteView() {
  const { environmentId, projectId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <WorkPage
      // Another project or environment never inherits drafts or selections.
      key={JSON.stringify([environmentId, projectId])}
      environmentId={EnvironmentId.make(environmentId)}
      projectId={ProjectId.make(projectId)}
      search={search}
      onSearchChange={(next) => void navigate({ search: next })}
    />
  );
}
