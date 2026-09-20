import { createFileRoute, redirect } from "@tanstack/react-router";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { WorkPage } from "../components/work/WorkPage";

export const Route = createFileRoute("/work/$environmentId/$projectId")({
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
  return (
    <WorkPage
      key={`${environmentId}:${projectId}:0`}
      environmentId={EnvironmentId.make(environmentId)}
      projectId={ProjectId.make(projectId)}
    />
  );
}
