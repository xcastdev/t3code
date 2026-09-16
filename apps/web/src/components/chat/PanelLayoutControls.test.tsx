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

describe("secondary pane global controls", () => {
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

  it("places secondary minimize and maximize immediately before the bottom dock control", async () => {
    await act(async () =>
      root.render(
        <PanelLayoutControls
          terminalAvailable
          terminalOpen={false}
          terminalShortcutLabel={null}
          rightPanelAvailable
          rightPanelOpen={false}
          rightPanelShortcutLabel={null}
          liveAgentCount={0}
          secondaryPane={{
            presentation: "expanded",
            canMaximize: true,
            onMinimize: () => undefined,
            onRestore: () => undefined,
            onToggleMaximize: () => undefined,
          }}
          onToggleTerminal={() => undefined}
          onToggleRightPanel={() => undefined}
        />,
      ),
    );

    expect(
      [...host.querySelectorAll<HTMLButtonElement>("button")].map((control) =>
        control.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Minimize secondary pane",
      "Maximize secondary pane",
      "Toggle terminal drawer",
      "Toggle right panel",
    ]);
  });

  it("exposes a keyboard-accessible restore control while minimized", async () => {
    const restore = vi.fn();
    await act(async () =>
      root.render(
        <PanelLayoutControls
          terminalAvailable
          terminalOpen={false}
          terminalShortcutLabel={null}
          rightPanelAvailable
          rightPanelOpen={false}
          rightPanelShortcutLabel={null}
          liveAgentCount={0}
          secondaryPane={{
            presentation: "minimized",
            canMaximize: true,
            onMinimize: () => undefined,
            onRestore: restore,
            onToggleMaximize: () => undefined,
          }}
          onToggleTerminal={() => undefined}
          onToggleRightPanel={() => undefined}
        />,
      ),
    );

    const control = host.querySelector<HTMLButtonElement>('[aria-label="Restore secondary pane"]')!;
    expect(control.getAttribute("aria-pressed")).toBe("true");
    await act(async () => control.click());
    expect(restore).toHaveBeenCalledOnce();
  });
});
