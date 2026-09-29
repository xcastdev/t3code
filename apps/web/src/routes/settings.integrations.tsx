import { createFileRoute } from "@tanstack/react-router";

import { IntegrationsSettingsPanel } from "../components/settings/IntegrationsSettings";
import { parseResourceTarget } from "../features/resources/resourceTarget";

export const Route = createFileRoute("/settings/integrations")({
  component: IntegrationsRoute,
});

function IntegrationsRoute() {
  const { resource } = Route.useSearch();
  const target = parseResourceTarget(resource);
  return (
    <IntegrationsSettingsPanel
      resourceTarget={target?.kind === "mcp" && target.scope === "environment" ? target : null}
    />
  );
}
