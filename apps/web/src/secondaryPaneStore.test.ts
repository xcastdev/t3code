import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  migratePersistedSecondaryPaneState,
  selectThreadSecondaryPaneState,
  useSecondaryPaneStore,
} from "./secondaryPaneStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));
const refAInOtherEnvironment = scopeThreadRef("env-2" as EnvironmentId, ThreadId.make("thread-A"));

beforeEach(() => {
  useSecondaryPaneStore.setState({ byThreadKey: {} });
});

describe("secondaryPaneStore", () => {
  it("opens files as deduplicated tabs and activates the latest file", () => {
    useSecondaryPaneStore.getState().openFile(refA, "src/index.ts");
    useSecondaryPaneStore.getState().openFile(refA, "src/index.ts");
    useSecondaryPaneStore.getState().openFile(refA, "README.md");

    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, refA),
    ).toEqual({
      isOpen: true,
      activeSurfaceId: "file:README.md",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: null,
          revealRequestId: 2,
        },
        {
          id: "file:README.md",
          kind: "file",
          relativePath: "README.md",
          revealLine: null,
          revealRequestId: 1,
        },
      ],
    });
  });

  it("updates an existing tab with a normalized line reveal request", () => {
    useSecondaryPaneStore.getState().openFile(refA, "src/index.ts", 42.8);
    useSecondaryPaneStore.getState().openFile(refA, "src/index.ts", 87);
    useSecondaryPaneStore.getState().openFile(refA, "src/index.ts", 0);

    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, refA),
    ).toEqual({
      isOpen: true,
      activeSurfaceId: "file:src/index.ts",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: 1,
          revealRequestId: 3,
        },
      ],
    });
  });

  it("keeps state isolated by thread", () => {
    useSecondaryPaneStore.getState().openFile(refA, "src/index.ts");
    useSecondaryPaneStore.getState().openFile(refB, "README.md");

    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, refA).surfaces,
    ).toHaveLength(1);
    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, refB).surfaces,
    ).toHaveLength(1);
  });

  it("keeps state isolated by environment as well as thread", () => {
    useSecondaryPaneStore.getState().openFile(refA, "env-1.ts");
    useSecondaryPaneStore.getState().openFile(refB, "thread-b.ts");
    useSecondaryPaneStore.getState().openFile(refAInOtherEnvironment, "env-2.ts");

    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, refA).surfaces,
    ).toMatchObject([{ relativePath: "env-1.ts" }]);
    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, refB).surfaces,
    ).toMatchObject([{ relativePath: "thread-b.ts" }]);
    expect(
      selectThreadSecondaryPaneState(
        useSecondaryPaneStore.getState().byThreadKey,
        refAInOtherEnvironment,
      ).surfaces,
    ).toMatchObject([{ relativePath: "env-2.ts" }]);
  });

  it("sanitizes malformed surfaces during migration", () => {
    expect(
      migratePersistedSecondaryPaneState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "file:missing.ts",
            surfaces: [
              {
                id: "invalid-id",
                kind: "file",
                relativePath: "./src\\index.ts",
                revealLine: 42.8,
                revealRequestId: -1,
              },
              null,
              { kind: "terminal", relativePath: "terminal" },
              { kind: "file", relativePath: "" },
            ],
          },
          "env-1:corrupt": { isOpen: true, surfaces: "not-an-array" },
          "env-1:missing": null,
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "file:src/index.ts",
          surfaces: [
            {
              id: "file:src/index.ts",
              kind: "file",
              relativePath: "src/index.ts",
              revealLine: 42,
              revealRequestId: 0,
            },
          ],
        },
      },
    });

    expect(
      migratePersistedSecondaryPaneState({
        byThreadKey: [
          {
            isOpen: true,
            activeSurfaceId: "file:src/index.ts",
            surfaces: [
              {
                kind: "file",
                relativePath: "src/index.ts",
                revealLine: null,
                revealRequestId: 1,
              },
            ],
          },
        ],
      }),
    ).toEqual({ byThreadKey: {} });
  });

  it("sanitizes malformed same-version state during hydration", async () => {
    const persistOptions = useSecondaryPaneStore.persist.getOptions();
    expect(persistOptions.name).toBeDefined();
    expect(persistOptions.storage).toBeDefined();

    await persistOptions.storage?.setItem(persistOptions.name ?? "", {
      version: 1,
      state: {
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "file:missing.ts",
            surfaces: { broken: true },
          },
          "env-1:thread-B": "not-a-thread-state",
        },
      },
    } as never);

    await useSecondaryPaneStore.persist.rehydrate();

    expect(useSecondaryPaneStore.getState().byThreadKey).toEqual({});
    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, refA),
    ).toEqual({ isOpen: false, activeSurfaceId: null, surfaces: [] });
  });

  it("activates an existing surface without changing its tab order", () => {
    useSecondaryPaneStore.getState().openFile(refA, "one.ts");
    useSecondaryPaneStore.getState().openFile(refA, "two.ts");
    useSecondaryPaneStore.getState().activateSurface(refA, "file:one.ts");

    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, refA),
    ).toMatchObject({
      isOpen: true,
      activeSurfaceId: "file:one.ts",
      surfaces: [{ relativePath: "one.ts" }, { relativePath: "two.ts" }],
    });
  });

  it("closes all surfaces for a thread", () => {
    useSecondaryPaneStore.getState().openFile(refA, "one.ts");
    useSecondaryPaneStore.getState().openFile(refA, "two.ts");
    useSecondaryPaneStore.getState().closeAllSurfaces(refA);

    expect(useSecondaryPaneStore.getState().byThreadKey).toEqual({});
  });

  it("removes only the requested thread state", () => {
    useSecondaryPaneStore.getState().openFile(refA, "three.ts");
    useSecondaryPaneStore.getState().openFile(refAInOtherEnvironment, "other-env.ts");
    useSecondaryPaneStore.getState().removeThread(refA);

    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, refA),
    ).toEqual({ isOpen: false, activeSurfaceId: null, surfaces: [] });
    expect(
      selectThreadSecondaryPaneState(
        useSecondaryPaneStore.getState().byThreadKey,
        refAInOtherEnvironment,
      ).surfaces,
    ).toMatchObject([{ relativePath: "other-env.ts" }]);
  });

  it("selects a neighboring tab when the active tab closes", () => {
    useSecondaryPaneStore.getState().openFile(refA, "one.ts");
    useSecondaryPaneStore.getState().openFile(refA, "two.ts");
    useSecondaryPaneStore.getState().openFile(refA, "three.ts");

    useSecondaryPaneStore.getState().closeSurface(refA, "file:two.ts");

    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, refA),
    ).toEqual({
      isOpen: true,
      activeSurfaceId: "file:three.ts",
      surfaces: [
        {
          id: "file:one.ts",
          kind: "file",
          relativePath: "one.ts",
          revealLine: null,
          revealRequestId: 1,
        },
        {
          id: "file:three.ts",
          kind: "file",
          relativePath: "three.ts",
          revealLine: null,
          revealRequestId: 1,
        },
      ],
    });

    useSecondaryPaneStore.getState().closeSurface(refA, "file:three.ts");
    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, refA)
        .activeSurfaceId,
    ).toBe("file:one.ts");
  });

  it("closes the pane when the final tab is closed", () => {
    useSecondaryPaneStore.getState().openFile(refA, "src/index.ts");
    useSecondaryPaneStore.getState().closeSurface(refA, "file:src/index.ts");

    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, refA),
    ).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("supports closing tab groups and workspace reconciliation", () => {
    useSecondaryPaneStore.getState().openFile(refA, "one.ts");
    useSecondaryPaneStore.getState().openFile(refA, "two.ts");
    useSecondaryPaneStore.getState().openFile(refA, "three.ts");
    useSecondaryPaneStore.getState().closeSurfacesToRight(refA, "file:one.ts");

    expect(
      selectThreadSecondaryPaneState(
        useSecondaryPaneStore.getState().byThreadKey,
        refA,
      ).surfaces.map((s) => s.id),
    ).toEqual(["file:one.ts"]);

    useSecondaryPaneStore.getState().reconcileWorkspace(refA, false);
    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, refA),
    ).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });
});
