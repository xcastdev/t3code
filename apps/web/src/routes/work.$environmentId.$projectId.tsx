import { createFileRoute, redirect, type SearchSchemaInput } from "@tanstack/react-router";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { WorkPage } from "../components/work/WorkPage";
import { validateWorkRouteSearch } from "./-workSearch";

export const Route = createFileRoute("/work/$environmentId/$projectId")({
  validateSearch: (search: { tab?: unknown; taskId?: unknown } & SearchSchemaInput) =>
    validateWorkRouteSearch(search),
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: WorkRouteView,
});

function WorkRouteView() {
  const { environmentId, projectId } = Route.useParams();
  const selection = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <WorkPage
      key={`${environmentId}:${projectId}:0`}
      environmentId={EnvironmentId.make(environmentId)}
      projectId={ProjectId.make(projectId)}
      selection={selection}
      onSelectionChange={(search) => {
        void navigate({ search });
      }}
    />
  );
}
