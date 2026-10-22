import { createFileRoute } from "@tanstack/react-router";

import { ResourcesSettings } from "../components/settings/ResourcesSettings";

function SettingsResourcesRoute() {
  const { thread } = Route.useSearch();
  return <ResourcesSettings thread={thread} />;
}

export const Route = createFileRoute("/settings/resources")({
  // `thread` narrows the selected project to one of its threads' session overlays.
  validateSearch: (raw: Record<string, unknown>): { thread?: string } =>
    typeof raw.thread === "string" && raw.thread.trim() ? { thread: raw.thread } : {},
  component: SettingsResourcesRoute,
});
