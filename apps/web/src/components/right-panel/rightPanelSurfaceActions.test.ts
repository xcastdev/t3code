import { describe, expect, it, vi } from "vite-plus/test";

import { createRightPanelSurfaceActions } from "./rightPanelSurfaceActions";

function makeActions(
  overrides: Partial<Parameters<typeof createRightPanelSurfaceActions>[0]> = {},
) {
  const onClick = vi.fn();
  const callbacks = {
    onAddBrowser: onClick,
    onAddTerminal: onClick,
    onAddDiff: onClick,
    onAddFiles: onClick,
    onAddPullRequest: onClick,
    onAddAgents: onClick,
  };
  return createRightPanelSurfaceActions({
    browserAvailable: true,
    terminalAvailable: true,
    diffAvailable: true,
    filesAvailable: true,
    pullRequestAvailable: true,
    agentsAvailable: true,
    liveAgentCount: 0,
    ...callbacks,
    ...overrides,
  });
}

describe("rightPanelSurfaceActions", () => {
  it("keeps rail and plus-menu labels in one ordered registry", () => {
    expect(makeActions().map((action) => action.label)).toEqual([
      "Browser",
      "Terminal",
      "Project Explorer",
      "Diff",
      "Pull request",
      "Agents",
    ]);
    expect(makeActions().map((action) => action.shortcut)).toEqual(["B", "T", "F", "D", "P", "A"]);
  });

  it("preserves availability explanations and live-agent badges", () => {
    const actions = makeActions({
      filesAvailable: false,
      liveAgentCount: 3,
    });
    const files = actions.find((action) => action.id === "files");
    const agents = actions.find((action) => action.id === "agents");

    expect(files).toMatchObject({
      available: false,
      disabledReason: "Project Explorer is only available when a project is open.",
    });
    expect(agents).toMatchObject({ available: true, badgeCount: 3 });
  });
});
