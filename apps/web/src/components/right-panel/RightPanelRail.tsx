import { ChevronDown } from "lucide-react";
import { type KeyboardEvent, useMemo } from "react";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import type { RightPanelSurfaceAction } from "./rightPanelSurfaceActions";
import { rightPanelRailShortcutAction } from "./rightPanelShortcuts";

function RailAction(props: { action: RightPanelSurfaceAction; onProfile: (id: string) => void }) {
  const { action } = props;
  const label = action.available
    ? `${action.label} (${action.shortcut})`
    : `${action.label}: ${action.disabledReason}`;
  return (
    <div className="relative flex justify-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={label}
              className="relative"
              disabled={!action.available}
              onClick={action.onClick}
              size="icon-sm"
              variant="ghost-muted"
            />
          }
        >
          <action.Icon className="size-4" />
          {action.badgeCount > 0 ? (
            <span
              aria-hidden
              className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-[9px] font-semibold tabular-nums text-white"
            >
              {action.badgeCount}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="left">{label}</TooltipPopup>
      </Tooltip>
      {action.id === "browser" && action.available && (action.profiles?.length ?? 0) > 1 ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                aria-label="Open browser in a profile"
                className="absolute -right-1 -bottom-1 bg-background"
                size="icon-xs"
                variant="ghost-muted"
              />
            }
          >
            <ChevronDown className="size-3" />
          </MenuTrigger>
          <MenuPopup align="end" side="left" sideOffset={6} className="min-w-40 max-w-56">
            {action.profiles?.map((profile) => (
              <MenuItem key={profile.id} onClick={() => props.onProfile(profile.id)}>
                <span className="min-w-0 truncate">{profile.name}</span>
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}
export function RightPanelRail(props: {
  actions: ReadonlyArray<RightPanelSurfaceAction>;
  onAddBrowserInProfile: (id: string) => void;
  topInset?: boolean;
}) {
  const shortcutKeys = useMemo(
    () =>
      props.actions
        .filter((action) => action.available)
        .map((action) => action.shortcut)
        .join(""),
    [props.actions],
  );
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const action = rightPanelRailShortcutAction(
      props.actions,
      event.nativeEvent,
      event.currentTarget.contains(document.activeElement),
    );
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    action.onClick();
  };
  return (
    <div
      aria-label="Open a surface"
      className={cn(
        "flex h-full w-12 flex-col items-center gap-1 py-2 outline-none",
        props.topInset && "pt-[calc(var(--workspace-topbar-height)+--spacing(2))]",
      )}
      data-right-panel-rail
      data-surface-launcher-keys={shortcutKeys}
      onKeyDown={onKeyDown}
      tabIndex={0}
    >
      {props.actions.map((action) => (
        <RailAction action={action} key={action.id} onProfile={props.onAddBrowserInProfile} />
      ))}
    </div>
  );
}
