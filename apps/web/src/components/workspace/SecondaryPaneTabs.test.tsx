/* @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { SecondaryPaneTabs } from "./SecondaryPaneTabs";
import { selectThreadSecondaryPaneState, useSecondaryPaneStore } from "~/secondaryPaneStore";

const showContextMenu =
  vi.fn<
    (
      items: ReadonlyArray<{ id: string; label: string; disabled?: boolean }>,
    ) => Promise<string | null>
  >();

vi.mock("~/localApi", () => ({
  readLocalApi: () => ({ contextMenu: { show: showContextMenu } }),
}));
vi.mock("~/env", async (original) => ({
  ...(await original<typeof import("~/env")>()),
  isElectron: true,
}));

const surfaces = [
  {
    id: "file:src/one.ts" as const,
    kind: "file" as const,
    relativePath: "src/one.ts",
    revealLine: null,
    revealRequestId: 1,
  },
  {
    id: "file:src/two.ts" as const,
    kind: "file" as const,
    relativePath: "src/two.ts",
    revealLine: null,
    revealRequestId: 1,
  },
  {
    id: "file:src/three.ts" as const,
    kind: "file" as const,
    relativePath: "src/three.ts",
    revealLine: null,
    revealRequestId: 1,
  },
];
const threadRef = scopeThreadRef(EnvironmentId.make("secondary-tabs"), ThreadId.make("thread-1"));

function StoredTabs({ onCopyFilePath }: { onCopyFilePath: (relativePath: string) => void }) {
  const state = useSecondaryPaneStore((store) =>
    selectThreadSecondaryPaneState(store.byThreadKey, threadRef),
  );
  return (
    <SecondaryPaneTabs
      surfaces={state.surfaces}
      activeSurfaceId={state.activeSurfaceId}
      onActivate={(surfaceId) =>
        useSecondaryPaneStore.getState().activateSurface(threadRef, surfaceId)
      }
      onClose={(surfaceId) => useSecondaryPaneStore.getState().closeSurface(threadRef, surfaceId)}
      onCopyFilePath={onCopyFilePath}
      onCloseOtherSurfaces={(surfaceId) =>
        useSecondaryPaneStore.getState().closeOtherSurfaces(threadRef, surfaceId)
      }
      onCloseSurfacesToRight={(surfaceId) =>
        useSecondaryPaneStore.getState().closeSurfacesToRight(threadRef, surfaceId)
      }
      onCloseAllSurfaces={() => useSecondaryPaneStore.getState().closeAllSurfaces(threadRef)}
    />
  );
}

describe("SecondaryPaneTabs", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    showContextMenu.mockReset();
    useSecondaryPaneStore.setState({ byThreadKey: {} });
    for (const surface of surfaces)
      useSecondaryPaneStore.getState().openFile(threadRef, surface.relativePath);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const openMenu = async (path = "src/two.ts") => {
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>(`[aria-label="${path}"]`)!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 30 }));
      await Promise.resolve();
    });
  };

  it("opens a file-tab menu with the correct disabled actions", async () => {
    const copy = vi.fn();
    showContextMenu.mockResolvedValue(null);
    await act(async () => root.render(<StoredTabs onCopyFilePath={copy} />));

    await openMenu();

    expect(showContextMenu).toHaveBeenCalledWith(
      [
        { id: "copy-path", label: "Copy path" },
        { id: "close", label: "Close" },
        { id: "close-others", label: "Close others", disabled: false },
        { id: "close-to-right", label: "Close to the right", disabled: false },
        { id: "close-all", label: "Close all", disabled: false },
      ],
      { x: 20, y: 30 },
    );
  });

  it.each([
    ["copy-path", ["file:src/one.ts", "file:src/two.ts", "file:src/three.ts"]],
    ["close", ["file:src/one.ts", "file:src/three.ts"]],
    ["close-others", ["file:src/two.ts"]],
    ["close-to-right", ["file:src/one.ts", "file:src/two.ts"]],
    ["close-all", []],
  ] as const)(
    "dispatches %s through the thread-scoped pane consumer",
    async (action, expectedIds) => {
      const copy = vi.fn();
      showContextMenu.mockResolvedValue(action);
      await act(async () => root.render(<StoredTabs onCopyFilePath={copy} />));

      await openMenu();

      expect(
        selectThreadSecondaryPaneState(
          useSecondaryPaneStore.getState().byThreadKey,
          threadRef,
        ).surfaces.map((surface) => surface.id),
      ).toEqual(expectedIds);
      expect(copy).toHaveBeenCalledTimes(action === "copy-path" ? 1 : 0);
      if (action === "copy-path") expect(copy).toHaveBeenCalledWith("src/two.ts");
    },
  );

  it("disables the group actions that have no eligible target", async () => {
    const copy = vi.fn();
    useSecondaryPaneStore.setState({ byThreadKey: {} });
    useSecondaryPaneStore.getState().openFile(threadRef, "src/only.ts");
    showContextMenu.mockResolvedValue(null);
    await act(async () => root.render(<StoredTabs onCopyFilePath={copy} />));

    await openMenu("src/only.ts");

    expect(showContextMenu.mock.calls[0]?.[0]).toEqual([
      { id: "copy-path", label: "Copy path" },
      { id: "close", label: "Close" },
      { id: "close-others", label: "Close others", disabled: true },
      { id: "close-to-right", label: "Close to the right", disabled: true },
      { id: "close-all", label: "Close all", disabled: false },
    ]);
  });

  it("gives the inline file header the Electron titlebar and keeps stacked controls out of it", async () => {
    const togglePanel = vi.fn();
    await act(async () =>
      root.render(
        <SecondaryPaneTabs
          surfaces={surfaces}
          activeSurfaceId={surfaces[0]!.id}
          layout="inline"
          onActivate={() => undefined}
          onClose={() => undefined}
          onCopyFilePath={() => undefined}
          onCloseOtherSurfaces={() => undefined}
          onCloseSurfacesToRight={() => undefined}
          onCloseAllSurfaces={() => undefined}
          headerControls={
            <button type="button" aria-label="Toggle panel" onClick={togglePanel}>
              Toggle panel
            </button>
          }
        />,
      ),
    );

    const inlineHeader = host.querySelector<HTMLElement>("[data-secondary-pane-tabbar]")!;
    expect(inlineHeader.dataset.secondaryPaneTitlebarOwner).toBe("true");
    expect(inlineHeader.className).toContain("drag-region");
    expect(inlineHeader.className).toContain("workspace-native-controls-inset");
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Toggle panel"]')!.click(),
    );
    expect(togglePanel).toHaveBeenCalledOnce();

    await act(async () =>
      root.render(
        <SecondaryPaneTabs
          surfaces={surfaces}
          activeSurfaceId={surfaces[0]!.id}
          layout="stack"
          onActivate={() => undefined}
          onClose={() => undefined}
          onCopyFilePath={() => undefined}
          onCloseOtherSurfaces={() => undefined}
          onCloseSurfacesToRight={() => undefined}
          onCloseAllSurfaces={() => undefined}
          headerControls={
            <button type="button" aria-label="Toggle panel">
              Toggle panel
            </button>
          }
        />,
      ),
    );
    const stackedHeader = host.querySelector<HTMLElement>("[data-secondary-pane-tabbar]")!;
    expect(stackedHeader.dataset.secondaryPaneTitlebarOwner).toBe("false");
    expect(stackedHeader.className).not.toContain("drag-region");
  });
});
