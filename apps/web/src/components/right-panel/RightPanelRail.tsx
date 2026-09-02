import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useEffect, useRef } from "react";

import type { RightPanelSurfaceAction } from "./rightPanelSurfaceActions";
import {
  RIGHT_PANEL_SHORTCUT_BLOCKING_LAYERS,
  surfaceShortcutActionForKey,
  surfaceShortcutTargetsTypingContext,
} from "./rightPanelShortcuts";

export function RightPanelRail({ actions }: { actions: readonly RightPanelSurfaceAction[] }) {
  const shortcutActionsRef = useRef(actions);
  useEffect(() => {
    shortcutActionsRef.current = actions;
  }, [actions]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const action = surfaceShortcutActionForKey(shortcutActionsRef.current, event);
      if (!action || document.querySelector(RIGHT_PANEL_SHORTCUT_BLOCKING_LAYERS)) return;
      const target = event.target;
      if (target instanceof Element && surfaceShortcutTargetsTypingContext(target)) return;
      event.preventDefault();
      event.stopPropagation();
      action.onClick();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  return (
    <aside
      className="flex h-full w-12 shrink-0 flex-col items-center gap-1 border-l border-border bg-background py-2"
      aria-label="Right sidebar"
      data-right-panel-rail
      data-surface-launcher-keys={actions
        .filter((action) => action.available)
        .map((action) => action.shortcut)
        .join("")}
    >
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1">
        {actions.map((action) => {
          const Icon = action.icon;
          const button = (
            <button
              type="button"
              className={cn(
                "relative flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors",
                action.available
                  ? "cursor-pointer hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
                  : "cursor-not-allowed opacity-35",
              )}
              aria-label={action.label}
              aria-keyshortcuts={action.shortcut}
              disabled={!action.available}
              onClick={action.onClick}
            >
              <Icon className="size-4" />
              {action.badgeCount > 0 ? (
                <span
                  className="absolute top-0.5 right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-[9px] font-semibold tabular-nums text-white"
                  aria-label={`${action.badgeCount} active agents`}
                >
                  {action.badgeCount}
                </span>
              ) : null}
            </button>
          );
          const trigger = action.available ? button : <span tabIndex={0}>{button}</span>;
          return (
            <Tooltip key={action.id}>
              <TooltipTrigger render={trigger} />
              <TooltipPopup side="left">
                <span className="flex flex-col gap-0.5">
                  <span>{action.label}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {action.available
                      ? `${action.description} · ${action.shortcut}`
                      : action.disabledReason}
                  </span>
                </span>
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </aside>
  );
}
