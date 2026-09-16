import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  EMPTY_SECONDARY_PANE_STATE,
  migratePersistedSecondaryPaneState,
  selectThreadSecondaryPaneState,
  useSecondaryPaneStore,
  selectActiveSecondaryPaneSurface,
  openRepositoryComparison,
} from "./secondaryPaneStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));
const refAInOtherEnvironment = scopeThreadRef("env-2" as EnvironmentId, ThreadId.make("thread-A"));

beforeEach(() => {
  useSecondaryPaneStore.setState({ byThreadKey: {} });
});

describe("secondaryPaneStore", () => {
  it("keeps diff tabs distinct by repository and comparison identity", () => {
    useSecondaryPaneStore.getState().openDiff(refA, {
      repositoryRoot: "/repo-a",
      comparison: "working-tree",
      oldPath: "src/index.ts",
      newPath: "src/index.ts",
    });
    useSecondaryPaneStore.getState().openDiff(refA, {
      repositoryRoot: "/repo-b",
      comparison: "working-tree",
      oldPath: "src/index.ts",
      newPath: "src/index.ts",
    });
    const state = selectThreadSecondaryPaneState(
      useSecondaryPaneStore.getState().byThreadKey,
      refA,
    );
    expect(state.surfaces).toHaveLength(2);
    expect(state.surfaces[0]?.id).not.toBe(state.surfaces[1]?.id);
  });

  it("keeps staged comparison tabs distinct across index snapshots", () => {
    useSecondaryPaneStore.getState().openDiff(refA, {
      repositoryRoot: "/repo-a",
      comparison: "index",
      oldPath: "src/index.ts",
      newPath: "src/index.ts",
      indexTree: "tree-a",
    });
    useSecondaryPaneStore.getState().openDiff(refA, {
      repositoryRoot: "/repo-a",
      comparison: "index",
      oldPath: "src/index.ts",
      newPath: "src/index.ts",
      indexTree: "tree-b",
    });
    const state = selectThreadSecondaryPaneState(
      useSecondaryPaneStore.getState().byThreadKey,
      refA,
    );
    expect(state.surfaces).toHaveLength(2);
    expect(state.surfaces[0]?.id).not.toBe(state.surfaces[1]?.id);
  });

  it("resolves a branch tab without changing its key or duplicating a reopened comparison", () => {
    openRepositoryComparison(refA, {
      repositoryRoot: "/repo-a",
      comparison: "branch",
      oldPath: "README.md",
      newPath: "README.md",
      baseRef: "origin/main",
      headRef: "feature",
    });
    const initial = selectActiveSecondaryPaneSurface(
      useSecondaryPaneStore.getState().byThreadKey,
      refA,
    );
    if (!initial || initial.kind !== "diff") throw new Error("Expected an opened diff.");
    const initialId = initial.id;
    useSecondaryPaneStore.getState().resolveDiffDescriptor(refA, initial.id, {
      version: 1,
      environmentId: "env-1",
      repositoryRoot: "/repo-a",
      kind: "branch",
      oldPath: "README.md",
      newPath: "README.md",
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40),
      liveSnapshotId: null,
      turnId: null,
      checkpointId: null,
      pullRequestId: null,
      mergeParent: null,
    });
    expect(
      selectActiveSecondaryPaneSurface(useSecondaryPaneStore.getState().byThreadKey, refA),
    ).toMatchObject({
      kind: "diff",
      id: initialId,
      descriptor: { baseRevision: "a".repeat(40), headRevision: "b".repeat(40) },
    });
    openRepositoryComparison(refA, {
      repositoryRoot: "/repo-a",
      comparison: "branch",
      oldPath: "README.md",
      newPath: "README.md",
      baseRef: "origin/main",
      headRef: "feature",
    });
    const state = selectThreadSecondaryPaneState(
      useSecondaryPaneStore.getState().byThreadKey,
      refA,
    );
    expect(state.surfaces).toHaveLength(1);
    expect(state.activeSurfaceId).toBe(initialId);
  });

  it("keeps distinct pinned branch revisions while an unresolved reopen preserves its resolved tab", () => {
    const input = {
      repositoryRoot: "/repo-a",
      comparison: "branch" as const,
      oldPath: "README.md",
      newPath: "README.md",
      baseRef: "origin/main",
      headRef: "feature",
    };
    openRepositoryComparison(refA, {
      ...input,
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40),
    });
    openRepositoryComparison(refA, {
      ...input,
      baseRevision: "a".repeat(40),
      headRevision: "c".repeat(40),
    });
    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, refA).surfaces,
    ).toHaveLength(2);

    openRepositoryComparison(refA, input);
    const state = selectThreadSecondaryPaneState(
      useSecondaryPaneStore.getState().byThreadKey,
      refA,
    );
    expect(state.surfaces).toHaveLength(2);
    expect(state.surfaces[1]).toMatchObject({
      descriptor: { headRevision: "c".repeat(40) },
    });
  });

  it("keeps a resolved tab active after persistence and deduplicates its immutable snapshot", () => {
    const unresolved = {
      repositoryRoot: "/repo-a",
      comparison: "branch" as const,
      oldPath: "README.md",
      newPath: "README.md",
      baseRef: "origin/main",
      headRef: "feature",
    };
    openRepositoryComparison(refA, { ...unresolved, newPath: "first.md" });
    openRepositoryComparison(refA, unresolved);
    const selected = selectActiveSecondaryPaneSurface(
      useSecondaryPaneStore.getState().byThreadKey,
      refA,
    );
    if (!selected || selected.kind !== "diff" || !selected.descriptor)
      throw new Error("Expected diff tab");
    useSecondaryPaneStore.getState().resolveDiffDescriptor(refA, selected.id, {
      ...selected.descriptor,
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40),
    });

    const restored = migratePersistedSecondaryPaneState({
      byThreadKey: useSecondaryPaneStore.getState().byThreadKey,
    });
    expect(selectActiveSecondaryPaneSurface(restored.byThreadKey, refA)).toMatchObject({
      newPath: "README.md",
      descriptor: { baseRevision: "a".repeat(40), headRevision: "b".repeat(40) },
    });

    openRepositoryComparison(refA, {
      ...unresolved,
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40),
    });
    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, refA).surfaces,
    ).toHaveLength(2);
  });

  it("minimizes without dropping tabs and restores when opening a surface", () => {
    useSecondaryPaneStore.getState().openFile(refA, "README.md");
    useSecondaryPaneStore.getState().setPresentation(refA, "minimized");
    expect(
      selectActiveSecondaryPaneSurface(useSecondaryPaneStore.getState().byThreadKey, refA),
    ).toMatchObject({
      relativePath: "README.md",
    });
    useSecondaryPaneStore.getState().openFile(refA, "src/index.ts");
    const state = selectThreadSecondaryPaneState(
      useSecondaryPaneStore.getState().byThreadKey,
      refA,
    );
    expect(state.presentation).toBe("expanded");
    expect(state.surfaces).toHaveLength(2);
  });

  it("restores the saved maximized presentation when opening while minimized", () => {
    useSecondaryPaneStore.getState().openFile(refA, "README.md");
    useSecondaryPaneStore.getState().setPresentation(refA, "maximized");
    useSecondaryPaneStore.getState().setPresentation(refA, "minimized");
    useSecondaryPaneStore.getState().openFile(refA, "src/index.ts");

    const state = selectThreadSecondaryPaneState(
      useSecondaryPaneStore.getState().byThreadKey,
      refA,
    );
    expect(state).toMatchObject({ isOpen: true, presentation: "maximized" });
    expect(state.presentationBeforeMinimize).toBeUndefined();
  });

  it("preserves a maximized presentation when opening another file or diff", () => {
    useSecondaryPaneStore.getState().openFile(refA, "README.md");
    useSecondaryPaneStore.getState().setPresentation(refA, "maximized");

    useSecondaryPaneStore.getState().openFile(refA, "src/index.ts");
    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, refA)
        .presentation,
    ).toBe("maximized");

    useSecondaryPaneStore.getState().openDiff(refA, {
      repositoryRoot: "/repo-a",
      comparison: "working-tree",
      oldPath: "src/index.ts",
      newPath: "src/index.ts",
    });
    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, refA)
        .presentation,
    ).toBe("maximized");
  });

  it("keeps a minimized pane minimized while closing retained tabs", () => {
    useSecondaryPaneStore.getState().openFile(refA, "one.ts");
    useSecondaryPaneStore.getState().openFile(refA, "two.ts");
    useSecondaryPaneStore.getState().setPresentation(refA, "minimized");

    useSecondaryPaneStore.getState().closeOtherSurfaces(refA, "file:one.ts");
    const afterClosingOthers = selectThreadSecondaryPaneState(
      useSecondaryPaneStore.getState().byThreadKey,
      refA,
    );
    expect(afterClosingOthers).toMatchObject({
      isOpen: false,
      presentation: "minimized",
      activeSurfaceId: "file:one.ts",
      surfaces: [{ id: "file:one.ts" }],
    });

    useSecondaryPaneStore.getState().closeSurface(refA, "file:one.ts");
    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, refA),
    ).toEqual(EMPTY_SECONDARY_PANE_STATE);
  });

  it("preserves a minimized diff tab identity until it is restored", () => {
    openRepositoryComparison(refA, {
      repositoryRoot: "/repo-a",
      comparison: "commit",
      oldPath: "src/old.ts",
      newPath: "src/new.ts",
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40),
    });
    const beforeMinimize = selectActiveSecondaryPaneSurface(
      useSecondaryPaneStore.getState().byThreadKey,
      refA,
    );
    useSecondaryPaneStore.getState().setPresentation(refA, "minimized");
    useSecondaryPaneStore.getState().activateSurface(refA, beforeMinimize!.id);

    expect(
      selectActiveSecondaryPaneSurface(useSecondaryPaneStore.getState().byThreadKey, refA),
    ).toEqual(beforeMinimize);
    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, refA),
    ).toMatchObject({
      isOpen: true,
      presentation: "expanded",
    });
  });

  it("preserves the active surface through a minimized persisted migration", () => {
    expect(
      migratePersistedSecondaryPaneState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: false,
            presentation: "minimized",
            activeSurfaceId: "file:README.md",
            surfaces: [
              {
                kind: "file",
                relativePath: "README.md",
                revealLine: null,
                revealRequestId: 2,
              },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: false,
          activeSurfaceId: "file:README.md",
          presentation: "minimized",
          surfaces: [
            {
              id: "file:README.md",
              kind: "file",
              relativePath: "README.md",
              revealLine: null,
              revealRequestId: 2,
            },
          ],
        },
      },
    });
  });

  it("migrates legacy retained tabs to the expanded presentation", () => {
    expect(
      migratePersistedSecondaryPaneState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: false,
            activeSurfaceId: "file:README.md",
            surfaces: [
              {
                kind: "file",
                relativePath: "README.md",
                revealLine: 12,
                revealRequestId: 4,
              },
            ],
          },
        },
      }),
    ).toMatchObject({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          presentation: "expanded",
          activeSurfaceId: "file:README.md",
          surfaces: [{ relativePath: "README.md", revealLine: 12, revealRequestId: 4 }],
        },
      },
    });
  });

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
          presentation: "expanded",
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
