import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadSecondaryPaneState, useSecondaryPaneStore } from "./secondaryPaneStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

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
