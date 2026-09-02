import { describe, expect, it } from "vite-plus/test";

import {
  getSecondaryPaneLayoutMode,
  getSecondaryPaneMaxWidth,
  resolveWorkspaceTitlebarOwner,
} from "./workspacePaneLayout";

describe("workspacePaneLayout", () => {
  it("preserves the chat minimum when calculating the editor maximum", () => {
    expect(getSecondaryPaneMaxWidth(1200)).toBe(840);
    expect(getSecondaryPaneMaxWidth(500)).toBe(420);
  });

  it("stacks the editor at the compact workspace breakpoint", () => {
    expect(getSecondaryPaneLayoutMode(760)).toBe("stack");
    expect(getSecondaryPaneLayoutMode(761)).toBe("inline");
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
});
