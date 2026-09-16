/* @vitest-environment happy-dom */
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { RightPanelTabs } from "./RightPanelTabs";
import { RightPanelSheet } from "./RightPanelSheet";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

vi.mock("~/env", async (original) => ({
  ...(await original<typeof import("~/env")>()),
  isElectron: true,
}));
vi.mock("~/browser/browserDefaults", () => ({
  useBrowserDefaults: () => ({
    profiles: [
      { id: "work", name: "Work" },
      { id: "personal", name: "Personal" },
    ],
  }),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
const ref = scopeThreadRef(EnvironmentId.make("rail-test"), ThreadId.make("thread"));
const profile = vi.fn();
const noop = () => undefined;
const base = {
  mode: "inline",
  environmentId: null,
  surfaces: [],
  activeSurfaceId: null,
  pendingSurfaceIds: new Set<string>(),
  previewSessions: {},
  desktopByTabId: {},
  onActivate: noop,
  onCloseSurface: noop,
  onCloseOtherSurfaces: noop,
  onCloseSurfacesToRight: noop,
  onCloseAllSurfaces: noop,
  onCopyFilePath: noop,
  onAddBrowser: noop,
  onAddBrowserInProfile: profile,
  onAddDiff: noop,
  onAddFiles: noop,
  onAddPullRequest: noop,
  onAddPullRequests: noop,
  onAddAgents: noop,
  onAddDevice: noop,
  onAddSourceControl: noop,
  browserAvailable: true,
  diffAvailable: true,
  filesAvailable: true,
  pullRequestAvailable: true,
  pullRequestsAvailable: true,
  agentsAvailable: true,
  deviceAvailable: true,
  sourceControlAvailable: true,
  liveAgentCount: 0,
  children: <div>Surface content</div>,
} satisfies ComponentProps<typeof RightPanelTabs>;

function StoredPanel() {
  const state = useRightPanelStore((store) => selectThreadRightPanelState(store.byThreadKey, ref));
  return (
    <RightPanelTabs
      {...base}
      {...state}
      open={state.isOpen}
      onCloseSurface={(surface) => useRightPanelStore.getState().closeSurface(ref, surface.id)}
    />
  );
}

describe("mounted right-panel consumer", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    profile.mockClear();
    useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const shell = () => document.querySelector<HTMLElement>("[data-preview-panel-mode]")!;
  it("keeps the empty rail narrow even if the previous surface was maximized", async () => {
    await act(async () => root.render(<RightPanelTabs {...base} maximized />));
    expect(shell().style.width).toBe("48px");
    expect(shell().dataset.previewPanelMaximized).toBe("false");
  });
  it.each(["last", "all"])(
    "returns to the 48px rail after closing %s; explicit hide collapses it",
    async (close) => {
      useRightPanelStore.getState().open(ref, "files");
      await act(async () => root.render(<StoredPanel />));
      expect(document.querySelector('[role="separator"]')).not.toBeNull();
      await act(async () => {
        if (close === "last")
          host.querySelector<HTMLButtonElement>('[aria-label="Close Files"]')!.click();
        else useRightPanelStore.getState().closeAllSurfaces(ref);
      });
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).isOpen,
      ).toBe(true);
      expect(shell().style.width).toBe("48px");
      expect(host.querySelector('[role="separator"]')).toBeNull();
      expect(host.querySelector("[data-right-panel-rail]")).not.toBeNull();
      await act(async () => useRightPanelStore.getState().toggleVisibility(ref));
      expect(shell().style.width).toBe("0px");
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).isOpen,
      ).toBe(false);
    },
  );
  it("updates the provider label from live props and forwards the selected Browser profile", async () => {
    for (const name of ["GitHub", "GitLab", null]) {
      await act(async () =>
        root.render(<RightPanelTabs {...base} sourceControlProviderName={name} />),
      );
      expect(host.querySelector(`[aria-label="${name ?? "Source Control"} (G)"]`)).not.toBeNull();
      expect(host.querySelectorAll("[data-right-panel-rail] > div")).toHaveLength(7);
    }
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Open browser in a profile"]')!.click(),
    );
    await act(async () =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find((item) => item.textContent === "Work")!
        .click(),
    );
    expect(profile.mock.calls).toEqual([["work"]]);
  });
  it("reserves the topbar above the inline rail and restores native control spacing for tabs", async () => {
    await act(async () => root.render(<RightPanelTabs {...base} reserveGlobalControls />));
    expect(host.querySelector("[data-right-panel-tabbar]")).toBeNull();
    expect(host.querySelector("[data-right-panel-rail]")!.className).toContain(
      "pt-[calc(var(--workspace-topbar-height)",
    );
    await act(async () =>
      root.render(
        <RightPanelTabs
          {...base}
          reserveGlobalControls
          surfaces={[{ id: "files", kind: "files" }]}
          activeSurfaceId="files"
        />,
      ),
    );
    const bar = host.querySelector("[data-right-panel-tabbar]")!;
    expect(bar.className).toContain("drag-region");
    expect(bar.className).toContain("pr-[var(--workspace-global-controls-width)]");
    expect(bar.className).not.toContain(
      "calc(var(--workspace-native-controls-inset)+var(--workspace-global-controls-width))",
    );
    expect(
      Array.from(bar.querySelectorAll<HTMLElement>("span")).find((element) =>
        element.className.includes("workspace-global-controls-cluster-width"),
      )?.className,
    ).toContain("right-[calc(var(--workspace-controls-right)+1px)]");
  });

  it("reserves the same global-control footprint for populated inline Files tabs", async () => {
    await act(async () =>
      root.render(
        <RightPanelTabs
          {...base}
          reserveGlobalControls
          surfaces={[{ id: "files", kind: "files" }]}
          activeSurfaceId="files"
        />,
      ),
    );

    expect(host.querySelector("[data-right-panel-tabbar]")!.className).toContain(
      "pr-[var(--workspace-global-controls-width)]",
    );
  });
  it("keeps the empty sheet full width with its controls and dismisses through onClose", async () => {
    const close = vi.fn();
    await act(async () =>
      root.render(
        <RightPanelSheet open animationDurationMs={0} onClose={close}>
          <RightPanelTabs
            {...base}
            mode="sheet"
            layoutControls={<button onClick={close}>Hide sidebar</button>}
          />
        </RightPanelSheet>,
      ),
    );
    expect(shell().style.width).toBe("");
    expect(document.querySelector("[data-right-panel-rail]")).not.toBeNull();
    expect(document.querySelector("[data-right-panel-tabbar]")!.className).not.toContain(
      "drag-region",
    );
    expect(document.querySelector('[role="separator"]')).toBeNull();
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
