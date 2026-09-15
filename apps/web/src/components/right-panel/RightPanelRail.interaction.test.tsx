/* @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { RightPanelRail } from "./RightPanelRail";
import { buildRightPanelSurfaceActions } from "./rightPanelSurfaceActions";
import { redirectTypedKeyToComposer } from "../chat/composerInputRouting";

const browser = vi.fn();
const profile = vi.fn();
const noop = () => undefined;
function actions(available = true) {
  return buildRightPanelSurfaceActions({
    browserProfiles: [
      { id: "work", name: "Work" },
      { id: "personal", name: "Personal" },
    ],
    sourceControlProviderName: null,
    availability: {
      browser: available,
      files: true,
      "source-control": true,
      agents: true,
      "pull-request": true,
      "pull-requests": true,
      device: true,
    },
    onAddBrowser: browser,
    onAddBrowserInProfile: profile,
    onAddFiles: noop,
    onAddSourceControl: noop,
    onAddAgents: noop,
    onAddPullRequest: noop,
    onAddPullRequests: noop,
    onAddDevice: noop,
    liveAgentCount: 0,
  });
}

describe("mounted rail interactions", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  async function mount(available = true) {
    await act(async () =>
      root.render(<RightPanelRail actions={actions(available)} onAddBrowserInProfile={profile} />),
    );
  }
  it.each([true, false])(
    "respects capture-before-bubble ordering with focused=%s",
    async (focused) => {
      await mount();
      const rail = host.querySelector<HTMLElement>("[data-right-panel-rail]")!;
      const insert = vi.fn(() => true);
      const capture = (event: KeyboardEvent) => redirectTypedKeyToComposer(event, insert);
      window.addEventListener("keydown", capture, true);
      try {
        if (focused) rail.focus();
        const event = new KeyboardEvent("keydown", { key: "b", bubbles: true, cancelable: true });
        await act(async () => {
          (focused ? rail : document.body).dispatchEvent(event);
        });
        expect(browser).toHaveBeenCalledTimes(focused ? 1 : 0);
        expect(insert.mock.calls).toEqual(focused ? [] : [["b"]]);
        expect(event.defaultPrevented).toBe(true);
      } finally {
        window.removeEventListener("keydown", capture, true);
      }
    },
  );
  it("opens the chooser and dispatches the exact selected profile", async () => {
    await mount();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Open browser in a profile"]')!.click(),
    );
    const choices = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(choices.map((item) => item.textContent)).toEqual(["Work", "Personal"]);
    await act(async () => choices.find((item) => item.textContent === "Personal")!.click());
    expect(profile.mock.calls).toEqual([["personal"]]);
    expect(browser).not.toHaveBeenCalled();
  });
  it("cannot dispatch an unavailable Browser through click, mnemonic, or profile chooser", async () => {
    await mount(false);
    expect(host.querySelector('[aria-label="Open browser in a profile"]')).toBeNull();
    const rail = host.querySelector<HTMLElement>("[data-right-panel-rail]")!;
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label^="Browser:"]')!.click();
      rail.focus();
      rail.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }));
    });
    expect(browser).not.toHaveBeenCalled();
    expect(profile).not.toHaveBeenCalled();
  });
});
