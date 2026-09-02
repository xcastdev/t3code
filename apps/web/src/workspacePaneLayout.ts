export type WorkspaceTitlebarOwner = "chat" | "secondary" | "right-panel";
export type SecondaryPaneLayoutMode = "inline" | "stack";
export type WorkspaceHeaderRightInsetMode = "default" | "right-panel-control" | "native-controls";
export type WorkspacePaneFlexDirection = "flex-row" | "flex-col";

export const SECONDARY_PANE_DEFAULT_WIDTH = 560;
export const SECONDARY_PANE_MIN_WIDTH = 420;
export const WORKSPACE_CHAT_MIN_WIDTH = 360;
export const RIGHT_PANEL_RAIL_WIDTH = 48;
export const SECONDARY_PANE_COMPACT_MEDIA_QUERY = "(max-width: 760px)";

export function getSecondaryPaneLayoutMode(workspaceWidth: number): SecondaryPaneLayoutMode {
  return workspaceWidth <= 760 ? "stack" : "inline";
}

export function getWorkspacePaneFlexDirection(
  layout: SecondaryPaneLayoutMode,
): WorkspacePaneFlexDirection {
  return layout === "stack" ? "flex-col" : "flex-row";
}

export function getSecondaryPaneMaxWidth(workspaceWidth: number): number {
  return Math.max(
    SECONDARY_PANE_MIN_WIDTH,
    Math.floor(Math.max(0, workspaceWidth) - WORKSPACE_CHAT_MIN_WIDTH),
  );
}

export function resolveWorkspaceTitlebarOwner(input: {
  secondaryPaneOpen: boolean;
  rightPanelOpen: boolean;
  rightPanelHasActiveSurface: boolean;
  rightPanelUsesSheet: boolean;
}): WorkspaceTitlebarOwner {
  if (input.rightPanelOpen && input.rightPanelHasActiveSurface && !input.rightPanelUsesSheet) {
    return "right-panel";
  }
  if (input.secondaryPaneOpen) return "secondary";
  return "chat";
}

export function shouldAlignHeaderControlsWithRightPanelRail(input: {
  rightPanelOpen: boolean;
  rightPanelHasActiveSurface: boolean;
}): boolean {
  return input.rightPanelOpen && !input.rightPanelHasActiveSurface;
}

export function resolveWorkspaceHeaderRightInsetMode(input: {
  rightPanelRailAligned: boolean;
  rightPanelControlInset: boolean;
  reserveNativeControls: boolean;
}): WorkspaceHeaderRightInsetMode {
  if (input.rightPanelRailAligned || input.rightPanelControlInset) {
    return "right-panel-control";
  }
  if (input.reserveNativeControls) return "native-controls";
  return "default";
}
