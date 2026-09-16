export type WorkspaceTitlebarOwner = "chat" | "secondary" | "right-panel";
export type WorkspacePanelControlsOwner = "chat" | "secondary" | "right-panel" | "sheet";
export type SecondaryPaneLayoutMode = "inline" | "stack";
export type WorkspaceHeaderRightInsetMode = "default" | "right-panel-control" | "native-controls";
export type WorkspacePaneFlexDirection = "flex-row" | "flex-col";

export type SecondaryPaneControlsPresentation = "expanded" | "minimized" | "maximized";

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
  secondaryPaneLayout?: SecondaryPaneLayoutMode;
  secondaryPaneMaximized?: boolean;
  rightPanelOpen: boolean;
  rightPanelHasActiveSurface: boolean;
  rightPanelUsesSheet: boolean;
}): WorkspaceTitlebarOwner {
  if (
    input.secondaryPaneOpen &&
    input.secondaryPaneLayout === "stack" &&
    input.secondaryPaneMaximized
  ) {
    return "secondary";
  }
  if (input.rightPanelOpen && input.rightPanelHasActiveSurface && !input.rightPanelUsesSheet) {
    return "right-panel";
  }
  if (input.secondaryPaneOpen && input.secondaryPaneLayout !== "stack") {
    return "secondary";
  }
  return "chat";
}

/** The controls are rendered exactly once, in the header that owns their geometry. */
export function resolveWorkspacePanelControlsOwner(input: {
  titlebarOwner: WorkspaceTitlebarOwner;
  rightPanelControlsAtRoot: boolean;
  rightPanelControlsInPanel: boolean;
}): WorkspacePanelControlsOwner {
  if (input.rightPanelControlsInPanel) return "sheet";
  if (input.titlebarOwner === "secondary") return "secondary";
  if (input.rightPanelControlsAtRoot) return "right-panel";
  return "chat";
}

/**
 * Fixed controls cover the titlebar owner, which can differ from the component
 * that renders them. An empty right rail hosts the controls over chat, for example.
 */
export function shouldReserveWorkspaceGlobalControls(input: {
  titlebarOwner: WorkspaceTitlebarOwner;
  controlsOwner: WorkspacePanelControlsOwner;
  owner: Exclude<WorkspacePanelControlsOwner, "sheet">;
}): boolean {
  return input.controlsOwner !== "sheet" && input.titlebarOwner === input.owner;
}

/**
 * The fixed titlebar group and the header it covers share this count. The
 * CSS contract derives the exact responsive footprint from it, including the
 * viewport-right inset and the fixed group's one-pixel margin.
 */
export function resolveWorkspaceGlobalControlsButtonCount(input: {
  showTerminalControl: boolean;
  secondaryPanePresentation: SecondaryPaneControlsPresentation | null;
  rightPanelMaximizeVisible: boolean;
}): number {
  return (
    // The right-panel toggle is always visible, even when unavailable.
    1 +
    (input.showTerminalControl ? 1 : 0) +
    (input.secondaryPanePresentation === null
      ? 0
      : input.secondaryPanePresentation === "minimized"
        ? 1
        : 2) +
    (input.rightPanelMaximizeVisible ? 1 : 0)
  );
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
