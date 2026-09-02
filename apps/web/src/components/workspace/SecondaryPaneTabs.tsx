import type { ContextMenuItem } from "@t3tools/contracts";
import { ScrollArea } from "~/components/ui/scroll-area";
import { PanelTabCloseButton } from "~/components/ui/panel-tab-close-button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { FileCode2 } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { SecondaryPaneSurface } from "../../secondaryPaneStore";

function surfaceTitle(surface: SecondaryPaneSurface): string {
  return surface.relativePath.split("/").at(-1) ?? surface.relativePath;
}

type SecondaryPaneTabContextMenuAction =
  | "copy-path"
  | "close"
  | "close-others"
  | "close-to-right"
  | "close-all";

export function SecondaryPaneTabs(props: {
  className?: string;
  surfaces: readonly SecondaryPaneSurface[];
  activeSurfaceId: string | null;
  onActivate: (surface: SecondaryPaneSurface) => void;
  onClose: (surface: SecondaryPaneSurface) => void;
  onCloseOtherSurfaces: (surface: SecondaryPaneSurface) => void;
  onCloseSurfacesToRight: (surface: SecondaryPaneSurface) => void;
  onCloseAllSurfaces: () => void;
  onCopyPath: (relativePath: string) => void;
}) {
  const handleContextMenu = async (event: ReactMouseEvent, surface: SecondaryPaneSurface) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readLocalApi();
    if (!api) return;
    const index = props.surfaces.findIndex((entry) => entry.id === surface.id);
    if (index < 0) return;

    const items: ContextMenuItem<SecondaryPaneTabContextMenuAction>[] = [
      { id: "copy-path", label: "Copy path" },
      { id: "close", label: "Close" },
      { id: "close-others", label: "Close others", disabled: props.surfaces.length <= 1 },
      {
        id: "close-to-right",
        label: "Close to the right",
        disabled: index >= props.surfaces.length - 1,
      },
      { id: "close-all", label: "Close all", disabled: props.surfaces.length === 0 },
    ];
    const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
    switch (action) {
      case "copy-path":
        props.onCopyPath(surface.relativePath);
        break;
      case "close":
        props.onClose(surface);
        break;
      case "close-others":
        props.onCloseOtherSurfaces(surface);
        break;
      case "close-to-right":
        props.onCloseSurfacesToRight(surface);
        break;
      case "close-all":
        props.onCloseAllSurfaces();
        break;
      case null:
        break;
    }
  };

  return (
    <div
      className={cn(
        "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] min-w-0 shrink-0 items-center border-b border-border/60 px-2",
        props.className,
      )}
      data-secondary-pane-tabbar
      role="tablist"
      aria-label="Open files"
    >
      <ScrollArea hideScrollbars scrollFade className="min-w-0 flex-1 rounded-none">
        <div className="flex h-full w-max min-w-full items-center gap-1">
          {props.surfaces.map((surface) => {
            const active = surface.id === props.activeSurfaceId;
            const title = surfaceTitle(surface);
            return (
              <div
                key={surface.id}
                onContextMenu={(event) => void handleContextMenu(event, surface)}
                className={cn(
                  "group/tab flex h-6 max-w-52 shrink-0 items-center gap-0.5 rounded-md pr-1 pl-1.5 text-xs",
                  active
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
                data-active-tab={active}
              >
                <PanelTabCloseButton
                  label={`Close ${surface.relativePath}`}
                  onClick={() => props.onClose(surface)}
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
                        onClick={() => props.onActivate(surface)}
                      />
                    }
                  >
                    <FileCode2 className="mr-1 size-3 shrink-0" aria-hidden />
                    <span className="truncate">{title}</span>
                  </TooltipTrigger>
                  <TooltipPopup>{surface.relativePath}</TooltipPopup>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
