/* @vitest-environment happy-dom */

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, type PullRequestDetailView } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

const commands = vi.hoisted(() => ({
  compare: vi.fn(),
  fileContents: vi.fn(),
  refresh: vi.fn(),
}));
const workspaceConfig = vi.hoisted(() => Symbol("workspace-config"));
const queries = vi.hoisted(() => ({
  diff: {
    patch: [
      "diff --git a/src/file.ts b/src/file.ts",
      "index 1111111..2222222 100644",
      "--- a/src/file.ts",
      "+++ b/src/file.ts",
      "@@ -1 +1 @@",
      "-aggregate before",
      "+aggregate after",
    ].join("\n"),
    baseRevision: "a".repeat(40),
    headRevision: "b".repeat(40),
    truncated: false,
    nextCursor: null,
  },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomRefresh: () => commands.refresh,
  useAtomValue: (atom: symbol) =>
    atom === workspaceConfig
      ? { environment: { capabilities: { sourceControlWorkspace: true } } }
      : undefined,
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: ({ select }: { select?: (params: unknown) => unknown } = {}) => {
    const params = { environmentId: "environment", threadId: "thread" };
    return select ? select(params) : params;
  },
}));
vi.mock("~/threadRoutes", () => ({ resolveThreadRouteRef: () => threadRef }));
vi.mock("~/hooks/useLocalStorage", () => ({ useLocalStorage: () => [true, vi.fn()] }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => ({ diffLayout: "unified", wordWrap: false, diffFilesCollapsed: false }),
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: queries.diff,
    error: null,
    isPending: false,
    refresh: commands.refresh,
  }),
}));
vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: {
    diff: () => Symbol("pull-request-diff"),
    diffFileContents: Symbol("pull-request-file-contents"),
    threadComments: Symbol("pull-request-thread-comments"),
    threadReply: Symbol("pull-request-thread-reply"),
    threadResolution: Symbol("pull-request-thread-resolution"),
    reviewComment: Symbol("pull-request-review-comment"),
    reviewCommentDelete: Symbol("pull-request-review-comment-delete"),
    reviewSubmit: Symbol("pull-request-review-submit"),
  },
}));
vi.mock("~/state/sourceControl", () => ({
  sourceControlWorkspaceEnvironment: {
    compareRepositoryFile: Symbol("compare-repository-file"),
    status: () => Symbol("repository-status"),
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) =>
    String(atom).includes("pull-request-file-contents")
      ? commands.fileContents
      : String(atom).includes("compare-repository-file")
        ? commands.compare
        : vi.fn(),
}));
vi.mock("~/components/diffs/StyledDiffCodeView", () => ({
  StyledDiffCodeView: ({
    items,
    options,
  }: {
    items: ReadonlyArray<{ id: string; fileDiff: unknown }>;
    options: { loadDiffFiles: unknown };
  }) => {
    const [contents, setContents] = useState<{
      oldFile: { contents: string } | null;
      newFile: { contents: string };
    } | null>(null);
    return (
      <div data-testid="aggregate-diff" data-file-count={items.length}>
        Aggregate diff remains mounted
        {contents?.oldFile?.contents}
        {contents?.newFile.contents}
        <button
          type="button"
          onClick={async () => {
            const load = options.loadDiffFiles as (
              file: unknown,
            ) => Promise<{ oldFile: { contents: string } | null; newFile: { contents: string } }>;
            const item = items[0];
            if (item) setContents(await load(item.fileDiff));
          }}
        >
          Expand full content
        </button>
      </div>
    );
  },
}));
vi.mock("~/components/diffs/DiffFileTree", () => ({
  DiffFileTree: ({ onSelectFile }: { onSelectFile: (path: string) => void }) => (
    <button type="button" onClick={() => onSelectFile("src/file.ts")}>
      Open src/file.ts
    </button>
  ),
}));
vi.mock("./PullRequestReviewAnnotation", () => ({
  PendingReviewCommentCard: () => null,
  ReviewThreadCard: () => null,
}));
vi.mock("./PullRequestReviewBar", () => ({ PullRequestReviewBar: () => null }));
vi.mock("./pullRequestPresentation", () => ({
  PullRequestDiffStat: () => null,
  PullRequestMetaLine: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("./pullRequestReviewStore", () => ({
  nextPendingReviewCommentId: () => "pending",
  pullRequestReviewKey: () => "pull-request",
  usePendingReviewComments: () => [],
  usePullRequestReviewStore: (
    select: (store: { addComment: () => void; removeComment: () => void }) => unknown,
  ) => select({ addComment: vi.fn(), removeComment: vi.fn() }),
}));
vi.mock("~/components/ui/menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipPopup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: () => workspaceConfig },
}));

import PullRequestCodeTab, { buildPullRequestFileComparison } from "./PullRequestCodeTab";
import { selectThreadSecondaryPaneState, useSecondaryPaneStore } from "~/secondaryPaneStore";
import { SecondaryPaneDiffPanel } from "../workspace/SecondaryPaneDiffPanel";

const environmentId = EnvironmentId.make("environment");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread"));
const roots: Root[] = [];
const detail = {
  workspaceRoot: "/workspace",
  baseBranch: "main",
  baseRevision: "c".repeat(40),
  headRevision: "d".repeat(40),
  number: 42,
  provider: "github",
  capabilities: { review: { inlineComment: false, reply: false, resolve: false, verdicts: [] } },
  viewerPermissions: { comment: false, resolve: false, verdicts: [] },
  reviewThreads: [],
  commits: [],
} as unknown as PullRequestDetailView;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  commands.compare.mockReset().mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: {
      oldContents: `secondary before ${input.descriptor.baseRevision}`,
      newContents: `secondary after ${input.descriptor.headRevision}`,
      binary: false,
      available: true,
      descriptor: input.descriptor,
    },
  }));
  commands.fileContents.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { oldContents: "full before A", newContents: "full after A" },
  });
  useSecondaryPaneStore.setState({ byThreadKey: {} });
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("opens the rendered PR file with its aggregate snapshot while the aggregate remains mounted", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  await act(async () => {
    root.render(
      <PullRequestCodeTab
        environmentId={environmentId}
        reference={{ projectId: ProjectId.make("project"), repository: "acme/web", number: 42 }}
        detail={detail}
        selectedCommitOid={null}
        onSelectedCommitChange={vi.fn()}
        onRefresh={vi.fn()}
        threadRef={threadRef}
      />,
    );
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });

  expect(container.textContent).toContain("Aggregate diff remains mounted");
  expect(
    container.querySelector("[data-testid='aggregate-diff']")?.getAttribute("data-file-count"),
  ).toBe("1");
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Expand full content")!
      .click();
    await Promise.resolve();
  });
  expect(commands.fileContents).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40),
      oldPath: "src/file.ts",
      newPath: "src/file.ts",
    }),
  });
  expect(container.textContent).toContain("full before A");
  expect(container.textContent).toContain("full after A");

  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Open src/file.ts")!
      .click();
  });
  expect(container.textContent).toContain("Aggregate diff remains mounted");
  const surface = selectThreadSecondaryPaneState(
    useSecondaryPaneStore.getState().byThreadKey,
    threadRef,
  ).surfaces.find((candidate) => candidate.kind === "diff");
  expect(surface).toMatchObject({
    kind: "diff",
    repositoryRoot: "/workspace",
    comparison: "pull-request",
    oldPath: "src/file.ts",
    newPath: "src/file.ts",
    descriptor: {
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40),
    },
  });
  if (!surface || surface.kind !== "diff") throw new Error("Expected an opened pull-request diff.");
  const secondaryNode = document.createElement("div");
  document.body.append(secondaryNode);
  const secondaryRoot = createRoot(secondaryNode);
  roots.push(secondaryRoot);
  await act(async () => {
    secondaryRoot.render(
      <SecondaryPaneDiffPanel environmentId={environmentId} cwd="/wrong" surface={surface} />,
    );
    await Promise.resolve();
  });
  expect(secondaryNode.textContent).toContain(`secondary before ${"a".repeat(40)}`);
  expect(secondaryNode.textContent).toContain(`secondary after ${"b".repeat(40)}`);
  expect(commands.compare).toHaveBeenCalledTimes(1);
  // The whole aggregate remains authoritative A even after the detail tab renders B.
  expect(container.textContent).toContain("full before A");
  expect(container.textContent).toContain("full after A");
});

it("renders a selected PR commit through the aggregate tree and keeps its commit pair pinned", async () => {
  const selected = "e".repeat(40);
  commands.fileContents.mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: {
      oldContents: `selected before ${input.commit}`,
      newContents: `selected after ${input.commit}`,
    },
  }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <PullRequestCodeTab
        environmentId={environmentId}
        reference={{ projectId: ProjectId.make("project"), repository: "acme/web", number: 42 }}
        detail={detail}
        selectedCommitOid={selected}
        onSelectedCommitChange={vi.fn()}
        onRefresh={vi.fn()}
        threadRef={threadRef}
      />,
    );
    await Promise.resolve();
  });
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Expand full content")!
      .click();
    await Promise.resolve();
  });
  expect(commands.fileContents).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({ commit: selected }),
  });
  expect(container.textContent).toContain(`selected before ${selected}`);
  expect(container.textContent).toContain(`selected after ${selected}`);
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Open src/file.ts")!
      .click();
  });
  const surface = selectThreadSecondaryPaneState(
    useSecondaryPaneStore.getState().byThreadKey,
    threadRef,
  ).surfaces.find((candidate) => candidate.kind === "diff");
  if (!surface || surface.kind !== "diff")
    throw new Error("Expected selected commit diff surface.");
  expect(surface).toMatchObject({
    commitSha: selected,
    descriptor: { headRevision: selected },
  });
  const secondaryNode = document.createElement("div");
  document.body.append(secondaryNode);
  const secondaryRoot = createRoot(secondaryNode);
  roots.push(secondaryRoot);
  await act(async () => {
    secondaryRoot.render(
      <SecondaryPaneDiffPanel environmentId={environmentId} cwd="/wrong" surface={surface} />,
    );
    await Promise.resolve();
  });
  expect(secondaryNode.textContent).toContain(`secondary after ${selected}`);
  expect(container.textContent).toContain(`selected before ${selected}`);
  expect(container.textContent).toContain(`selected after ${selected}`);
  expect(container.textContent).toContain("Aggregate diff remains mounted");
});

it("opens a PR file from the host-pinned revisions rather than branch names or commit dates", () => {
  expect(
    buildPullRequestFileComparison({
      detail: {
        workspaceRoot: "/workspace",
        baseRevision: "a".repeat(40),
        headRevision: "b".repeat(40),
      },
      reference: { host: "github.example", repository: "fork/web", number: 42 },
      oldPath: "src/old.ts",
      newPath: "src/new.ts",
      selectedCommitOid: null,
    }),
  ).toMatchObject({
    repositoryRoot: "/workspace",
    baseRevision: "a".repeat(40),
    headRevision: "b".repeat(40),
    pullRequestId: "github.example:fork/web#42",
  });
});

it("uses the rendered aggregate slice's immutable pair when detail has already refreshed", () => {
  const comparison = buildPullRequestFileComparison({
    detail: {
      workspaceRoot: "/workspace",
      baseBranch: "main",
      baseRevision: "c".repeat(40),
      headRevision: "d".repeat(40),
    },
    reference: { host: "github.example", repository: "acme/web", number: 42 },
    oldPath: "README.md",
    newPath: "README.md",
    selectedCommitOid: null,
    aggregateRevisions: { baseRevision: "a".repeat(40), headRevision: "b".repeat(40) },
  });
  expect(comparison).toMatchObject({
    baseRevision: "a".repeat(40),
    headRevision: "b".repeat(40),
    baseRef: "main",
  });
});

it("pins a selected PR commit and lets its parent remain the comparison base", () => {
  const comparison = buildPullRequestFileComparison({
    detail: {
      workspaceRoot: "/workspace",
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40),
    },
    reference: { repository: "acme/web", number: 7 },
    oldPath: null,
    newPath: "src/added.ts",
    selectedCommitOid: "c".repeat(40),
  });
  expect(comparison).toMatchObject({
    oldPath: null,
    newPath: "src/added.ts",
    headRevision: "c".repeat(40),
    commitSha: "c".repeat(40),
  });
  expect("baseRevision" in comparison).toBe(false);
});
