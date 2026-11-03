import { parsePluginPanelKey, pluginPanelKey } from "@t3tools/client-runtime/plugins/commands";

import { isElectron } from "~/env";
import { usePluginPanelInstall } from "~/plugins/pluginInstalls";
import { useRecentChatTarget } from "~/plugins/recentChat";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { PluginPanelMissing, PluginPanelSurface } from "./PluginPanelSurface";

/** A plugin panel on its own page, for when no chat can dock it. */
export function PluginPanelPage(props: {
  readonly scope: string;
  readonly pluginId: string;
  readonly panelId: string;
}) {
  const parsed = parsePluginPanelKey(`${props.scope}:${props.pluginId}:${props.panelId}`);
  const panelKey =
    parsed === undefined ? null : pluginPanelKey(parsed.scope, parsed.pluginId, parsed.panelId);
  const install = usePluginPanelInstall(panelKey);
  const chatTarget = useRecentChatTarget(props.scope);
  const record =
    install.kind === "client" || install.kind === "environment" ? install.record : null;
  const panelTitle =
    record?.manifest.ui?.panels.find((panel) => panel.id === props.panelId)?.title ?? "Plugin";
  const scopeLabel =
    install.kind === "environment"
      ? install.environmentLabel
      : install.kind === "client"
        ? "On this device"
        : null;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Plugin breadcrumb" className="min-w-0 flex-1">
            <WorkspaceBreadcrumbItem current>
              <h1>{panelTitle}</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          {scopeLabel ? (
            <span className="shrink-0 text-muted-foreground text-xs">{scopeLabel}</span>
          ) : null}
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1">
          {panelKey === null ? (
            <PluginPanelMissing />
          ) : (
            <PluginPanelSurface panelKey={panelKey} chatTarget={chatTarget} />
          )}
        </div>
      </div>
    </SidebarInset>
  );
}
