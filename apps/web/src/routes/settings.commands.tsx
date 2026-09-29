import { createFileRoute } from "@tanstack/react-router";

import { ManagedTextResourcesSettings } from "../features/managedTextResources/ManagedTextResourcesSettings";
import { parseResourceTarget } from "../features/resources/resourceTarget";

export const Route = createFileRoute("/settings/commands")({
  component: CommandsSettingsRoute,
});

function CommandsSettingsRoute() {
  const { resource } = Route.useSearch();
  const target = parseResourceTarget(resource);
  return (
    <ManagedTextResourcesSettings
      resourceTarget={target?.kind === "command" || target?.kind === "snippet" ? target : null}
    />
  );
}
