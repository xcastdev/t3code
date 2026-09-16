/* @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

const fixture = vi.hoisted(() => ({
  compare: vi.fn(),
  refresh: vi.fn(),
  revision: 1,
  capabilities: undefined as { sourceControlWorkspace: boolean } | undefined,
  status: null as {
    workingTree: { snapshotId: string };
    headCommit: string;
    indexTree: string;
  } | null,
  error: null as string | null,
  route: { environmentId: "environment", threadId: "thread" },
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: ({ select }: { select?: (params: unknown) => unknown } = {}) =>
    select ? select(fixture.route) : fixture.route,
}));
vi.mock("~/threadRoutes", () => ({ resolveThreadRouteRef: () => fixture.route }));
const atoms = vi.hoisted(() => ({ config: Symbol("config"), revision: Symbol("revision") }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: symbol) =>
    atom === atoms.config
      ? fixture.capabilities === undefined
        ? undefined
        : { environment: { capabilities: fixture.capabilities } }
      : fixture.revision,
}));
vi.mock("~/state/server", () => ({ serverEnvironment: { configValueAtom: () => atoms.config } }));
vi.mock("~/state/sourceControl", () => ({
  sourceControlWorkspaceEnvironment: {
    compareRepositoryFile: Symbol("compare-repository-file"),
    status: () => Symbol("repository-status"),
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: fixture.status,
    error: fixture.error,
    isPending: false,
    isSuccess: fixture.error === null && fixture.status !== null,
    refresh: fixture.refresh,
  }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => fixture.compare }));

import { SecondaryPaneDiffPanel } from "./SecondaryPaneDiffPanel";
import {
  openRepositoryComparison,
  selectThreadSecondaryPaneState,
  useSecondaryPaneStore,
} from "~/secondaryPaneStore";

const environmentId = EnvironmentId.make("environment");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread"));
const roots: Root[] = [];
const branchComparison = {
  repositoryRoot: "/repo",
  comparison: "branch" as const,
  oldPath: "src/file.ts",
  newPath: "src/file.ts",
  baseRef: "main",
  headRef: "feature",
  baseRevision: "a".repeat(40),
  headRevision: "b".repeat(40),
};

function activeDiffSurface() {
  const surface = selectThreadSecondaryPaneState(
    useSecondaryPaneStore.getState().byThreadKey,
    threadRef,
  ).surfaces[0];
  if (!surface || surface.kind !== "diff") throw new Error("Expected an open diff surface.");
  return surface;
}

function Harness() {
  return (
    <SecondaryPaneDiffPanel
      environmentId={environmentId}
      cwd="/repo"
      surface={activeDiffSurface()}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.revision = 1;
  fixture.capabilities = { sourceControlWorkspace: true };
  fixture.status = null;
  fixture.error = null;
  fixture.refresh.mockReset();
  fixture.compare.mockReset();
  useSecondaryPaneStore.setState({ byThreadKey: {} });
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("refreshes a live tab when the delivered snapshot changes at the same revision", async () => {
  fixture.status = {
    workingTree: { snapshotId: "old" },
    headCommit: "a".repeat(40),
    indexTree: "b".repeat(40),
  };
  openRepositoryComparison(threadRef, {
    repositoryRoot: "/repo",
    comparison: "index",
    oldPath: "src/file.ts",
    newPath: "src/file.ts",
    indexTree: "b".repeat(40),
    snapshotId: "old",
    liveBase: "head",
  });
  fixture.compare.mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: {
      oldContents: "before",
      newContents: input.descriptor.headRevision,
      binary: false,
      available: true,
      descriptor: input.descriptor,
    },
  }));
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  expect(fixture.compare).toHaveBeenCalledTimes(1);

  // Source Control can publish its revision before the new status value is
  // observable. Once status delivers at that same revision, the live tuple
  // must drive exactly one updated comparison.
  fixture.revision = 2;
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  fixture.status = {
    workingTree: { snapshotId: "new" },
    headCommit: "c".repeat(40),
    indexTree: "d".repeat(40),
  };
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  expect(fixture.compare).toHaveBeenCalledTimes(3);
  expect(node.textContent).toContain("d".repeat(40));
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  expect(fixture.compare).toHaveBeenCalledTimes(3);
});

it("restores a retained comparison scroll position after unmount and remount", async () => {
  openRepositoryComparison(threadRef, branchComparison);
  fixture.compare.mockResolvedValue({
    _tag: "Success",
    value: {
      oldContents: "before\\n".repeat(100),
      newContents: "after\\n".repeat(100),
      binary: false,
      available: true,
    },
  });
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  const scroller = node.firstElementChild as HTMLElement;
  scroller.scrollTop = 140;
  await act(async () => scroller.dispatchEvent(new Event("scroll")));
  await act(async () => root.render(null));
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  expect((node.firstElementChild as HTMLElement).scrollTop).toBe(140);
});

it("recovers a failed live status through Retry", async () => {
  fixture.error = "status disconnected";
  openRepositoryComparison(threadRef, {
    repositoryRoot: "/repo",
    comparison: "index",
    oldPath: "src/file.ts",
    newPath: "src/file.ts",
    indexTree: "b".repeat(40),
    snapshotId: "old",
    liveBase: "head",
  });
  fixture.refresh.mockImplementation(() => {
    fixture.error = null;
    fixture.status = {
      workingTree: { snapshotId: "recovered" },
      headCommit: "a".repeat(40),
      indexTree: "d".repeat(40),
    };
  });
  fixture.compare.mockResolvedValue({
    _tag: "Success",
    value: {
      oldContents: "before",
      newContents: "recovered contents",
      binary: false,
      available: true,
    },
  });
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  await act(async () => root.render(<Harness />));
  expect(node.textContent).toContain("Retry");
  expect(node.textContent).toContain("Close");
  await act(async () => {
    [...node.querySelectorAll("button")].find((button) => button.textContent === "Retry")!.click();
    await Promise.resolve();
  });
  expect(fixture.refresh).toHaveBeenCalledTimes(1);
  expect(node.textContent).toContain("recovered contents");
});

it("does not refresh a historical comparison when the repository revision moves", async () => {
  openRepositoryComparison(threadRef, branchComparison);
  fixture.compare.mockResolvedValue({
    _tag: "Success",
    value: { oldContents: "before", newContents: "pinned", binary: false, available: true },
  });
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  fixture.revision = 3;
  fixture.status = {
    workingTree: { snapshotId: "new" },
    headCommit: "c".repeat(40),
    indexTree: "d".repeat(40),
  };
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  expect(fixture.compare).toHaveBeenCalledTimes(1);
  expect(node.textContent).toContain("pinned");
});

it("waits for workspace capability negotiation before restoring a historical comparison", async () => {
  fixture.capabilities = undefined;
  openRepositoryComparison(threadRef, branchComparison);
  fixture.compare.mockResolvedValue({
    _tag: "Success",
    value: {
      oldContents: "before",
      newContents: "after negotiation",
      binary: false,
      available: true,
    },
  });
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  expect(fixture.compare).not.toHaveBeenCalled();

  fixture.capabilities = { sourceControlWorkspace: true };
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  expect(node.textContent).toContain("after negotiation");
});
