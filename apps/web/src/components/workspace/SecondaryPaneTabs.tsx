import type {
  ContextMenuItem,
  EditorId,
  EnvironmentId,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { FileCode2 } from "lucide-react";
import { useCallback, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import { isElectron } from "~/env";
import { readLocalApi } from "~/localApi";
import { PanelTabCloseButton } from "~/components/ui/panel-tab-close-button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { resolvePathLinkTarget } from "~/terminal-links";
import { useRemoteOpenState } from "~/remoteOpen";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { OpenInPicker } from "../chat/OpenInPicker";
import type { SecondaryPaneSurface } from "../../secondaryPaneStore";

function title(surface: SecondaryPaneSurface) {
  return surface.relativePath.split("/").at(-1) ?? surface.relativePath;
}

type TabContextMenuAction = "copy-path" | "close" | "close-others" | "close-to-right" | "close-all";

type WorkspaceFileHeader = {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
};

function SecondaryPaneOpenInPicker(props: WorkspaceFileHeader) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const remoteOpenState = useRemoteOpenState(props.environmentId);
  if (props.environmentId !== primaryEnvironmentId && remoteOpenState.mode === "local-exec") {
    return null;
  }
  return (
    <OpenInPicker
      environmentId={props.environmentId}
      keybindings={props.keybindings}
      availableEditors={props.availableEditors}
      openInCwd={resolvePathLinkTarget(props.relativePath, props.cwd)}
      compact
      enableShortcut={false}
    />
  );
}

export function SecondaryPaneTabs(props: {
  surfaces: readonly SecondaryPaneSurface[];
  activeSurfaceId: string | null;
  onActivate: (surfaceId: string) => void;
  onClose: (surfaceId: string) => void;
  onCopyFilePath: (relativePath: string) => void;
  onCloseOtherSurfaces: (surfaceId: string) => void;
  onCloseSurfacesToRight: (surfaceId: string) => void;
  onCloseAllSurfaces: () => void;
  workspaceFile?: WorkspaceFileHeader;
  headerControls?: ReactNode;
  layout?: "inline" | "stack";
  maximized?: boolean;
}) {
  const ownsDesktopTitlebar = isElectron && props.layout !== "stack";
  const handleTabContextMenu = useCallback(
    async (event: ReactMouseEvent, surface: SecondaryPaneSurface) => {
      event.preventDefault();
      event.stopPropagation();
      const api = readLocalApi();
      if (!api) return;
      const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;
      const items: ContextMenuItem<TabContextMenuAction>[] = [
        { id: "copy-path", label: "Copy path" },
        { id: "close", label: "Close" },
        { id: "close-others", label: "Close others", disabled: props.surfaces.length <= 1 },
        {
          id: "close-to-right",
          label: "Close to the right",
          disabled: surfaceIndex >= props.surfaces.length - 1,
        },
        { id: "close-all", label: "Close all", disabled: props.surfaces.length === 0 },
      ];
      const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
      switch (action) {
        case "copy-path":
          props.onCopyFilePath(surface.relativePath);
          break;
        case "close":
          props.onClose(surface.id);
          break;
        case "close-others":
          props.onCloseOtherSurfaces(surface.id);
          break;
        case "close-to-right":
          props.onCloseSurfacesToRight(surface.id);
          break;
        case "close-all":
          props.onCloseAllSurfaces();
          break;
        case null:
          break;
      }
    },
    [props],
  );

  return (
    <div
      className={cn(
        "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] min-w-0 shrink-0 items-center border-b border-border/60 px-2",
        ownsDesktopTitlebar && "drag-region wco:pr-[var(--workspace-native-controls-inset)]",
        props.maximized && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
      data-secondary-pane-tabbar
      data-secondary-pane-titlebar-owner={ownsDesktopTitlebar ? "true" : "false"}
      role="tablist"
      aria-label="Open files"
    >
      <ScrollArea
        hideScrollbars
        scrollFade
        className="min-w-0 flex-1 rounded-none"
        data-secondary-pane-tab-list
      >
        <div className="flex h-full w-max min-w-full items-center gap-1">
          {props.surfaces.map((surface) => {
            const active = surface.id === props.activeSurfaceId;
            return (
              <div
                key={surface.id}
                onContextMenu={(event) => void handleTabContextMenu(event, surface)}
                className={cn(
                  "group/tab flex h-6 max-w-52 shrink-0 items-center gap-0.5 rounded-md pr-1 pl-1.5 text-xs",
                  ownsDesktopTitlebar && "[-webkit-app-region:no-drag]",
                  active
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <PanelTabCloseButton
                  label={`Close ${surface.relativePath}`}
                  onClick={() => props.onClose(surface.id)}
                >
                  <span className="flex size-3 items-center justify-center text-[10px]" aria-hidden>
                    ·
                  </span>
                </PanelTabCloseButton>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        className="flex min-w-0 cursor-pointer items-center"
                        role="tab"
                        aria-selected={active}
                        aria-label={surface.relativePath}
                        onClick={() => props.onActivate(surface.id)}
                      />
                    }
                  >
                    <FileCode2 className="mr-1 size-3 shrink-0" aria-hidden />
                    <span className="truncate">{title(surface)}</span>
                  </TooltipTrigger>
                  <TooltipPopup>{surface.relativePath}</TooltipPopup>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </ScrollArea>
      {props.workspaceFile ? (
        <div className="shrink-0 [-webkit-app-region:no-drag]">
          <SecondaryPaneOpenInPicker {...props.workspaceFile} />
        </div>
      ) : null}
      {props.headerControls ? (
        <div className="ml-1 flex h-full shrink-0 items-center [-webkit-app-region:no-drag]">
          {props.headerControls}
        </div>
      ) : null}
      {ownsDesktopTitlebar ? (
        <span
          aria-hidden
          className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] h-[var(--workspace-topbar-height)] w-28 [-webkit-app-region:no-drag]"
        />
      ) : null}
    </div>
  );
}
