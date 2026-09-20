/* @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { WorkDataNotice } from "./WorkDataNotice";

describe("WorkDataNotice interactions", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("keeps a failed read actionable when a stale view is also available", async () => {
    const retry = vi.fn();
    await act(async () =>
      root.render(
        <WorkDataNotice
          stale
          waiting={false}
          error="The project work read failed."
          onRetry={retry}
        />,
      ),
    );

    expect(host.textContent).toContain("The project work read failed.");
    expect(host.textContent).not.toContain("Showing the last saved view");
    const retryButton = host.querySelector<HTMLButtonElement>("button")!;
    expect(retryButton.textContent).toContain("Retry");
    await act(async () => retryButton.click());
    expect(retry).toHaveBeenCalledOnce();
  });
});
