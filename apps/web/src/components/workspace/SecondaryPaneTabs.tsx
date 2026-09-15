import { FileCode2 } from "lucide-react";

import { PanelTabCloseButton } from "~/components/ui/panel-tab-close-button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import type { SecondaryPaneSurface } from "../../secondaryPaneStore";

function title(surface: SecondaryPaneSurface) {
  return surface.relativePath.split("/").at(-1) ?? surface.relativePath;
}

/** Lightweight editor tabs. Context menus stay in the existing right-panel tabs;
 * this pane only owns file selection and close, keeping it cheap to mount. */
export function SecondaryPaneTabs(props: {
  surfaces: readonly SecondaryPaneSurface[];
  activeSurfaceId: string | null;
  onActivate: (surfaceId: string) => void;
  onClose: (surfaceId: string) => void;
}) {
  return (
    <div
      className="flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] min-w-0 shrink-0 items-center border-b border-border/60 px-2"
      data-secondary-pane-tabbar
      role="tablist"
      aria-label="Open files"
    >
      <ScrollArea hideScrollbars scrollFade className="min-w-0 flex-1 rounded-none">
        <div className="flex h-full w-max min-w-full items-center gap-1">
          {props.surfaces.map((surface) => {
            const active = surface.id === props.activeSurfaceId;
            return (
              <div
                key={surface.id}
                className={cn(
                  "group/tab flex h-6 max-w-52 shrink-0 items-center gap-0.5 rounded-md pr-1 pl-1.5 text-xs",
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
    </div>
  );
}
