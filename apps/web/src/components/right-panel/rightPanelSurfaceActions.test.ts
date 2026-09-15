import { describe, expect, it } from "vite-plus/test";
import { buildRightPanelSurfaceActions } from "./rightPanelSurfaceActions";
const noop = () => undefined;
describe("buildRightPanelSurfaceActions", () => {
  it("orders direct actions and keeps Diff out of the rail", () => {
    const actions = buildRightPanelSurfaceActions({
      browserProfiles: [{ id: "work", name: "Work" }],
      sourceControlProviderName: "GitHub",
      availability: {
        browser: true,
        files: true,
        "source-control": true,
        agents: true,
        "pull-request": true,
        "pull-requests": true,
        device: true,
      },
      onAddBrowser: noop,
      onAddBrowserInProfile: noop,
      onAddFiles: noop,
      onAddSourceControl: noop,
      onAddAgents: noop,
      onAddPullRequest: noop,
      onAddPullRequests: noop,
      onAddDevice: noop,
      liveAgentCount: 0,
    });
    expect(actions.map((action) => action.label)).toEqual([
      "Browser",
      "Files",
      "GitHub",
      "Agents",
      "Pull Request",
      "Linked Pull Requests",
      "Device",
    ]);
    expect(actions[0]?.profiles).toEqual([{ id: "work", name: "Work" }]);
  });
  it("falls back to Source Control without provider status", () => {
    const actions = buildRightPanelSurfaceActions({
      browserProfiles: [],
      sourceControlProviderName: null,
      availability: {
        browser: false,
        files: false,
        "source-control": false,
        agents: false,
        "pull-request": false,
        "pull-requests": false,
        device: false,
      },
      onAddBrowser: noop,
      onAddBrowserInProfile: noop,
      onAddFiles: noop,
      onAddSourceControl: noop,
      onAddAgents: noop,
      onAddPullRequest: noop,
      onAddPullRequests: noop,
      onAddDevice: noop,
      liveAgentCount: 0,
    });
    expect(actions[2]?.label).toBe("Source Control");
  });
});
