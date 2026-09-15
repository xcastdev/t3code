import { describe, expect, it } from "vite-plus/test";

import {
  getSecondaryPaneLayoutMode,
  getSecondaryPaneMaxWidth,
  getWorkspacePaneFlexDirection,
  resolveWorkspaceHeaderRightInsetMode,
  resolveWorkspaceTitlebarOwner,
  shouldAlignHeaderControlsWithRightPanelRail,
} from "./workspacePaneLayout";

describe("workspacePaneLayout", () => {
  it("preserves the chat minimum when calculating the editor maximum", () => {
    expect(getSecondaryPaneMaxWidth(1200)).toBe(840);
    expect(getSecondaryPaneMaxWidth(500)).toBe(420);
  });

  it("stacks the editor at the compact workspace breakpoint", () => {
    expect(getSecondaryPaneLayoutMode(760)).toBe("stack");
    expect(getSecondaryPaneLayoutMode(761)).toBe("inline");
    expect(getWorkspacePaneFlexDirection("stack")).toBe("flex-col");
    expect(getWorkspacePaneFlexDirection("inline")).toBe("flex-row");
  });

  it("assigns titlebar ownership to the visible expanded pane", () => {
    expect(
      resolveWorkspaceTitlebarOwner({
        secondaryPaneOpen: false,
        rightPanelOpen: false,
        rightPanelHasActiveSurface: false,
        rightPanelUsesSheet: false,
      }),
    ).toBe("chat");
    expect(
      resolveWorkspaceTitlebarOwner({
        secondaryPaneOpen: true,
        rightPanelOpen: true,
        rightPanelHasActiveSurface: false,
        rightPanelUsesSheet: false,
      }),
    ).toBe("secondary");
    expect(
      resolveWorkspaceTitlebarOwner({
        secondaryPaneOpen: true,
        rightPanelOpen: true,
        rightPanelHasActiveSurface: true,
        rightPanelUsesSheet: false,
      }),
    ).toBe("right-panel");
    expect(
      resolveWorkspaceTitlebarOwner({
        secondaryPaneOpen: false,
        rightPanelOpen: true,
        rightPanelHasActiveSurface: true,
        rightPanelUsesSheet: true,
      }),
    ).toBe("chat");
  });

  it("aligns header controls with the rail whenever the right sidebar is empty", () => {
    expect(
      shouldAlignHeaderControlsWithRightPanelRail({
        rightPanelOpen: true,
        rightPanelHasActiveSurface: false,
      }),
    ).toBe(true);
    expect(
      shouldAlignHeaderControlsWithRightPanelRail({
        rightPanelOpen: true,
        rightPanelHasActiveSurface: true,
      }),
    ).toBe(false);
    expect(
      shouldAlignHeaderControlsWithRightPanelRail({
        rightPanelOpen: false,
        rightPanelHasActiveSurface: false,
      }),
    ).toBe(false);
  });

  it("prioritizes the fixed panel-control inset over native titlebar spacing", () => {
    expect(
      resolveWorkspaceHeaderRightInsetMode({
        rightPanelRailAligned: true,
        rightPanelControlInset: false,
        reserveNativeControls: true,
      }),
    ).toBe("right-panel-control");
    expect(
      resolveWorkspaceHeaderRightInsetMode({
        rightPanelRailAligned: false,
        rightPanelControlInset: true,
        reserveNativeControls: true,
      }),
    ).toBe("right-panel-control");
    expect(
      resolveWorkspaceHeaderRightInsetMode({
        rightPanelRailAligned: false,
        rightPanelControlInset: false,
        reserveNativeControls: true,
      }),
    ).toBe("native-controls");
    expect(
      resolveWorkspaceHeaderRightInsetMode({
        rightPanelRailAligned: false,
        rightPanelControlInset: false,
        reserveNativeControls: false,
      }),
    ).toBe("default");
  });
});
