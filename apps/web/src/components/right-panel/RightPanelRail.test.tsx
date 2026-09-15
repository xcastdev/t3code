import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { RightPanelRail } from "./RightPanelRail";
import { buildRightPanelSurfaceActions } from "./rightPanelSurfaceActions";

const noop = () => undefined;
const actionInput = {
  browserProfiles: [
    { id: "work", name: "Work" },
    { id: "personal", name: "Personal" },
  ],
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
} as const;
describe("RightPanelRail", () => {
  it("does not expose the browser profile chooser while Browser is unavailable", () => {
    const html = renderToStaticMarkup(
      <RightPanelRail
        actions={buildRightPanelSurfaceActions(actionInput)}
        onAddBrowserInProfile={noop}
      />,
    );
    expect(html).not.toContain("Open browser in a profile");
  });
});
