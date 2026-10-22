import { AssistantId, EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, type SearchSchemaInput } from "@tanstack/react-router";

import { AgentDetailPage } from "../components/assistants/AgentDetailPage";
import { validateAgentRouteSearch } from "./-agentsSearch";

export const Route = createFileRoute("/_chat/agents/$environmentId/$assistantId")({
  validateSearch: (search: { section?: unknown } & SearchSchemaInput) =>
    validateAgentRouteSearch(search),
  component: AgentRouteView,
});

function AgentRouteView() {
  const { environmentId, assistantId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AgentDetailPage
      // Another environment's agent with the same ID never inherits drafts.
      key={JSON.stringify([environmentId, assistantId])}
      environmentId={EnvironmentId.make(environmentId)}
      assistantId={AssistantId.make(assistantId)}
      section={search.section}
      onSectionChange={(section) => void navigate({ search: { section } })}
    />
  );
}
