/* @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";

const queried = vi.hoisted(() => [] as Array<{ kind: string; cwd: string }>);
const atoms = vi.hoisted(() => ({
  compareRepositoryFile: Symbol("compare-repository-file"),
  config: Symbol("config"),
  diffContents: Symbol("diff-contents"),
}));
const routeRef = vi.hoisted(() => ({ environmentId: "environment", threadId: "thread" }));
const compareRepositoryFile = vi.hoisted(() => vi.fn());
const atomValue = vi.hoisted(() => ({
  availableEditors: [],
  environment: { capabilities: { sourceControlWorkspace: true } },
}));
const turnDiffState = vi.hoisted(() => ({
  summaries: [] as Array<Record<string, unknown>>,
  inferred: {} as Record<string, number>,
}));
const checkpointDiffState = vi.hoisted(() => ({ data: null as { diff: string } | null }));

vi.mock("@tanstack/react-router", () => ({
  useParams: ({ select }: { select: (params: unknown) => unknown }) =>
    select({ environmentId: "environment", threadId: "thread" }),
}));
vi.mock("~/threadRoutes", () => ({ resolveThreadRouteRef: () => routeRef }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => atomValue }));
vi.mock("~/state/entities", () => ({
  useThread: () => ({
    id: ThreadId.make("thread"),
    environmentId: EnvironmentId.make("environment"),
    projectId: ProjectId.make("project"),
    worktreePath: null,
    checkpoints: [],
  }),
  useProject: () => ({ workspaceRoot: "/repo", repositoryIdentity: { rootPath: "/repo" } }),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (target: { input?: { cwd?: string }; _tag?: string } | null) => {
    const cwd = target?.input?.cwd;
    if (cwd && target?._tag) queried.push({ kind: target._tag, cwd });
    if (target?._tag === "status") {
      return {
        data: { isRepo: true, repositoryRoot: cwd },
        error: null,
        isPending: false,
        refresh: vi.fn(),
      };
    }
    if (target?._tag === "preview") {
      return {
        data: {
          cwd,
          sources: [
            {
              id: "branch-range",
              kind: "branch-range",
              title: "Against base branch",
              baseRef: "origin/main",
              headRef: "feature/scope",
              diffHash: "diff-hash",
              truncated: false,
              diff: [
                "diff --git a/README.md b/README.md",
                "--- a/README.md",
                "+++ b/README.md",
                "@@ -1 +1 @@",
                "-before",
                "+after",
              ].join("\\n"),
            },
          ],
        },
        error: null,
        isPending: false,
        refresh: vi.fn(),
      };
    }
    return { data: null, error: null, isPending: false, refresh: vi.fn() };
  },
}));
vi.mock("~/state/sourceControl", () => ({
  sourceControlWorkspaceEnvironment: {
    status: ({ input }: { input: { cwd: string } }) => ({ _tag: "status", input }),
    listRefs: ({ input }: { input: { cwd: string } }) => ({ _tag: "refs", input }),
    compareRepositoryFile: atoms.compareRepositoryFile,
  },
}));
vi.mock("~/state/review", () => ({
  reviewEnvironment: {
    diffFileContents: atoms.diffContents,
    diffPreview: ({ input }: { input: { cwd: string } }) => ({ _tag: "preview", input }),
  },
}));
vi.mock("~/state/server", () => ({ serverEnvironment: { configValueAtom: () => atoms.config } }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) =>
    atom === atoms.compareRepositoryFile ? compareRepositoryFile : vi.fn(),
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => ({
    diffLayout: "unified",
    wordWrap: false,
    diffIgnoreWhitespace: false,
  }),
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("~/hooks/useLocalStorage", () => ({
  useLocalStorage: (initial: unknown) => [initial, vi.fn()],
}));
vi.mock("~/hooks/useTurnDiffSummaries", () => ({
  useTurnDiffSummaries: () => ({
    turnDiffSummaries: turnDiffState.summaries,
    inferredCheckpointTurnCountByTurnId: turnDiffState.inferred,
  }),
}));
vi.mock("~/lib/checkpointDiffState", () => ({
  useCheckpointDiff: () => ({ data: checkpointDiffState.data, error: null, isPending: false }),
}));
vi.mock("~/editorPreferences", () => ({ useOpenInPreferredEditor: () => vi.fn() }));
vi.mock("./DiffPanelShell", () => ({
  DiffPanelLoadingState: () => <div>Loading diff</div>,
  DiffPanelShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("./diffs/AnnotatableCodeView", () => ({
  AnnotatableCodeView: ({ files }: { files: ReadonlyArray<unknown> }) => (
    <div>{files.length > 0 ? <div data-title>README.md</div> : null}</div>
  ),
}));

import DiffPanel from "./DiffPanel";
import { useRightPanelStore } from "~/rightPanelStore";
import { useDiffPanelStore } from "~/diffPanelStore";
import { selectThreadSecondaryPaneState, useSecondaryPaneStore } from "~/secondaryPaneStore";
import { SecondaryPaneDiffPanel } from "./workspace/SecondaryPaneDiffPanel";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");
const threadRef = scopeThreadRef(environmentId, threadId);
const roots: Root[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queried.splice(0);
  turnDiffState.summaries = [];
  checkpointDiffState.data = null;
  useRightPanelStore.setState({ sourceControlRepositoryRootByThreadKey: {} });
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
  useSecondaryPaneStore.setState({ byThreadKey: {} });
  compareRepositoryFile.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { oldContents: "before", newContents: "after", binary: false, available: true },
  });
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("DiffPanel selected repository scope", () => {
  it("opens an aggregate file in the current selected repository after its stored selection differs", async () => {
    useDiffPanelStore.getState().selectGitScope(threadRef, "branch", "/repo/packages/api");
    useRightPanelStore.getState().setSourceControlRepositoryRoot(threadRef, "/repo/packages/api");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <DiffPanel
          mode="embedded"
          composerDraftTarget={threadRef}
          initialGitScope="branch"
          workspaceMutationId={null}
        />,
      );
    });
    expect(queried).toContainEqual({ kind: "status", cwd: "/repo/packages/api" });
    expect(queried).toContainEqual({ kind: "preview", cwd: "/repo/packages/api" });

    await act(async () => {
      useRightPanelStore.getState().setSourceControlRepositoryRoot(threadRef, "/repo");
    });
    expect(queried).toContainEqual({ kind: "status", cwd: "/repo" });
    expect(queried).toContainEqual({ kind: "preview", cwd: "/repo" });

    const readme = [...container.querySelectorAll<HTMLElement>("[data-title]")].find(
      (element) => element.textContent === "README.md",
    );
    expect(readme).toBeDefined();
    await act(async () => {
      readme!.click();
    });

    const secondaryPane = selectThreadSecondaryPaneState(
      useSecondaryPaneStore.getState().byThreadKey,
      threadRef,
    );
    const surface = secondaryPane.surfaces.find((candidate) => candidate.kind === "diff");
    expect(surface).toMatchObject({
      kind: "diff",
      repositoryRoot: "/repo",
      comparison: "branch",
      newPath: "README.md",
    });
    if (!surface || surface.kind !== "diff") throw new Error("Expected an opened diff surface.");

    const aggregatePreviewQueries = queried.filter(
      (query) => query.kind === "preview" && query.cwd === "/repo",
    ).length;
    const comparisonContainer = document.createElement("div");
    document.body.append(comparisonContainer);
    const comparisonRoot = createRoot(comparisonContainer);
    roots.push(comparisonRoot);
    await act(async () => {
      comparisonRoot.render(
        <SecondaryPaneDiffPanel environmentId={environmentId} cwd="/repo" surface={surface} />,
      );
      await Promise.resolve();
    });
    expect(compareRepositoryFile).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({ cwd: "/repo", comparison: "branch", newPath: "README.md" }),
    });
    expect(comparisonContainer.textContent).toContain("before");
    expect(comparisonContainer.textContent).toContain("after");
    // The secondary file tab reads the aggregate's pinned descriptor. It must
    // not start a second repository-wide aggregate preview.
    expect(
      queried.filter((query) => query.kind === "preview" && query.cwd === "/repo"),
    ).toHaveLength(aggregatePreviewQueries);
  });

  it("opens a timeline file from its checkpoint pair in the thread workspace", async () => {
    const checkpoint = "refs/t3/checkpoints/thread/turn/2";
    turnDiffState.summaries = [
      {
        turnId: TurnId.make("turn-2"),
        completedAt: "2026-09-16T12:00:00.000Z",
        checkpointTurnCount: 2,
        checkpointRef: checkpoint,
      },
      {
        turnId: TurnId.make("turn-1"),
        completedAt: "2026-09-16T11:00:00.000Z",
        checkpointTurnCount: 1,
        checkpointRef: "refs/t3/checkpoints/thread/turn/1",
      },
    ];
    checkpointDiffState.data = {
      diff: [
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1 +1 @@",
        "-checkpoint one",
        "+checkpoint two",
      ].join("\n"),
    };
    useRightPanelStore.getState().setSourceControlRepositoryRoot(threadRef, "/repo/packages/api");
    // Select the timeline first. The actual rendered aggregate file click,
    // rather than a pre-seeded store file path, must open the comparison.
    useDiffPanelStore.getState().selectTurn(threadRef, TurnId.make("turn-2"), undefined, "/repo");
    compareRepositoryFile.mockImplementation(async ({ input }) => {
      const base = input.baseRef;
      const head = input.descriptor.checkpointId;
      return {
        _tag: "Success",
        value: {
          oldContents: `checkpoint contents for ${base}`,
          newContents: `checkpoint contents for ${head}`,
          binary: false,
          available: true,
          descriptor: input.descriptor,
        },
      };
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <DiffPanel
          mode="embedded"
          composerDraftTarget={threadRef}
          initialGitScope="branch"
          workspaceMutationId={null}
        />,
      );
      await Promise.resolve();
    });

    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, threadRef)
        .surfaces,
    ).toHaveLength(0);
    const readme = [...container.querySelectorAll<HTMLElement>("[data-title]")].find(
      (element) => element.textContent === "README.md",
    );
    expect(readme).toBeDefined();
    await act(async () => {
      readme!.click();
    });

    const surface = selectThreadSecondaryPaneState(
      useSecondaryPaneStore.getState().byThreadKey,
      threadRef,
    ).surfaces.find((candidate) => candidate.kind === "diff");
    expect(surface).toMatchObject({
      kind: "diff",
      repositoryRoot: "/repo",
      comparison: "turn",
      oldPath: "README.md",
      newPath: "README.md",
      checkpointId: checkpoint,
      baseRef: "refs/t3/checkpoints/thread/turn/1",
    });
    if (!surface || surface.kind !== "diff")
      throw new Error("Expected an opened turn diff surface.");

    const comparisonContainer = document.createElement("div");
    document.body.append(comparisonContainer);
    const comparisonRoot = createRoot(comparisonContainer);
    roots.push(comparisonRoot);
    await act(async () => {
      comparisonRoot.render(
        <SecondaryPaneDiffPanel
          environmentId={environmentId}
          cwd="/repo/packages/api"
          surface={surface}
        />,
      );
      await Promise.resolve();
    });
    expect(compareRepositoryFile).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({
        cwd: "/repo",
        comparison: "commit",
        baseRef: "refs/t3/checkpoints/thread/turn/1",
        descriptor: expect.objectContaining({
          checkpointId: checkpoint,
          turnId: "turn-2",
          repositoryRoot: "/repo",
        }),
      }),
    });
    expect(comparisonContainer.textContent).toContain(
      "checkpoint contents for refs/t3/checkpoints/thread/turn/1",
    );
    expect(comparisonContainer.textContent).toContain(`checkpoint contents for ${checkpoint}`);
  });

  it("opens a first-turn file from checkpoint zero after a rendered click", async () => {
    const checkpoint = "refs/t3/checkpoints/thread/turn/1";
    turnDiffState.summaries = [
      {
        turnId: TurnId.make("turn-1"),
        completedAt: "2026-09-16T11:00:00.000Z",
        checkpointTurnCount: 1,
        checkpointRef: checkpoint,
      },
    ];
    checkpointDiffState.data = {
      diff: [
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -0,0 +1 @@",
        "+first checkpoint",
      ].join("\n"),
    };
    useDiffPanelStore.getState().selectTurn(threadRef, TurnId.make("turn-1"), undefined, "/repo");
    compareRepositoryFile.mockImplementation(async ({ input }) => ({
      _tag: "Success",
      value: {
        oldContents: `root ${input.baseRef}`,
        newContents: `first ${input.descriptor.checkpointId}`,
        binary: false,
        available: true,
        descriptor: input.descriptor,
      },
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <DiffPanel
          mode="embedded"
          composerDraftTarget={threadRef}
          initialGitScope="branch"
          workspaceMutationId={null}
        />,
      );
      await Promise.resolve();
    });
    const readme = container.querySelector<HTMLElement>("[data-title]");
    expect(readme?.textContent).toBe("README.md");
    await act(async () => readme!.click());
    const surface = selectThreadSecondaryPaneState(
      useSecondaryPaneStore.getState().byThreadKey,
      threadRef,
    ).surfaces.find((candidate) => candidate.kind === "diff");
    if (!surface || surface.kind !== "diff") throw new Error("Expected first turn diff surface.");
    expect(surface.baseRef).toBe("refs/t3/checkpoints/dGhyZWFk/turn/0");
    const comparisonContainer = document.createElement("div");
    document.body.append(comparisonContainer);
    const comparisonRoot = createRoot(comparisonContainer);
    roots.push(comparisonRoot);
    await act(async () => {
      comparisonRoot.render(
        <SecondaryPaneDiffPanel
          environmentId={environmentId}
          cwd="/repo/packages/api"
          surface={surface}
        />,
      );
      await Promise.resolve();
    });
    expect(comparisonContainer.textContent).toContain("root refs/t3/checkpoints/dGhyZWFk/turn/0");
    expect(comparisonContainer.textContent).toContain(`first ${checkpoint}`);
  });
});
