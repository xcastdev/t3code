import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolvePullRequestsPanelEnvironment,
  shouldRenderPullRequestsPanel,
} from "./pullRequestsRightPanel";

const serverA = EnvironmentId.make("server-a");
const serverB = EnvironmentId.make("server-b");

describe("Pull Requests right-panel route state", () => {
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
