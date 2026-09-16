import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  openDiffFilePrimaryAction,
  resolveDiffPathForRepository,
  resolveDiffPathForWorkspace,
} from "./diffFileActions";
import { selectThreadSecondaryPaneState, useSecondaryPaneStore } from "./secondaryPaneStore";

const THREAD_REF = scopeThreadRef(
  EnvironmentId.make("environment-local"),
  ThreadId.make("thread-1"),
);

describe("openDiffFilePrimaryAction", () => {
  beforeEach(() => {
    useSecondaryPaneStore.setState({ byThreadKey: {} });
  });

  it("opens diff files in a repository-scoped secondary diff tab", () => {
    const openInEditor = vi.fn();
    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "apps/web/src/components/DiffPanel.tsx",
      activeCwd: "/repo/project",
      repositoryRoot: "/repo/project",
      openInEditor,
    });
    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({
      isOpen: true,
      surfaces: [
        {
          kind: "diff",
          repositoryRoot: "/repo/project",
          comparison: "working-tree",
          newPath: "apps/web/src/components/DiffPanel.tsx",
        },
      ],
    });
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("falls back to the editor without thread context", () => {
    const openInEditor = vi.fn();
    openDiffFilePrimaryAction({
      threadRef: null,
      filePath: "apps/web/src/components/DiffPanel.tsx",
      activeCwd: "/repo/project",
      openInEditor,
    });
    expect(openInEditor).toHaveBeenCalledWith(
      "/repo/project/apps/web/src/components/DiffPanel.tsx",
    );
  });

  it("opens repository-relative diff files from a nested project", () => {
    const openInEditor = vi.fn();
    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "frontend/Dockerfile",
      activeCwd: "/repo/frontend",
      repositoryRoot: "/repo",
      openInEditor,
    });
    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({
      isOpen: true,
      surfaces: [{ kind: "diff", repositoryRoot: "/repo", newPath: "frontend/Dockerfile" }],
    });
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("preserves an explicit null new path for deleted files", () => {
    const openInEditor = vi.fn();
    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "old.txt",
      activeCwd: "/repo",
      repositoryRoot: "/repo",
      comparison: "commit",
      oldPath: "old.txt",
      newPath: null,
      openInEditor,
    });
    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({ surfaces: [{ kind: "diff", oldPath: "old.txt", newPath: null }] });
  });

  it("preserves an explicit null old path for added files", () => {
    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "new.txt",
      activeCwd: "/repo",
      repositoryRoot: "/repo",
      comparison: "commit",
      oldPath: null,
      newPath: "new.txt",
      openInEditor: vi.fn(),
    });
    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({ surfaces: [{ kind: "diff", oldPath: null, newPath: "new.txt" }] });
  });

  it("keeps both repository-relative rename sides from a nested project", () => {
    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "frontend/renamed.ts",
      activeCwd: "/repo/frontend",
      repositoryRoot: "/repo",
      comparison: "commit",
      oldPath: "frontend/old.ts",
      newPath: "frontend/renamed.ts",
      openInEditor: vi.fn(),
    });
    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({
      surfaces: [{ kind: "diff", oldPath: "frontend/old.ts", newPath: "frontend/renamed.ts" }],
    });
  });

  it("opens a repository file outside the nested active workspace", () => {
    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "backend/server.ts",
      activeCwd: "/repo/frontend",
      repositoryRoot: "/repo",
      openInEditor: vi.fn(),
    });
    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({ surfaces: [{ kind: "diff", newPath: "backend/server.ts" }] });
  });

  it("rejects traversal before opening a repository comparison", () => {
    expect(resolveDiffPathForRepository("frontend/../secret.ts")).toBeNull();
  });

  it("preserves repository-relative paths in a separate worktree", () => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "frontend/Dockerfile",
        workspaceRoot: "/worktrees/feature",
        repositoryRoot: "/repo",
      }),
    ).toBe("frontend/Dockerfile");
  });

  it("handles Windows roots and mixed diff separators", () => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "Frontend/src\\index.ts",
        workspaceRoot: "C:\\repo\\frontend",
        repositoryRoot: "C:\\repo",
      }),
    ).toBe("src/index.ts");
  });

  it.each([
    { workspaceRoot: "/frontend", repositoryRoot: "/" },
    { workspaceRoot: "C:\\frontend", repositoryRoot: "C:\\" },
  ])("handles filesystem roots: $repositoryRoot", ({ workspaceRoot, repositoryRoot }) => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "frontend/index.ts",
        workspaceRoot,
        repositoryRoot,
      }),
    ).toBe("index.ts");
  });

  it.each(["frontend/../secret.ts", "C:secret.ts"])(
    "does not open an out-of-project diff path: %s",
    (filePath) => {
      const openInEditor = vi.fn();
      openDiffFilePrimaryAction({
        threadRef: THREAD_REF,
        filePath,
        activeCwd: "/repo/frontend",
        repositoryRoot: "/repo",
        openInEditor,
      });
      expect(
        selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, THREAD_REF),
      ).toMatchObject({ isOpen: false });
      expect(openInEditor).not.toHaveBeenCalled();
    },
  );
});
