export type WorkspaceTitlebarOwner = "chat" | "secondary" | "right-panel";
export type SecondaryPaneLayoutMode = "inline" | "stack";

export const SECONDARY_PANE_DEFAULT_WIDTH = 560;
export const SECONDARY_PANE_MIN_WIDTH = 420;
export const WORKSPACE_CHAT_MIN_WIDTH = 360;
export const RIGHT_PANEL_RAIL_WIDTH = 48;
export const SECONDARY_PANE_COMPACT_MEDIA_QUERY = "(max-width: 760px)";

export function getSecondaryPaneLayoutMode(workspaceWidth: number): SecondaryPaneLayoutMode {
  return workspaceWidth <= 760 ? "stack" : "inline";
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
