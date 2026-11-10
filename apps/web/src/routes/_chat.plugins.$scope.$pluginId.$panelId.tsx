import { createFileRoute } from "@tanstack/react-router";

import { PluginPanelPage } from "../components/plugins/PluginPanelPage";

function PluginPanelRoute() {
  const { scope, pluginId, panelId } = Route.useParams();
  return <PluginPanelPage scope={scope} pluginId={pluginId} panelId={panelId} />;
}

export const Route = createFileRoute("/_chat/plugins/$scope/$pluginId/$panelId")({
  component: PluginPanelRoute,
});
