import {
  Maximize2Icon,
  Minimize2Icon,
  PanelBottomIcon,
  PanelRightCloseIcon,
  PanelRightIcon,
} from "lucide-react";
import { memo } from "react";

import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface PanelLayoutControlsProps {
  showTerminalControl?: boolean;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalShortcutLabel: string | null;
  rightPanelAvailable: boolean;
  rightPanelOpen: boolean;
  rightPanelShortcutLabel: string | null;
  rightPanelUnavailableLabel?: string;
  /** Running + waiting subagents in this thread; badges the right panel toggle. */
  liveAgentCount: number;
  /** Secondary-pane presentation is owned by the thread-scoped pane store. */
  secondaryPane?: {
    presentation: "expanded" | "minimized" | "maximized";
    canMaximize: boolean;
    onMinimize: () => void;
    onRestore: () => void;
    onToggleMaximize: () => void;
  };
  onToggleTerminal: () => void;
  onToggleRightPanel: () => void;
}

export const PanelLayoutControls = memo(function PanelLayoutControls({
  showTerminalControl = true,
  terminalAvailable,
  terminalOpen,
  terminalShortcutLabel,
  rightPanelAvailable,
  rightPanelOpen,
  rightPanelShortcutLabel,
  rightPanelUnavailableLabel = "Right panel is unavailable",
  liveAgentCount,
  secondaryPane,
  onToggleTerminal,
  onToggleRightPanel,
}: PanelLayoutControlsProps) {
  return (
    <div
      className="flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
      data-panel-layout-controls
    >
      {secondaryPane?.presentation === "minimized" ? (
        <SecondaryPaneRestoreControl onRestore={secondaryPane.onRestore} />
      ) : secondaryPane ? (
        <>
          <SecondaryPaneMinimizeControl onMinimize={secondaryPane.onMinimize} />
          <SecondaryPaneMaximizeControl
            available={secondaryPane.canMaximize}
            maximized={secondaryPane.presentation === "maximized"}
            onToggle={secondaryPane.onToggleMaximize}
          />
        </>
      ) : null}
      {showTerminalControl ? (
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={terminalOpen}
              onPressedChange={onToggleTerminal}
              aria-label="Toggle terminal drawer"
              variant="ghost"
              size="sm"
              disabled={!terminalAvailable}
            >
              <PanelBottomIcon className="size-4" />
            </Toggle>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {terminalAvailable
              ? `Toggle terminal drawer${terminalShortcutLabel ? ` (${terminalShortcutLabel})` : ""}`
              : "Terminal drawer is unavailable"}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger render={<span className="flex shrink-0" />}>
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={rightPanelOpen}
            onPressedChange={onToggleRightPanel}
            aria-label={
              liveAgentCount > 0
                ? `Toggle right panel, ${liveAgentCount} ${liveAgentCount === 1 ? "agent" : "agents"} working`
                : "Toggle right panel"
            }
            variant="ghost"
            size="sm"
            disabled={!rightPanelAvailable}
          >
            <PanelRightIcon className="size-4" />
            {liveAgentCount > 0 ? (
              <span
                aria-hidden
                className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-[9px] font-semibold tabular-nums text-white"
              >
                {liveAgentCount}
              </span>
            ) : null}
          </Toggle>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {rightPanelAvailable
            ? `Toggle right panel${rightPanelShortcutLabel ? ` (${rightPanelShortcutLabel})` : ""}${
                liveAgentCount > 0
                  ? ` · ${liveAgentCount} ${liveAgentCount === 1 ? "agent" : "agents"} working`
                  : ""
              }`
            : rightPanelUnavailableLabel}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});

export const RightPanelMaximizeControl = memo(function RightPanelMaximizeControl({
  available = true,
  maximized,
  onToggle,
}: {
  available?: boolean;
  maximized: boolean;
  onToggle: () => void;
}) {
  if (!available) return null;
  const label = maximized ? "Restore panel size" : "Maximize panel";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={maximized}
            onPressedChange={onToggle}
            aria-label={label}
            variant="ghost"
            size="sm"
          >
            {maximized ? (
              <Minimize2Icon className="size-4" />
            ) : (
              <Maximize2Icon className="size-4" />
            )}
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});

export const SecondaryPaneMinimizeControl = memo(function SecondaryPaneMinimizeControl({
  available = true,
  onMinimize,
}: {
  available?: boolean;
  onMinimize: () => void;
}) {
  if (!available) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={false}
            onPressedChange={onMinimize}
            aria-label="Minimize secondary pane"
            variant="ghost"
            size="sm"
          >
            <PanelRightCloseIcon className="size-4" />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">Minimize secondary pane</TooltipPopup>
    </Tooltip>
  );
});

export const SecondaryPaneRestoreControl = memo(function SecondaryPaneRestoreControl({
  available = true,
  onRestore,
}: {
  available?: boolean;
  onRestore: () => void;
}) {
  if (!available) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed
            onPressedChange={onRestore}
            aria-label="Restore secondary pane"
            variant="ghost"
            size="sm"
          >
            <PanelRightIcon className="size-4" />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">Restore secondary pane</TooltipPopup>
    </Tooltip>
  );
});

export const SecondaryPaneMaximizeControl = memo(function SecondaryPaneMaximizeControl({
  available = true,
  maximized,
  onToggle,
}: {
  available?: boolean;
  maximized: boolean;
  onToggle: () => void;
}) {
  if (!available) return null;
  const label = maximized ? "Restore secondary pane size" : "Maximize secondary pane";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={maximized}
            onPressedChange={onToggle}
            aria-label={label}
            variant="ghost"
            size="sm"
          >
            {maximized ? (
              <Minimize2Icon className="size-4" />
            ) : (
              <Maximize2Icon className="size-4" />
            )}
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});
