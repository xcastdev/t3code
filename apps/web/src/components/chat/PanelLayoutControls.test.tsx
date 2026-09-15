/* @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { canTogglePullRequestsPanel } from "../../routes/-pullRequestsRightPanel";
import { PanelLayoutControls, RightPanelMaximizeControl } from "./PanelLayoutControls";

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

describe("Pull Requests rail visibility control", () => {
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

  it("allows the real visibility control to close an open empty rail", async () => {
    const toggle = vi.fn();
    await act(async () =>
      root.render(
        <PanelLayoutControls
          showTerminalControl={false}
          terminalAvailable={false}
          terminalOpen={false}
          terminalShortcutLabel={null}
          rightPanelAvailable={canTogglePullRequestsPanel({ panelRefAvailable: true })}
          rightPanelOpen
          rightPanelShortcutLabel={null}
          liveAgentCount={0}
          onToggleTerminal={() => undefined}
          onToggleRightPanel={toggle}
        />,
      ),
    );

    const control = host.querySelector<HTMLButtonElement>('[aria-label="Toggle right panel"]')!;
    expect(control.disabled).toBe(false);
    await act(async () => control.click());
    expect(toggle).toHaveBeenCalledOnce();
  });
});
