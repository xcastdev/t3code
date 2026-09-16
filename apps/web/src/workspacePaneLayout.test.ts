// @effect-diagnostics nodeBuiltinImport:off - this regression reads the shipped CSS contract.
import * as NodeFSP from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import chatViewSource from "./components/ChatView.tsx?raw";
import rightPanelTabsSource from "./components/RightPanelTabs.tsx?raw";
import secondaryPaneTabsSource from "./components/workspace/SecondaryPaneTabs.tsx?raw";
import { toggleVariants } from "./components/ui/toggle";

import {
  getSecondaryPaneLayoutMode,
  getSecondaryPaneMaxWidth,
  getWorkspacePaneFlexDirection,
  resolveWorkspaceGlobalControlsButtonCount,
  resolveWorkspaceHeaderRightInsetMode,
  resolveWorkspacePanelControlsOwner,
  resolveWorkspaceTitlebarOwner,
  shouldReserveWorkspaceGlobalControls,
  shouldAlignHeaderControlsWithRightPanelRail,
} from "./workspacePaneLayout";

describe("workspacePaneLayout", () => {
  it("matches the responsive Toggle geometry for fixed titlebar controls", async () => {
    // `size=sm` is 32px below `sm` and 28px at and above it. The titlebar
    // reservation must follow the same breakpoint, not a desktop-only token.
    expect(toggleVariants({ size: "sm" })).toContain("h-8 min-w-8");
    expect(toggleVariants({ size: "sm" })).toContain("sm:h-7 sm:min-w-7");

    const requiredWidth = (buttons: number, controlSize: number, rightInset = 13) =>
      buttons * controlSize + (buttons - 1) * 4 + rightInset;
    expect(requiredWidth(2, 28)).toBe(73);
    expect(requiredWidth(4, 28)).toBe(137);
    expect(requiredWidth(2, 32)).toBe(81);
    expect(requiredWidth(4, 32)).toBe(153);

    const controlSizeAtViewport = (width: number) => (width < 640 ? 32 : 28);
    expect(controlSizeAtViewport(639)).toBe(32);
    expect(controlSizeAtViewport(639.5)).toBe(32);
    expect(controlSizeAtViewport(640)).toBe(28);

    const productionCss = await NodeFSP.readFile(new URL("./index.css", import.meta.url), "utf8");
    expect(productionCss).toContain("@media (width < 40rem)");
    expect(productionCss).not.toContain("@media (max-width: 639px)");
    expect(productionCss).toContain("--workspace-global-controls-cluster-width");
    expect(productionCss).toContain(
      "var(--workspace-global-controls-cluster-width) + var(--workspace-controls-right) + 1px",
    );
  });

  it("keeps fixed no-drag masks to the controls cluster rather than its edge-inclusive header reservation", () => {
    const maskGeometry =
      "right-[calc(var(--workspace-controls-right)+1px)] h-[var(--workspace-topbar-height)] w-[var(--workspace-global-controls-cluster-width)]";

    for (const source of [chatViewSource, secondaryPaneTabsSource, rightPanelTabsSource]) {
      expect(source).toContain(maskGeometry);
    }
  });

  it("assigns one controls host when an inline secondary pane shares an empty right rail", () => {
    expect(
      resolveWorkspacePanelControlsOwner({
        titlebarOwner: "secondary",
        rightPanelControlsAtRoot: true,
        rightPanelControlsInPanel: false,
      }),
    ).toBe("secondary");
    expect(
      resolveWorkspacePanelControlsOwner({
        titlebarOwner: "chat",
        rightPanelControlsAtRoot: true,
        rightPanelControlsInPanel: false,
      }),
    ).toBe("right-panel");
    expect(
      resolveWorkspacePanelControlsOwner({
        titlebarOwner: "chat",
        rightPanelControlsAtRoot: false,
        rightPanelControlsInPanel: true,
      }),
    ).toBe("sheet");
  });

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
        secondaryPaneLayout: "stack",
        rightPanelOpen: true,
        rightPanelHasActiveSurface: false,
        rightPanelUsesSheet: false,
      }),
    ).toBe("chat");
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

  it("transfers desktop titlebar ownership to a maximized stacked secondary pane", () => {
    expect(
      resolveWorkspaceTitlebarOwner({
        secondaryPaneOpen: true,
        secondaryPaneLayout: "stack",
        secondaryPaneMaximized: true,
        rightPanelOpen: false,
        rightPanelHasActiveSurface: false,
        rightPanelUsesSheet: false,
      }),
    ).toBe("secondary");
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

  it("reserves fixed controls in the titlebar they cover, even when another component hosts them", () => {
    expect(
      shouldReserveWorkspaceGlobalControls({
        titlebarOwner: "chat",
        controlsOwner: "right-panel",
        owner: "chat",
      }),
    ).toBe(true);
    expect(
      shouldReserveWorkspaceGlobalControls({
        titlebarOwner: "secondary",
        controlsOwner: "secondary",
        owner: "secondary",
      }),
    ).toBe(true);
    expect(
      shouldReserveWorkspaceGlobalControls({
        titlebarOwner: "right-panel",
        controlsOwner: "right-panel",
        owner: "right-panel",
      }),
    ).toBe(true);
    expect(
      shouldReserveWorkspaceGlobalControls({
        titlebarOwner: "chat",
        controlsOwner: "sheet",
        owner: "chat",
      }),
    ).toBe(false);
  });

  it("counts the controls that share the fixed reservation", () => {
    expect(
      resolveWorkspaceGlobalControlsButtonCount({
        showTerminalControl: true,
        secondaryPanePresentation: null,
        rightPanelMaximizeVisible: false,
      }),
    ).toBe(2);
    expect(
      resolveWorkspaceGlobalControlsButtonCount({
        showTerminalControl: true,
        secondaryPanePresentation: "minimized",
        rightPanelMaximizeVisible: false,
      }),
    ).toBe(3);
    expect(
      resolveWorkspaceGlobalControlsButtonCount({
        showTerminalControl: true,
        secondaryPanePresentation: "expanded",
        rightPanelMaximizeVisible: false,
      }),
    ).toBe(4);
    expect(
      resolveWorkspaceGlobalControlsButtonCount({
        showTerminalControl: true,
        secondaryPanePresentation: "expanded",
        rightPanelMaximizeVisible: true,
      }),
    ).toBe(5);
  });
});
