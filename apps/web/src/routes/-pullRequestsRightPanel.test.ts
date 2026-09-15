import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  canTogglePullRequestsPanel,
  dispatchPullRequestsPanelToggleShortcut,
  resolvePullRequestsPanelEnvironment,
  shouldReservePullRequestsNativeControls,
  shouldRenderPullRequestsPanel,
} from "./-pullRequestsRightPanel";

const serverA = EnvironmentId.make("server-a");
const serverB = EnvironmentId.make("server-b");

describe("Pull Requests right-panel route state", () => {
  it("keeps the rail visibility toggle available without a selected pull request", () => {
    expect(canTogglePullRequestsPanel({ panelRefAvailable: true })).toBe(true);
  });

  it("routes the configured visibility shortcut through the available empty rail", () => {
    const toggle = vi.fn();
    const event = {
      preventDefault: vi.fn(),
      repeat: false,
      stopPropagation: vi.fn(),
    };

    expect(
      dispatchPullRequestsPanelToggleShortcut({
        available: canTogglePullRequestsPanel({ panelRefAvailable: true }),
        event,
        onToggle: toggle,
      }),
    ).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(toggle).toHaveBeenCalledOnce();
  });

  it("retains native caption clearance while the open sidebar is only the rail", () => {
    expect(
      shouldReservePullRequestsNativeControls({
        rightPanelOpen: true,
        rightPanelHasActiveSurface: false,
      }),
    ).toBe(true);
    expect(
      shouldReservePullRequestsNativeControls({
        rightPanelOpen: true,
        rightPanelHasActiveSurface: true,
      }),
    ).toBe(false);
  });

  it("keeps an open empty panel mounted after the last tab closes", () => {
    expect(
      shouldRenderPullRequestsPanel({
        isOpen: true,
        panelRefAvailable: true,
      }),
    ).toBe(true);
  });

  it("removes the panel only when the sidebar itself is explicitly hidden", () => {
    expect(
      shouldRenderPullRequestsPanel({
        isOpen: false,
        panelRefAvailable: true,
      }),
    ).toBe(false);
  });

  it("falls back to the list scope instead of the closed pull-request selection", () => {
    expect(
      resolvePullRequestsPanelEnvironment({
        activeSurfaceEnvironmentId: null,
        scopedProjectEnvironmentId: serverB,
        scopedEnvironmentId: serverA,
        capableEnvironmentIds: [serverA],
      }),
    ).toBe(serverB);
  });

  it("uses a stable capable environment for an unscoped empty rail", () => {
    expect(
      resolvePullRequestsPanelEnvironment({
        activeSurfaceEnvironmentId: null,
        scopedProjectEnvironmentId: null,
        scopedEnvironmentId: null,
        capableEnvironmentIds: [serverB, serverA],
      }),
    ).toBe(serverB);
  });
});
