/* @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RightPanelMaximizeControl } from "./PanelLayoutControls";

describe("RightPanelMaximizeControl", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

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

  it("does not offer maximize when the visible panel is only the rail", async () => {
    await act(async () =>
      root.render(
        <RightPanelMaximizeControl
          available={false}
          maximized={false}
          onToggle={() => undefined}
        />,
      ),
    );

    expect(host.querySelector('[aria-label="Maximize panel"]')).toBeNull();
  });
});
