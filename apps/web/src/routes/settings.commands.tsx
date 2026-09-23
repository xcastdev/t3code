import { createFileRoute } from "@tanstack/react-router";

import { ManagedTextResourcesSettings } from "../features/managedTextResources/ManagedTextResourcesSettings";

export const Route = createFileRoute("/settings/commands")({
  component: ManagedTextResourcesSettings,
});
