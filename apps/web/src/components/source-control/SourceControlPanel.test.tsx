import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { SourceControlPanelContent } from "./SourceControlPanel";

describe("SourceControlPanel", () => {
  it("renders the Changes and Pull requests views", () => {
    const html = renderToStaticMarkup(
      <SourceControlPanelContent
        view="changes"
        onViewChange={vi.fn()}
        changes={<div>changed files</div>}
        pullRequests={<div>open pull requests</div>}
      />,
    );

    expect(html).toContain("Source Control");
    expect(html).toContain("Changes");
    expect(html).toContain("Pull requests");
    expect(html).toContain("changed files");
    expect(html).not.toContain("open pull requests");
  });

  it("renders pull requests when that view is selected", () => {
    const html = renderToStaticMarkup(
      <SourceControlPanelContent
        view="pull-requests"
        onViewChange={vi.fn()}
        changes={<div>changed files</div>}
        pullRequests={<div>open pull requests</div>}
      />,
    );

    expect(html).toContain('data-source-control-view="pull-requests"');
    expect(html).toContain("open pull requests");
    expect(html).not.toContain("changed files");
  });
});
