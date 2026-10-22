import { createFileRoute, type SearchSchemaInput } from "@tanstack/react-router";

import { AgentsPage } from "../components/assistants/AgentsPage";
import { validateAgentsRouteSearch } from "./-agentsSearch";

export const Route = createFileRoute("/_chat/agents/")({
  validateSearch: (search: { archived?: unknown } & SearchSchemaInput) =>
    validateAgentsRouteSearch(search),
  component: AgentsRouteView,
});

function AgentsRouteView() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AgentsPage
      includeArchived={search.archived === true}
      onIncludeArchivedChange={(archived) =>
        void navigate({ search: archived ? { archived: true } : {} })
      }
    />
  );
}
