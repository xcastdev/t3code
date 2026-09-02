import { describe, expect, it } from "vite-plus/test";

import { resolvePanelControlsPlacement, secondaryPaneFullscreenLabel } from "./PanelLayoutControls";

describe("resolvePanelControlsPlacement", () => {
  it("prioritizes the right sidebar when both side surfaces are open", () => {
    expect(
      resolvePanelControlsPlacement({ rightPanelExpanded: true, secondaryPaneOpen: true }),
    ).toBe("right-sidebar");
  });

  it("places controls in the secondary pane when no right sidebar surface is expanded", () => {
    expect(
      resolvePanelControlsPlacement({ rightPanelExpanded: false, secondaryPaneOpen: true }),
    ).toBe("secondary-pane");
  });

  it("falls back to the chat header when neither side surface is open", () => {
    expect(
      resolvePanelControlsPlacement({ rightPanelExpanded: false, secondaryPaneOpen: false }),
    ).toBe("chat-header");
  });
});

describe("PanelLayoutControls", () => {
  it("uses fullscreen language for the secondary pane control", () => {
    expect(secondaryPaneFullscreenLabel(false)).toBe("Enter fullscreen");
    expect(secondaryPaneFullscreenLabel(true)).toBe("Exit fullscreen");
  });
});
