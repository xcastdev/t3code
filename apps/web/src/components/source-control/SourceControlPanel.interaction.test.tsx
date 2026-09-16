/* @vitest-environment happy-dom */

import * as Cause from "effect/Cause";
import { act, cloneElement, isValidElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, type VcsStatusResult } from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/unstable/reactivity";

const commands = vi.hoisted(() => ({
  commit: vi.fn(),
  diff: vi.fn(),
  discover: vi.fn(),
  generate: vi.fn(),
  graph: vi.fn(),
  graphFiles: vi.fn(),
  init: vi.fn(),
  refresh: vi.fn(),
  runAction: vi.fn(),
  stage: vi.fn(),
  unstage: vi.fn(),
}));

const statusQuery = vi.hoisted(() => ({
  data: null as VcsStatusResult | null,
  isPending: false,
  error: null as string | null,
}));
const statusByCwd = vi.hoisted(() => new Map<string, VcsStatusResult>());
const refsQuery = vi.hoisted(() => ({
  data: { refs: [] },
  isPending: false,
}));
const observed = vi.hoisted(() => ({
  pullRequestTargets: [] as unknown[],
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (target: symbol | { kind: "status"; cwd: string } | null) =>
    target === vcsAtoms.refs
      ? refsQuery
      : typeof target === "object" && target !== null && target.kind === "status"
        ? { ...statusQuery, data: statusByCwd.get(target.cwd) ?? statusQuery.data }
        : statusQuery,
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: symbol) => {
    if (command === vcsAtoms.commit) return commands.commit;
    if (command === vcsAtoms.diff) return commands.diff;
    if (command === vcsAtoms.discover) return commands.discover;
    if (command === vcsAtoms.generate) return commands.generate;
    if (command === vcsAtoms.graph) return commands.graph;
    if (command === vcsAtoms.graphFiles) return commands.graphFiles;
    if (command === vcsAtoms.init) return commands.init;
    if (command === vcsAtoms.refresh) return commands.refresh;
    if (command === vcsAtoms.runAction) return commands.runAction;
    if (command === vcsAtoms.stage) return commands.stage;
    return commands.unstage;
  },
}));

const vcsAtoms = vi.hoisted(() => ({
  commit: Symbol("commit"),
  diff: Symbol("diff"),
  discover: Symbol("discover"),
  generate: Symbol("generate"),
  graph: Symbol("graph"),
  graphFiles: Symbol("graphFiles"),
  init: Symbol("init"),
  refresh: Symbol("refresh"),
  refs: Symbol("refs"),
  runAction: Symbol("runAction"),
  stage: Symbol("stage"),
  status: Symbol("status"),
  unstage: Symbol("unstage"),
}));

vi.mock("~/state/sourceControl", () => ({
  sourceControlWorkspaceEnvironment: {
    commitIndex: vcsAtoms.commit,
    discoverRepositories: vcsAtoms.discover,
    getWorkingTreeDiff: vcsAtoms.diff,
    generateCommitMessage: vcsAtoms.generate,
    commitGraphPage: vcsAtoms.graph,
    commitFiles: vcsAtoms.graphFiles,
    refreshStatus: vcsAtoms.refresh,
    runAction: vcsAtoms.runAction,
    stageFiles: vcsAtoms.stage,
    status: ({ input }: { input: { cwd: string } }) => ({
      kind: "status" as const,
      cwd: input.cwd,
    }),
    unstageFiles: vcsAtoms.unstage,
    init: vcsAtoms.init,
    listRefs: () => vcsAtoms.refs,
    workingTreePage: Symbol("workingTreePage"),
  },
}));

vi.mock("../BranchToolbarBranchSelector", () => ({
  BranchToolbarBranchSelector: ({
    selectedRepositoryRoot,
  }: {
    selectedRepositoryRoot?: string | null;
  }) => <div data-branch-root={selectedRepositoryRoot ?? ""} />,
}));
vi.mock("./SourceControlActions", () => ({
  default: ({ gitCwd, target }: { gitCwd: string | null; target: HTMLElement | null }) => (
    <div data-menu-root={gitCwd ?? ""} data-menu-mounted={target !== null} />
  ),
}));
vi.mock("./PublishRepositoryDialog", () => ({
  PublishRepositoryDialog: ({ open }: { open: boolean }) =>
    open ? <div>Publish repository wizard</div> : null,
}));
vi.mock("../pullRequest/PullRequestDetailPanel", () => ({
  PullRequestDetailPanel: ({ reference }: { reference: { repositoryRoot?: string } }) => (
    <div data-pull-request-root={reference.repositoryRoot ?? ""} />
  ),
}));
vi.mock("../pullRequest/PullRequestGhosts", () => ({
  PullRequestListGhost: () => <div />,
}));
vi.mock("../pullRequest/PullRequestRow", () => ({
  PullRequestRow: ({ entry, onSelect }: { entry: unknown; onSelect: (entry: unknown) => void }) => (
    <button type="button" data-pull-request-row onClick={() => onSelect(entry)}>
      Open pull request
    </button>
  ),
}));
vi.mock("../pullRequest/PullRequestsUnavailableState", () => ({
  PullRequestsUnavailableState: () => <div />,
}));
vi.mock("~/state/pullRequests", () => ({
  usePullRequestList: (targets: unknown) => {
    observed.pullRequestTargets.push(targets);
    return {
      data: {
        entries: [
          {
            environmentId: "environment",
            projectId: "project",
            host: "github.com",
            repository: "acme/web",
            number: 7,
          },
        ],
      },
      refresh: vi.fn(),
    };
  },
}));
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children, ...props }: React.ComponentProps<"div">) => (
    <div data-scroll-area {...props}>
      {children}
    </div>
  ),
}));
vi.mock("../ui/textarea", () => ({
  Textarea: (props: React.ComponentProps<"textarea">) => <textarea {...props} />,
}));
vi.mock("../ui/button", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: React.ComponentProps<"button"> & {
    size?: unknown;
    variant?: unknown;
  }) => <button {...props} />,
}));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  AlertDialogClose: ({
    render,
    children,
  }: {
    render: React.ReactNode;
    children: React.ReactNode;
  }) => (isValidElement(render) ? cloneElement(render, {}, children) : render),
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));
import {
  buildSourceControlCommitInput,
  canSubmitSourceControlCommit,
  handleSourceControlCommitFailure,
} from "./sourceControlPanel.logic.ts";
import {
  clearSourceControlComposerSessionDrafts,
  sourceControlWorkspaceRevisionAtom,
} from "@t3tools/client-runtime/state/sourceControlWorkspace";
import { SourceControlPanel, type SourceControlPanelProps } from "./SourceControlPanel";
import { useRightPanelStore } from "~/rightPanelStore";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");
const projectId = ProjectId.make("project");
const roots: Root[] = [];
let atomRegistry = AtomRegistry.make();

const reviewedStatus: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: true,
  refName: "main",
  localRevision: "head\\0index",
  headCommit: "head",
  indexTree: "index",
  hasWorkingTreeChanges: true,
  workingTree: {
    files: [{ path: "src/file.ts", insertions: 2, deletions: 1, indexStatus: "both" }],
    insertions: 2,
    deletions: 1,
  },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

function panel(overrides: Partial<SourceControlPanelProps> = {}) {
  return (
    <SourceControlPanel
      cwd="/repo"
      environmentId={environmentId}
      envLocked={false}
      gitIndexWorkflowCapabilityKnown
      onViewChange={() => undefined}
      projectId={projectId}
      pullRequestsCapabilityKnown
      supportsGitIndexWorkflow
      supportsPullRequests={false}
      threadId={threadId}
      threadRef={{ environmentId, threadId }}
      view="changes"
      {...overrides}
    />
  );
}

async function renderPanel(overrides: Partial<SourceControlPanelProps> = {}): Promise<Root> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <RegistryContext.Provider value={atomRegistry}>{panel(overrides)}</RegistryContext.Provider>,
    );
  });
  return root;
}

async function rerenderPanel(
  root: Root,
  overrides: Partial<SourceControlPanelProps>,
): Promise<void> {
  await act(async () => {
    root.render(
      <RegistryContext.Provider value={atomRegistry}>{panel(overrides)}</RegistryContext.Provider>,
    );
  });
}

function button(label: string): HTMLButtonElement {
  const element = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  expect(element).toBeDefined();
  return element!;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

async function input(element: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(element, value);
  await act(async () => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function selectValue(element: HTMLSelectElement, value: string): Promise<void> {
  element.value = value;
  await act(async () => {
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function reviseRepository(): Promise<void> {
  await act(async () => {
    atomRegistry.update(
      sourceControlWorkspaceRevisionAtom({ environmentId, repositoryRoot: "/repo" }),
      (revision) => revision + 1,
    );
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((next) => {
      resolve = next;
    }),
    resolve,
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  atomRegistry = AtomRegistry.make();
  window.localStorage.clear();
  clearSourceControlComposerSessionDrafts();
  observed.pullRequestTargets = [];
  statusByCwd.clear();
  refsQuery.data = { refs: [] };
  useRightPanelStore.setState({ sourceControlRepositoryRootByThreadKey: {} });
  statusQuery.data = reviewedStatus;
  commands.commit
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { commitSha: "commit" } });
  commands.diff.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { diff: "", truncated: false },
  });
  commands.discover.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      projectRoot: "/repo",
      repositories: [
        { rootPath: "/repo", capabilities: { supportsIndexWorkflow: true } },
        { rootPath: "/repo/packages/app", capabilities: { supportsIndexWorkflow: true } },
      ],
      truncated: false,
    },
  });
  commands.generate.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { message: "generated message" },
  });
  commands.graph.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { commits: [], nextCursor: null },
  });
  commands.graphFiles.mockReset().mockResolvedValue({ _tag: "Success", value: { files: [] } });
  commands.refresh.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  commands.runAction.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { action: "push", completed: ["push"] },
  });
  commands.stage.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  commands.unstage.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("SourceControlPanel guarded commit interaction", () => {
  it("does not activate additive workspace RPCs on an older server", async () => {
    await renderPanel({
      sourceControlWorkspaceCapabilityKnown: true,
      supportsSourceControlWorkspace: false,
    });
    expect(document.body.textContent).toContain("Update the connected T3 Code server");
    expect(commands.generate).not.toHaveBeenCalled();
  });
  it("provides a full-width named ancestor for responsive action labels", async () => {
    commands.discover.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        projectRoot: "/repo",
        repositories: [{ rootPath: "/repo", capabilities: { supportsIndexWorkflow: true } }],
        truncated: false,
      },
    });
    await renderPanel();
    await settle();

    const target = document.querySelector("[data-source-control-actions-target]");
    expect(target).not.toBeNull();
    expect(target?.parentElement?.classList.contains("@container/header-actions")).toBe(true);
    expect(target?.parentElement?.classList.contains("w-full")).toBe(true);
  });

  it("renders connected graph columns without a visible SHA and pages from an observer", async () => {
    const sha = "a".repeat(40);
    const parent = "b".repeat(40);
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(private readonly callback: IntersectionObserverCallback) {}
        disconnect() {}
        observe(target: Element) {
          this.callback(
            [{ isIntersecting: true, target } as IntersectionObserverEntry],
            this as never,
          );
        }
        unobserve() {}
        takeRecords() {
          return [];
        }
        readonly root = null;
        readonly rootMargin = "0px";
        readonly thresholds = [];
      },
    );
    commands.graph.mockImplementation(({ input }: { input: { cursor: unknown } }) =>
      Promise.resolve({
        _tag: "Success",
        value:
          input.cursor === null
            ? {
                commits: [
                  {
                    sha,
                    parents: [parent],
                    authorTimestamp: 1,
                    subject: "Connected commit",
                    refs: [],
                    lane: 0,
                    edges: [{ from: 0, to: 1 }],
                  },
                ],
                nextCursor: { offset: 1, lanes: [parent] },
                hasMore: true,
              }
            : { commits: [], nextCursor: null, hasMore: false },
      }),
    );

    await renderPanel({ view: "graph" });
    await settle();
    await settle();

    expect(document.body.textContent).toContain("Connected commit");
    expect(document.body.textContent).not.toContain(sha);
    expect(document.querySelector('[data-graph-lane="0"]')).not.toBeNull();
    expect(document.querySelector('[data-graph-edge="0-1"]')).not.toBeNull();
    expect(commands.graph.mock.calls.map(([call]) => call.input.cursor)).toContainEqual({
      offset: 1,
      lanes: [parent],
    });
  });

  it("keeps graph lanes in fixed pixel columns across the expanded commit row", async () => {
    const sha = "a".repeat(40);
    commands.graph.mockResolvedValue({
      _tag: "Success",
      value: {
        commits: [
          {
            sha,
            parents: [],
            authorTimestamp: 1,
            subject: "Expanded graph commit",
            refs: [],
            lane: 0,
            edges: [{ from: 0, to: 0 }],
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    });
    commands.graphFiles.mockResolvedValue({
      _tag: "Success",
      value: { files: [{ oldPath: null, newPath: "expanded.ts", status: "added" }] },
    });

    await renderPanel({ view: "graph" });
    await settle();
    await click(button("Expanded graph commit"));
    await settle();

    const row = button("Expanded graph commit").closest('[role="listitem"]')!;
    const graph = row.querySelector<SVGElement>("[data-graph-lanes]")!;
    expect(graph.parentElement).toBe(row);
    expect(graph.getAttribute("viewBox")).toBeNull();
    expect(graph.getAttribute("height")).toBe("100%");
    expect(graph.querySelector('[data-graph-edge="0-0"]')?.getAttribute("y2")).toBe("100%");
    expect(row.textContent).toContain("expanded.ts");
  });

  it("defers merge files until a parent is selected and requests that parent", async () => {
    const sha = "c".repeat(40);
    const firstParent = "d".repeat(40);
    const secondParent = "e".repeat(40);
    commands.graph.mockResolvedValue({
      _tag: "Success",
      value: {
        commits: [
          {
            sha,
            parents: [firstParent, secondParent],
            authorTimestamp: 1,
            subject: "Merge commit",
            refs: [],
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    });

    await renderPanel({ view: "graph" });
    await settle();
    await click(button("Merge commit"));
    expect(commands.graphFiles).not.toHaveBeenCalled();
    await click(button("Parent 2"));
    await settle();

    expect(commands.graphFiles).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/repo", commitSha: sha, parentSha: secondParent },
    });
  });

  it("keeps merge parent selection reversible and exposes a failed file request for retry", async () => {
    const sha = "f".repeat(40);
    const firstParent = "a".repeat(40);
    const secondParent = "b".repeat(40);
    commands.graph.mockResolvedValue({
      _tag: "Success",
      value: {
        commits: [
          {
            sha,
            parents: [firstParent, secondParent],
            authorTimestamp: 1,
            subject: "Retry merge",
            refs: [],
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    });
    commands.graphFiles
      .mockResolvedValueOnce({ _tag: "Failure" })
      .mockResolvedValueOnce({ _tag: "Success", value: { files: [] } });

    await renderPanel({ view: "graph" });
    await settle();
    await click(button("Retry merge"));
    await click(button("Parent 2"));
    await settle();

    expect(button("Parent 1")).toBeDefined();
    expect(document.body.textContent).toContain("Unable to load changed files.");
    await click(button("Retry files"));
    await settle();
    expect(commands.graphFiles).toHaveBeenLastCalledWith({
      environmentId,
      input: { cwd: "/repo", commitSha: sha, parentSha: secondParent },
    });
  });

  it("retries the failed append cursor without observer-looping or restarting history", async () => {
    const sha = "a".repeat(40);
    const cursor = { offset: 1, lanes: ["b".repeat(40)] };
    let intersect: (() => void) | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(private readonly callback: IntersectionObserverCallback) {}
        disconnect() {}
        observe(target: Element) {
          intersect = () =>
            this.callback(
              [{ isIntersecting: true, target } as IntersectionObserverEntry],
              this as never,
            );
        }
        unobserve() {}
        takeRecords() {
          return [];
        }
        readonly root = null;
        readonly rootMargin = "0px";
        readonly thresholds = [];
      },
    );
    commands.graph.mockImplementation(({ input }: { input: { cursor: unknown } }) =>
      Promise.resolve(
        input.cursor === null
          ? {
              _tag: "Success",
              value: {
                commits: [
                  { sha, parents: [], authorTimestamp: 1, subject: "First page", refs: [] },
                ],
                nextCursor: cursor,
                hasMore: true,
              },
            }
          : commands.graph.mock.calls.filter(([call]) => call.input.cursor !== null).length === 1
            ? { _tag: "Failure" }
            : { _tag: "Success", value: { commits: [], nextCursor: null, hasMore: false } },
      ),
    );

    await renderPanel({ view: "graph" });
    await settle();
    await settle();
    await act(async () => intersect?.());
    await settle();

    expect(document.body.textContent).toContain("Unable to load Git history.");
    const failedCalls = commands.graph.mock.calls.filter(([call]) => call.input.cursor !== null);
    expect(failedCalls).toHaveLength(1);
    await click(button("Retry"));
    await settle();
    expect(commands.graph).toHaveBeenLastCalledWith({
      environmentId,
      input: { cwd: "/repo", cursor, limit: 50 },
    });
  });

  it("reconciles a refresh without dropping an expanded loaded commit", async () => {
    const sha = "c".repeat(40);
    commands.graph.mockResolvedValue({
      _tag: "Success",
      value: {
        commits: [
          { sha, parents: [], authorTimestamp: 1, subject: "Retained selection", refs: [] },
        ],
        nextCursor: null,
        hasMore: false,
      },
    });
    const root = await renderPanel({ view: "graph" });
    await settle();
    const commit = button("Retained selection");
    await click(commit);
    expect(commit.getAttribute("aria-expanded")).toBe("true");

    refsQuery.data = { refs: [{ name: "main", current: true, isDefault: true }] } as never;
    await rerenderPanel(root, { view: "graph" });
    await settle();

    expect(button("Retained selection").getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the initial graph request page-sized when status first becomes available", async () => {
    const firstPage = deferred<{
      _tag: "Success";
      value: {
        commits: Array<{
          sha: string;
          parents: string[];
          authorTimestamp: number;
          subject: string;
          refs: [];
        }>;
        nextCursor: null;
        hasMore: false;
      };
    }>();
    const sha = "a".repeat(40);
    statusQuery.data = null;
    commands.graph.mockReturnValue(firstPage.promise);

    const root = await renderPanel({ view: "graph" });
    await settle();
    statusQuery.data = reviewedStatus;
    await rerenderPanel(root, { view: "graph" });
    await settle();
    expect(commands.graph).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstPage.resolve({
        _tag: "Success",
        value: {
          commits: [{ sha, parents: [], authorTimestamp: 1, subject: "Initial page", refs: [] }],
          nextCursor: null,
          hasMore: false,
        },
      });
      await firstPage.promise;
    });
    await settle();

    expect(commands.graph).toHaveBeenCalledTimes(1);
    expect(button("Initial page")).toBeDefined();
  });

  it("replays a revision observed before the first status result arrives", async () => {
    const oldPage = deferred<{
      _tag: "Success";
      value: {
        commits: Array<{
          sha: string;
          parents: string[];
          authorTimestamp: number;
          subject: string;
          refs: [];
        }>;
        nextCursor: null;
        hasMore: false;
      };
    }>();
    const oldSha = "a".repeat(40);
    const newSha = "b".repeat(40);
    statusQuery.data = null;
    commands.graph.mockReturnValueOnce(oldPage.promise).mockResolvedValue({
      _tag: "Success",
      value: {
        commits: [
          {
            sha: newSha,
            parents: [],
            authorTimestamp: 2,
            subject: "Revision after status",
            refs: [],
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    });

    const root = await renderPanel({ view: "graph" });
    await settle();
    await reviseRepository();
    statusQuery.data = { ...reviewedStatus, headCommit: newSha };
    await rerenderPanel(root, { view: "graph" });
    await settle();
    expect(commands.graph).toHaveBeenCalledTimes(1);

    await act(async () => {
      oldPage.resolve({
        _tag: "Success",
        value: {
          commits: [
            {
              sha: oldSha,
              parents: [],
              authorTimestamp: 1,
              subject: "Stale before status",
              refs: [],
            },
          ],
          nextCursor: null,
          hasMore: false,
        },
      });
      await oldPage.promise;
    });
    await settle();
    await settle();

    expect(commands.graph).toHaveBeenCalledTimes(2);
    expect(button("Revision after status")).toBeDefined();
    expect(document.body.textContent).not.toContain("Stale before status");
  });

  it("replays an invalidated empty initial graph after its deferred response settles", async () => {
    const emptyPage = deferred<{
      _tag: "Success";
      value: { commits: []; nextCursor: null; hasMore: false };
    }>();
    const firstCommit = "c".repeat(40);
    commands.graph.mockReturnValueOnce(emptyPage.promise).mockResolvedValue({
      _tag: "Success",
      value: {
        commits: [
          { sha: firstCommit, parents: [], authorTimestamp: 1, subject: "First commit", refs: [] },
        ],
        nextCursor: null,
        hasMore: false,
      },
    });

    await renderPanel({ view: "graph" });
    await settle();
    await reviseRepository();
    expect(commands.graph).toHaveBeenCalledTimes(1);

    await act(async () => {
      emptyPage.resolve({
        _tag: "Success",
        value: { commits: [], nextCursor: null, hasMore: false },
      });
      await emptyPage.promise;
    });
    await settle();
    await settle();

    expect(commands.graph).toHaveBeenCalledTimes(2);
    expect(button("First commit")).toBeDefined();
  });

  it("replays when a first commit follows a completed empty graph", async () => {
    const firstCommit = "d".repeat(40);
    commands.graph
      .mockResolvedValueOnce({
        _tag: "Success",
        value: { commits: [], nextCursor: null, hasMore: false },
      })
      .mockResolvedValue({
        _tag: "Success",
        value: {
          commits: [
            {
              sha: firstCommit,
              parents: [],
              authorTimestamp: 1,
              subject: "Commit after empty",
              refs: [],
            },
          ],
          nextCursor: null,
          hasMore: false,
        },
      });

    await renderPanel({ view: "graph" });
    await settle();
    expect(commands.graph).toHaveBeenCalledTimes(1);

    await reviseRepository();
    await settle();
    await settle();

    expect(commands.graph).toHaveBeenCalledTimes(2);
    expect(button("Commit after empty")).toBeDefined();
  });

  it("replays the latest revision when it arrives during the initial graph request", async () => {
    const oldPage = deferred<{
      _tag: "Success";
      value: {
        commits: Array<{
          sha: string;
          parents: string[];
          authorTimestamp: number;
          subject: string;
          refs: [];
        }>;
        nextCursor: null;
        hasMore: false;
      };
    }>();
    const oldSha = "b".repeat(40);
    const newSha = "c".repeat(40);
    commands.graph.mockReturnValueOnce(oldPage.promise).mockResolvedValue({
      _tag: "Success",
      value: {
        commits: [{ sha: newSha, parents: [], authorTimestamp: 2, subject: "New graph", refs: [] }],
        nextCursor: null,
        hasMore: false,
      },
    });

    const root = await renderPanel({ view: "graph" });
    await settle();
    refsQuery.data = { refs: [{ name: "new-head", current: true, isDefault: true }] } as never;
    statusQuery.data = { ...reviewedStatus, headCommit: newSha };
    await rerenderPanel(root, { view: "graph" });
    await settle();
    expect(commands.graph).toHaveBeenCalledTimes(1);

    await act(async () => {
      oldPage.resolve({
        _tag: "Success",
        value: {
          commits: [
            { sha: oldSha, parents: [], authorTimestamp: 1, subject: "Old graph", refs: [] },
          ],
          nextCursor: null,
          hasMore: false,
        },
      });
      await oldPage.promise;
    });
    await settle();
    await settle();

    expect(commands.graph.mock.calls.map(([call]) => call.input)).toEqual([
      { cwd: "/repo", cursor: null, limit: 50 },
      { cwd: "/repo", cursor: null, limit: 50 },
    ]);
    expect(button("New graph")).toBeDefined();
    expect(document.body.textContent).not.toContain("Old graph");
  });

  it("replays every loaded graph page on refresh and continues from the refreshed cursor", async () => {
    const first = "a".repeat(40);
    const second = "b".repeat(40);
    const initialCursor = { offset: 1, lanes: ["c".repeat(40)] };
    const refreshedCursor = { offset: 1, lanes: ["d".repeat(40)] };
    let refreshed = false;
    commands.graph.mockImplementation(({ input }: { input: { cursor: unknown } }) =>
      Promise.resolve({
        _tag: "Success",
        value:
          input.cursor === null
            ? {
                commits: [
                  {
                    sha: first,
                    parents: [],
                    authorTimestamp: 1,
                    subject: refreshed ? "New HEAD" : "First page",
                    refs: [],
                  },
                ],
                nextCursor: refreshed ? refreshedCursor : initialCursor,
                hasMore: true,
              }
            : {
                commits: [
                  {
                    sha: second,
                    parents: [],
                    authorTimestamp: 1,
                    subject: refreshed ? "Updated second page" : "Second page",
                    refs: [],
                  },
                ],
                nextCursor: null,
                hasMore: false,
              },
      }),
    );

    const root = await renderPanel({ view: "graph" });
    await settle();
    const scrollArea = document
      .querySelector<HTMLElement>('[aria-label="Git history"]')!
      .closest<HTMLElement>("[data-scroll-area]")!;
    Object.defineProperties(scrollArea, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });
    await act(async () => {
      scrollArea.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await settle();
    expect(button("Second page")).toBeDefined();
    await click(button("Second page"));

    const refreshStart = commands.graph.mock.calls.length;
    refreshed = true;
    refsQuery.data = { refs: [{ name: "updated", current: true, isDefault: true }] } as never;
    await rerenderPanel(root, { view: "graph" });
    await settle();
    await settle();

    expect(button("Updated second page").getAttribute("aria-expanded")).toBe("true");
    expect(
      commands.graph.mock.calls.slice(refreshStart).map(([call]) => call.input.cursor),
    ).toEqual([null, refreshedCursor]);
  });

  it("keeps a new HEAD at the graph cap and ignores a late file response for an evicted commit", async () => {
    const oldRows = Array.from({ length: 500 }, (_, index) => ({
      sha: index === 499 ? "f".repeat(40) : index.toString(16).padStart(40, "0"),
      parents: [],
      authorTimestamp: index,
      subject: index === 499 ? "Evicted commit" : `Old ${index}`,
      refs: [],
    }));
    const newHead = "e".repeat(40);
    const delayedFiles = deferred<{
      _tag: "Success";
      value: { files: Array<{ oldPath: null; newPath: string; status: string }> };
    }>();
    let phase: "initial" | "evict" | "return" = "initial";
    commands.graph.mockImplementation(() =>
      Promise.resolve({
        _tag: "Success",
        value:
          phase === "initial"
            ? { commits: oldRows, nextCursor: null, hasMore: false }
            : phase === "evict"
              ? {
                  commits: [
                    {
                      sha: newHead,
                      parents: [],
                      authorTimestamp: 501,
                      subject: "New HEAD",
                      refs: [],
                    },
                    ...oldRows.slice(0, 499),
                    {
                      sha: "d".repeat(40),
                      parents: [],
                      authorTimestamp: 500,
                      subject: "Replacement tail",
                      refs: [],
                    },
                  ],
                  nextCursor: null,
                  hasMore: false,
                }
              : { commits: [oldRows[499]], nextCursor: null, hasMore: false },
      }),
    );
    commands.graphFiles.mockReturnValue(delayedFiles.promise);

    const root = await renderPanel({ view: "graph" });
    await settle();
    await click(button("Evicted commit"));
    phase = "evict";
    refsQuery.data = { refs: [{ name: "one", current: true, isDefault: true }] } as never;
    await rerenderPanel(root, { view: "graph" });
    await settle();
    expect(button("New HEAD")).toBeDefined();
    expect(document.body.textContent).not.toContain("Evicted commit");

    await act(async () => {
      delayedFiles.resolve({
        _tag: "Success",
        value: { files: [{ oldPath: null, newPath: "stale.ts", status: "added" }] },
      });
      await delayedFiles.promise;
    });
    phase = "return";
    refsQuery.data = { refs: [{ name: "two", current: true, isDefault: true }] } as never;
    await rerenderPanel(root, { view: "graph" });
    await settle();
    expect(button("Evicted commit").getAttribute("aria-expanded")).toBe("false");
    expect(document.body.textContent).not.toContain("stale.ts");
  });

  it("moves the bounded graph window forward when page eleven arrives", async () => {
    const rows = Array.from({ length: 550 }, (_, index) => ({
      sha: index.toString(16).padStart(40, "0"),
      parents: [],
      authorTimestamp: index,
      subject: `History ${index}`,
      refs: [],
    }));
    commands.graph.mockImplementation(
      ({ input }: { input: { cursor: { offset: number } | null } }) => {
        const offset = input.cursor?.offset ?? 0;
        return Promise.resolve({
          _tag: "Success",
          value: {
            commits: rows.slice(offset, offset + 50),
            nextCursor: offset + 50 < rows.length ? { offset: offset + 50, lanes: [] } : null,
            hasMore: offset + 50 < rows.length,
          },
        });
      },
    );

    const root = await renderPanel({ view: "graph" });
    await settle();
    const scrollArea = document
      .querySelector<HTMLElement>('[aria-label="Git history"]')!
      .closest<HTMLElement>("[data-scroll-area]")!;
    Object.defineProperties(scrollArea, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: 900, writable: true },
    });
    for (let index = 0; index < 10; index += 1) {
      await act(async () => scrollArea.dispatchEvent(new Event("scroll", { bubbles: true })));
      await settle();
    }

    expect(button("History 50")).toBeDefined();
    expect(button("History 549")).toBeDefined();
    expect(document.body.textContent).not.toContain("History 0");
    await rerenderPanel(root, { view: "graph" });
  });

  it("retains a selected tail commit while refreshing past a new HEAD", async () => {
    const oldRows = Array.from({ length: 500 }, (_, index) => ({
      sha: index === 499 ? "f".repeat(40) : index.toString(16).padStart(40, "0"),
      parents: [],
      authorTimestamp: index,
      subject: index === 499 ? "Selected tail" : `Old ${index}`,
      refs: [],
    }));
    const newHead = {
      sha: "e".repeat(40),
      parents: [],
      authorTimestamp: 501,
      subject: "New HEAD",
      refs: [],
    };
    let refreshed = false;
    commands.graph.mockImplementation(({ input }: { input: { cursor: unknown } }) =>
      Promise.resolve({
        _tag: "Success",
        value: !refreshed
          ? { commits: oldRows, nextCursor: null, hasMore: false }
          : input.cursor === null
            ? {
                commits: [newHead, ...oldRows.slice(0, 499)],
                nextCursor: { offset: 500, lanes: [] },
                hasMore: true,
              }
            : { commits: [oldRows[499]], nextCursor: null, hasMore: false },
      }),
    );

    const root = await renderPanel({ view: "graph" });
    await settle();
    await click(button("Selected tail"));
    refreshed = true;
    refsQuery.data = { refs: [{ name: "new-head", current: true, isDefault: true }] } as never;
    await rerenderPanel(root, { view: "graph" });
    await settle();
    await settle();

    expect(button("Selected tail").getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).not.toContain("New HEAD");
  });

  it("keeps a no-selection refresh anchored at the new HEAD", async () => {
    const oldRows = Array.from({ length: 500 }, (_, index) => ({
      sha: index.toString(16).padStart(40, "0"),
      parents: [],
      authorTimestamp: index,
      subject: `Old ${index}`,
      refs: [],
    }));
    const newHead = {
      sha: "f".repeat(40),
      parents: [],
      authorTimestamp: 501,
      subject: "New HEAD",
      refs: [],
    };
    let refreshed = false;
    commands.graph.mockImplementation(
      ({ input }: { input: { cursor: { offset: number } | null } }) => {
        const rows = refreshed ? [newHead, ...oldRows] : oldRows;
        const offset = input.cursor?.offset ?? 0;
        const nextOffset = offset + 50;
        return Promise.resolve({
          _tag: "Success",
          value: {
            commits: rows.slice(offset, nextOffset),
            nextCursor: nextOffset < rows.length ? { offset: nextOffset, lanes: [] } : null,
            hasMore: nextOffset < rows.length,
          },
        });
      },
    );

    const root = await renderPanel({ view: "graph" });
    await settle();
    const scrollArea = document
      .querySelector<HTMLElement>('[aria-label="Git history"]')!
      .closest<HTMLElement>("[data-scroll-area]")!;
    Object.defineProperties(scrollArea, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: 900, writable: true },
    });
    for (let index = 0; index < 9; index += 1) {
      await act(async () => scrollArea.dispatchEvent(new Event("scroll", { bubbles: true })));
      await settle();
    }

    refreshed = true;
    refsQuery.data = { refs: [{ name: "new-head", current: true, isDefault: true }] } as never;
    await rerenderPanel(root, { view: "graph" });
    await settle();

    expect(document.querySelector("[data-graph-row]")?.getAttribute("data-graph-row")).toBe(
      newHead.sha,
    );
    expect(button("New HEAD")).toBeDefined();
  });

  it("refreshes shallow protections in one page and enlarges only when history separates them", async () => {
    const oldRows = Array.from({ length: 600 }, (_, index) => ({
      sha: index.toString(16).padStart(40, "0"),
      parents: [],
      authorTimestamp: index,
      subject: `History ${index}`,
      refs: [],
    }));
    const newHead = {
      sha: "d".repeat(40),
      parents: [],
      authorTimestamp: 601,
      subject: "New HEAD",
      refs: [],
    };
    const cursorAt = (offset: number) => ({ offset, lanes: [] });
    const insertedRows = Array.from({ length: 40 }, (_, index) => ({
      sha: `i${index.toString(16).padStart(39, "0")}`,
      parents: [],
      authorTimestamp: 700 + index,
      subject: `Inserted ${index}`,
      refs: [],
    }));
    let phase: "initial" | "shallow" | "separated" = "initial";
    commands.graph.mockImplementation(
      ({ input }: { input: { cursor: { offset: number } | null; limit: number } }) => {
        const rows =
          phase === "initial"
            ? oldRows
            : phase === "shallow"
              ? [newHead, ...oldRows]
              : [...oldRows.slice(0, 21), ...insertedRows, ...oldRows.slice(21)];
        const offset = input.cursor?.offset ?? 0;
        const nextOffset = offset + input.limit;
        return Promise.resolve({
          _tag: "Success",
          value: {
            commits: rows.slice(offset, nextOffset),
            nextCursor: nextOffset < rows.length ? cursorAt(nextOffset) : null,
            hasMore: nextOffset < rows.length,
          },
        });
      },
    );

    const root = await renderPanel({ view: "graph" });
    await settle();
    const scrollArea = document
      .querySelector<HTMLElement>('[aria-label="Git history"]')!
      .closest<HTMLElement>("[data-scroll-area]")!;
    Object.defineProperties(scrollArea, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });
    Object.defineProperty(scrollArea, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 0 }),
    });
    const establishAnchor = (offsetTop: number) => {
      const anchor = document.querySelector<HTMLElement>(`[data-graph-row="${oldRows[20]!.sha}"]`)!;
      Object.defineProperties(anchor, {
        getBoundingClientRect: { configurable: true, value: () => ({ bottom: 20 }) },
        offsetTop: { configurable: true, value: offsetTop },
      });
    };
    establishAnchor(100);
    await act(async () => scrollArea.dispatchEvent(new Event("scroll", { bubbles: true })));
    await click(button("History 30"));

    phase = "shallow";
    const refreshStart = commands.graph.mock.calls.length;
    refsQuery.data = { refs: [{ name: "refresh", current: true, isDefault: true }] } as never;
    await rerenderPanel(root, { view: "graph" });
    await settle();

    const refreshCalls = commands.graph.mock.calls.slice(refreshStart);
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]?.[0]).toEqual({
      environmentId,
      input: { cwd: "/repo", cursor: null, limit: 50 },
    });
    expect(document.querySelectorAll("[data-graph-row]")).toHaveLength(50);

    // New rows can separate the same selected/visible pair beyond the loaded
    // 50-row page. Retain their exact 51-row interval rather than evicting the
    // visible anchor or doing a cap-sized replay.
    establishAnchor(100);
    await act(async () => scrollArea.dispatchEvent(new Event("scroll", { bubbles: true })));
    let animationFrame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrame = callback;
      return 1;
    });
    phase = "separated";
    const separatedRefreshStart = commands.graph.mock.calls.length;
    refsQuery.data = {
      refs: [{ name: "selected-refresh", current: true, isDefault: true }],
    } as never;
    await rerenderPanel(root, { view: "graph" });
    await settle();
    await settle();

    expect(
      commands.graph.mock.calls.slice(separatedRefreshStart).map(([call]) => call.input),
    ).toEqual([
      { cwd: "/repo", cursor: null, limit: 50 },
      { cwd: "/repo", cursor: cursorAt(50), limit: 50 },
      { cwd: "/repo", cursor: cursorAt(50), limit: 21 },
    ]);
    const retainedRows = [...document.querySelectorAll<HTMLElement>("[data-graph-row]")];
    expect(retainedRows.map((row) => row.dataset.graphRow)).toEqual(
      [...oldRows.slice(20, 21), ...insertedRows, ...oldRows.slice(21, 31)].map(
        (commit) => commit.sha,
      ),
    );
    expect(button("History 30").getAttribute("aria-expanded")).toBe("true");
    const refreshedAnchor = document.querySelector<HTMLElement>(
      `[data-graph-row="${oldRows[20]!.sha}"]`,
    )!;
    Object.defineProperty(refreshedAnchor, "offsetTop", { configurable: true, value: 140 });
    await act(async () => animationFrame?.(0));
    expect(scrollArea.scrollTop).toBe(140);

    Object.defineProperties(scrollArea, {
      scrollTop: { configurable: true, value: 900, writable: true },
    });
    await act(async () => scrollArea.dispatchEvent(new Event("scroll", { bubbles: true })));
    await settle();

    expect(commands.graph).toHaveBeenLastCalledWith({
      environmentId,
      input: { cwd: "/repo", cursor: cursorAt(71), limit: 50 },
    });
  });

  it("pages from the retained HEAD prefix when a selected commit disappeared beyond the graph cap", async () => {
    const selected = "f".repeat(40);
    const initialRows = Array.from({ length: 500 }, (_, index) => ({
      sha: index === 499 ? selected : index.toString(16).padStart(40, "0"),
      parents: [],
      authorTimestamp: index,
      subject: index === 499 ? "Disappeared selection" : `Initial ${index}`,
      refs: [],
      lane: index % 2,
      edges: [{ from: index % 2, to: (index + 1) % 2 }],
    }));
    const refreshedRows = Array.from({ length: 600 }, (_, index) => ({
      sha: (index + 1_000).toString(16).padStart(40, "0"),
      parents: [],
      authorTimestamp: index,
      subject: `Refreshed ${index}`,
      refs: [],
      lane: index % 2,
      edges: [{ from: index % 2, to: (index + 1) % 2 }],
    }));
    const cursorAt = (offset: number) => ({
      offset,
      lanes: [offset.toString(16).padStart(40, "0")],
    });
    let refreshed = false;
    commands.graph.mockImplementation(
      ({ input }: { input: { cursor: { offset: number } | null; limit: number } }) => {
        if (!refreshed) {
          return Promise.resolve({
            _tag: "Success",
            value: { commits: initialRows, nextCursor: null, hasMore: false },
          });
        }
        const offset = input.cursor?.offset ?? 0;
        const nextOffset = offset + input.limit;
        return Promise.resolve({
          _tag: "Success",
          value: {
            commits: refreshedRows.slice(offset, nextOffset),
            nextCursor: nextOffset < refreshedRows.length ? cursorAt(nextOffset) : null,
            hasMore: nextOffset < refreshedRows.length,
          },
        });
      },
    );

    const root = await renderPanel({ view: "graph" });
    await settle();
    await click(button("Disappeared selection"));
    const scrollArea = document
      .querySelector<HTMLElement>('[aria-label="Git history"]')!
      .closest<HTMLElement>("[data-scroll-area]")!;
    Object.defineProperties(scrollArea, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: 900, writable: true },
    });

    refreshed = true;
    refsQuery.data = { refs: [{ name: "refresh", current: true, isDefault: true }] } as never;
    await rerenderPanel(root, { view: "graph" });
    await settle();

    const renderedShas = () =>
      [...document.querySelectorAll<HTMLElement>("[data-graph-row]")].map(
        (row) => row.dataset.graphRow,
      );
    const renderedLanes = () =>
      [...document.querySelectorAll<HTMLElement>("[data-graph-row]")].map((row) => ({
        lane: row.querySelector("[data-graph-lane]")?.getAttribute("data-graph-lane"),
        edge: row.querySelector("[data-graph-edge]")?.getAttribute("data-graph-edge"),
      }));
    expect(renderedShas()).toEqual(refreshedRows.slice(0, 500).map((commit) => commit.sha));
    expect(
      renderedLanes().every(
        ({ lane, edge }, index, lanes) =>
          index === lanes.length - 1 || edge === `${lane}-${lanes[index + 1]?.lane}`,
      ),
    ).toBe(true);

    await act(async () => scrollArea.dispatchEvent(new Event("scroll", { bubbles: true })));
    await settle();

    expect(commands.graph).toHaveBeenLastCalledWith({
      environmentId,
      input: { cwd: "/repo", cursor: cursorAt(500), limit: 50 },
    });
    expect(renderedShas()).toEqual(refreshedRows.slice(50, 550).map((commit) => commit.sha));
    expect(
      renderedLanes().every(
        ({ lane, edge }, index, lanes) =>
          index === lanes.length - 1 || edge === `${lane}-${lanes[index + 1]?.lane}`,
      ),
    ).toBe(true);
  });

  it("keeps a selected refresh window contiguous before continuing history", async () => {
    const oldRows = Array.from({ length: 1_100 }, (_, index) => ({
      sha: index.toString(16).padStart(40, "0"),
      parents: [],
      authorTimestamp: index,
      subject: `History ${index}`,
      refs: [],
      lane: index % 2,
      edges: [{ from: index % 2, to: (index + 1) % 2 }],
    }));
    const newHead = {
      sha: "f".repeat(40),
      parents: [],
      authorTimestamp: 1_101,
      subject: "New HEAD",
      refs: [],
      lane: 0,
      edges: [{ from: 0, to: 1 }],
    };
    let refreshed = false;
    const cursorAt = (offset: number) => ({
      offset,
      lanes: [offset.toString(16).padStart(40, "0")],
    });
    commands.graph.mockImplementation(
      ({ input }: { input: { cursor: { offset: number } | null; limit: number } }) => {
        const rows = refreshed ? [newHead, ...oldRows] : oldRows;
        const offset = input.cursor?.offset ?? 0;
        const nextOffset = offset + input.limit;
        return Promise.resolve({
          _tag: "Success",
          value: {
            commits: rows.slice(offset, nextOffset).map((commit) => ({ ...commit })),
            nextCursor: nextOffset < rows.length ? cursorAt(nextOffset) : null,
            hasMore: nextOffset < rows.length,
          },
        });
      },
    );

    const root = await renderPanel({ view: "graph" });
    await settle();
    const scrollArea = document
      .querySelector<HTMLElement>('[aria-label="Git history"]')!
      .closest<HTMLElement>("[data-scroll-area]")!;
    Object.defineProperties(scrollArea, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: 900, writable: true },
    });
    for (let index = 0; index < 19; index += 1) {
      await act(async () => scrollArea.dispatchEvent(new Event("scroll", { bubbles: true })));
      await settle();
    }
    await click(button("History 999"));
    expect(document.querySelector(`[data-graph-row="${oldRows[500]!.sha}"]`)).not.toBeNull();
    let animationFrame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrame = callback;
      return 1;
    });
    Object.defineProperty(scrollArea, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 0 }),
    });
    const initialAnchor = document.querySelector<HTMLElement>(
      `[data-graph-row="${oldRows[500]!.sha}"]`,
    )!;
    Object.defineProperties(initialAnchor, {
      getBoundingClientRect: { configurable: true, value: () => ({ bottom: 20 }) },
      offsetTop: { configurable: true, value: 100 },
    });

    refreshed = true;
    const refreshStart = commands.graph.mock.calls.length;
    statusQuery.data = reviewedStatus;
    refsQuery.data = { refs: [{ name: "refresh", current: true, isDefault: true }] } as never;
    await rerenderPanel(root, { view: "graph" });
    await settle();

    const renderedShas = () =>
      [...document.querySelectorAll<HTMLElement>("[data-graph-row]")].map(
        (row) => row.dataset.graphRow,
      );
    const renderedLanes = () =>
      [...document.querySelectorAll<HTMLElement>("[data-graph-row]")].map((row) => ({
        lane: row.querySelector("[data-graph-lane]")?.getAttribute("data-graph-lane"),
        edge: row.querySelector("[data-graph-edge]")?.getAttribute("data-graph-edge"),
      }));
    expect(renderedShas()).toEqual(
      [newHead, ...oldRows].slice(501, 1_001).map((commit) => commit.sha),
    );
    expect(
      renderedLanes().every(
        ({ lane, edge }, index, lanes) =>
          index === lanes.length - 1 || edge === `${lane}-${lanes[index + 1]?.lane}`,
      ),
    ).toBe(true);
    expect(commands.graph.mock.calls.length).toBeGreaterThan(refreshStart);
    expect(commands.graph.mock.calls.slice(refreshStart).at(-1)?.[0].input).toEqual({
      cwd: "/repo",
      cursor: cursorAt(1_000),
      limit: 1,
    });
    const refreshedAnchor = document.querySelector<HTMLElement>(
      `[data-graph-row="${oldRows[500]!.sha}"]`,
    )!;
    Object.defineProperty(refreshedAnchor, "offsetTop", { configurable: true, value: 140 });
    expect(animationFrame).toBeDefined();
    await act(async () => animationFrame?.(0));
    expect(scrollArea.scrollTop).toBe(940);

    await act(async () => scrollArea.dispatchEvent(new Event("scroll", { bubbles: true })));
    await settle();

    expect(renderedShas()).toEqual(
      [newHead, ...oldRows].slice(551, 1_051).map((commit) => commit.sha),
    );
    expect(commands.graph).toHaveBeenLastCalledWith({
      environmentId,
      input: { cwd: "/repo", cursor: cursorAt(1_001), limit: 50 },
    });
    expect(
      renderedLanes().every(
        ({ lane, edge }, index, lanes) =>
          index === lanes.length - 1 || edge === `${lane}-${lanes[index + 1]?.lane}`,
      ),
    ).toBe(true);
  });

  it("keeps a deep selected row when a later anchor cannot fit in the graph cap", async () => {
    const selected = "a".repeat(40);
    const anchor = "b".repeat(40);
    const row = (index: number, sha: string, subject: string) => ({
      sha,
      parents: [],
      authorTimestamp: index,
      subject,
      refs: [],
      lane: index % 2,
      edges: [{ from: index % 2, to: (index + 1) % 2 }],
    });
    const initialRows = Array.from({ length: 50 }, (_, index) =>
      row(
        index,
        index === 20 ? anchor : index === 30 ? selected : index.toString(16).padStart(40, "0"),
        index === 20
          ? "Visible anchor"
          : index === 30
            ? "Selected after rewrite"
            : `Initial ${index}`,
      ),
    );
    const refreshedRows = Array.from({ length: 2_000 }, (_, index) =>
      row(
        index,
        index === 700
          ? selected
          : index === 1_500
            ? anchor
            : (index + 1_000).toString(16).padStart(40, "0"),
        index === 700
          ? "Selected after rewrite"
          : index === 1_500
            ? "Visible anchor"
            : `Refreshed ${index}`,
      ),
    );
    const cursorAt = (offset: number) => ({
      offset,
      lanes: [offset.toString(16).padStart(40, "0")],
    });
    let refreshed = false;
    commands.graph.mockImplementation(
      ({ input }: { input: { cursor: { offset: number } | null; limit: number } }) => {
        const rows = refreshed ? refreshedRows : initialRows;
        const offset = input.cursor?.offset ?? 0;
        const nextOffset = offset + input.limit;
        return Promise.resolve({
          _tag: "Success",
          value: {
            commits: rows.slice(offset, nextOffset),
            nextCursor: nextOffset < rows.length ? cursorAt(nextOffset) : null,
            hasMore: nextOffset < rows.length,
          },
        });
      },
    );

    const root = await renderPanel({ view: "graph" });
    await settle();
    const scrollArea = document
      .querySelector<HTMLElement>('[aria-label="Git history"]')!
      .closest<HTMLElement>("[data-scroll-area]")!;
    Object.defineProperties(scrollArea, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });
    Object.defineProperty(scrollArea, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 0 }),
    });
    const initialAnchor = document.querySelector<HTMLElement>(`[data-graph-row="${anchor}"]`)!;
    Object.defineProperties(initialAnchor, {
      getBoundingClientRect: { configurable: true, value: () => ({ bottom: 20 }) },
      offsetTop: { configurable: true, value: 100 },
    });
    await act(async () => scrollArea.dispatchEvent(new Event("scroll", { bubbles: true })));
    await click(button("Selected after rewrite"));

    refreshed = true;
    refsQuery.data = { refs: [{ name: "rewritten", current: true, isDefault: true }] } as never;
    await rerenderPanel(root, { view: "graph" });
    await settle();
    await settle();

    const renderedShas = () =>
      [...document.querySelectorAll<HTMLElement>("[data-graph-row]")].map(
        (element) => element.dataset.graphRow,
      );
    const renderedLanes = () =>
      [...document.querySelectorAll<HTMLElement>("[data-graph-row]")].map((element) => ({
        lane: element.querySelector("[data-graph-lane]")?.getAttribute("data-graph-lane"),
        edge: element.querySelector("[data-graph-edge]")?.getAttribute("data-graph-edge"),
      }));
    expect(renderedShas()).toEqual(refreshedRows.slice(651, 701).map((commit) => commit.sha));
    expect(renderedShas()).toHaveLength(50);
    expect(renderedShas()).toContain(selected);
    expect(renderedShas()).not.toContain(anchor);
    expect(button("Selected after rewrite").getAttribute("aria-expanded")).toBe("true");
    // The missing anchor cannot be restored, but replacing the graph must not
    // jump the viewport while the selected window wins that conflict.
    expect(scrollArea.scrollTop).toBe(100);
    expect(
      renderedLanes().every(
        ({ lane, edge }, index, lanes) =>
          index === lanes.length - 1 || edge === `${lane}-${lanes[index + 1]?.lane}`,
      ),
    ).toBe(true);

    Object.defineProperty(scrollArea, "scrollTop", {
      configurable: true,
      value: 900,
      writable: true,
    });
    await act(async () => scrollArea.dispatchEvent(new Event("scroll", { bubbles: true })));
    await settle();

    expect(commands.graph).toHaveBeenLastCalledWith({
      environmentId,
      input: { cwd: "/repo", cursor: cursorAt(701), limit: 50 },
    });
    expect(renderedShas()).toEqual(refreshedRows.slice(651, 751).map((commit) => commit.sha));
    expect(
      renderedLanes().every(
        ({ lane, edge }, index, lanes) =>
          index === lanes.length - 1 || edge === `${lane}-${lanes[index + 1]?.lane}`,
      ),
    ).toBe(true);
  });

  it("finishes a retained merge file request after graph refresh", async () => {
    const sha = "c".repeat(40);
    const parent = "d".repeat(40);
    const deferredFiles = deferred<{
      _tag: "Success";
      value: { files: Array<{ oldPath: null; newPath: string; status: string }> };
    }>();
    commands.graph.mockResolvedValue({
      _tag: "Success",
      value: {
        commits: [
          {
            sha,
            parents: [parent, "e".repeat(40)],
            authorTimestamp: 1,
            subject: "Pending merge",
            refs: [],
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    });
    commands.graphFiles.mockReturnValue(deferredFiles.promise);

    const root = await renderPanel({ view: "graph" });
    await settle();
    await click(button("Pending merge"));
    await click(button("Parent 1"));
    refsQuery.data = { refs: [{ name: "refresh", current: true, isDefault: true }] } as never;
    await rerenderPanel(root, { view: "graph" });
    await settle();
    await act(async () => {
      deferredFiles.resolve({
        _tag: "Success",
        value: { files: [{ oldPath: null, newPath: "kept.ts", status: "added" }] },
      });
      await deferredFiles.promise;
    });

    expect(document.body.textContent).toContain("added kept.ts");
    expect(document.body.textContent).not.toContain("Loading changed files");
  });

  it("retries a failed three-page refresh as one full window reconciliation", async () => {
    const first = "a".repeat(40);
    const second = "b".repeat(40);
    const third = "c".repeat(40);
    const firstCursor = { offset: 1, lanes: [] };
    const secondCursor = { offset: 2, lanes: [] };
    let refreshed = false;
    let retrying = false;
    commands.graph.mockImplementation(({ input }: { input: { cursor: unknown } }) => {
      const page = input.cursor === null ? 1 : input.cursor === firstCursor ? 2 : 3;
      if (refreshed && page === 2 && !retrying) return Promise.resolve({ _tag: "Failure" });
      const subject = refreshed ? `Refreshed ${page}` : `Original ${page}`;
      return Promise.resolve({
        _tag: "Success",
        value: {
          commits: [
            {
              sha: page === 1 ? first : page === 2 ? second : third,
              parents: [],
              authorTimestamp: page,
              subject,
              refs: [],
            },
          ],
          nextCursor: page === 1 ? firstCursor : page === 2 ? secondCursor : null,
          hasMore: page !== 3,
        },
      });
    });

    const root = await renderPanel({ view: "graph" });
    await settle();
    const scrollArea = document
      .querySelector<HTMLElement>('[aria-label="Git history"]')!
      .closest<HTMLElement>("[data-scroll-area]")!;
    Object.defineProperties(scrollArea, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });
    await act(async () => scrollArea.dispatchEvent(new Event("scroll", { bubbles: true })));
    await settle();
    await act(async () => scrollArea.dispatchEvent(new Event("scroll", { bubbles: true })));
    await settle();

    refreshed = true;
    refsQuery.data = { refs: [{ name: "refresh", current: true, isDefault: true }] } as never;
    await rerenderPanel(root, { view: "graph" });
    await settle();
    expect(document.body.textContent).toContain("Unable to load Git history.");
    retrying = true;
    await click(button("Retry"));
    await settle();
    await settle();
    await settle();

    expect(button("Refreshed 1")).toBeDefined();
    expect(button("Refreshed 2")).toBeDefined();
    expect(button("Refreshed 3")).toBeDefined();
  });

  it("compensates the real graph viewport by the retained anchor displacement", async () => {
    const anchorSha = "a".repeat(40);
    const rows = Array.from({ length: 500 }, (_, index) => ({
      sha: index === 0 ? anchorSha : index.toString(16).padStart(40, "0"),
      parents: [],
      authorTimestamp: index,
      subject: index === 0 ? "Scroll anchor" : `Row ${index}`,
      refs: [],
    }));
    let refreshed = false;
    let animationFrame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrame = callback;
      return 1;
    });
    commands.graph.mockImplementation(() =>
      Promise.resolve({
        _tag: "Success",
        value: {
          commits: refreshed
            ? [
                {
                  sha: "b".repeat(40),
                  parents: [],
                  authorTimestamp: 501,
                  subject: "Inserted",
                  refs: [],
                },
                ...rows,
              ]
            : rows,
          nextCursor: null,
          hasMore: false,
        },
      }),
    );

    const root = await renderPanel({ view: "graph" });
    await settle();
    const scrollArea = document
      .querySelector<HTMLElement>('[aria-label="Git history"]')!
      .closest<HTMLElement>("[data-scroll-area]")!;
    Object.defineProperties(scrollArea, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: 40, writable: true },
    });
    Object.defineProperty(scrollArea, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 0 }),
    });
    const initialAnchor = document.querySelector<HTMLElement>(`[data-graph-row="${anchorSha}"]`)!;
    Object.defineProperties(initialAnchor, {
      getBoundingClientRect: { configurable: true, value: () => ({ bottom: 20 }) },
      offsetTop: { configurable: true, value: 100 },
    });
    await act(async () => {
      scrollArea.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    refreshed = true;
    refsQuery.data = { refs: [{ name: "anchor", current: true, isDefault: true }] } as never;
    await rerenderPanel(root, { view: "graph" });
    await settle();
    const refreshedAnchor = document.querySelector<HTMLElement>(`[data-graph-row="${anchorSha}"]`)!;
    Object.defineProperty(refreshedAnchor, "offsetTop", { configurable: true, value: 140 });
    await act(async () => animationFrame?.(0));

    expect(scrollArea.scrollTop).toBe(80);
  });

  it("keeps discovered repository Changes groups mounted while visiting Graph and returning", async () => {
    const root = await renderPanel();
    await settle();
    const firstGroup = document.querySelector("[data-source-control-repository-group]");
    expect(firstGroup).not.toBeNull();

    await rerenderPanel(root, { view: "graph" });
    await rerenderPanel(root, { view: "changes" });

    expect(document.querySelector("[data-source-control-repository-group]")).toBe(firstGroup);
  });

  it("switches discovered repository consumers together without carrying a stale pull request", async () => {
    const root = await renderPanel({ supportsPullRequests: true });
    await settle();
    const threadRef = { environmentId, threadId };
    const activeRoot = () =>
      useRightPanelStore.getState().getSourceControlRepositoryRoot(threadRef);

    expect(activeRoot()).toBe("/repo");
    expect(
      [...document.querySelectorAll("[data-branch-root]")].map((node) =>
        node.getAttribute("data-branch-root"),
      ),
    ).toEqual(["/repo", "/repo/packages/app"]);
    expect(
      [...document.querySelectorAll("[data-menu-root]")].map((node) =>
        node.getAttribute("data-menu-root"),
      ),
    ).toEqual(["/repo", "/repo/packages/app"]);

    await rerenderPanel(root, { supportsPullRequests: true, view: "pull-requests" });
    expect(observed.pullRequestTargets.at(-1)).toEqual([
      {
        environmentId,
        input: {
          state: "open",
          involvement: "all",
          projectId,
          repositoryRoot: "/repo",
          limit: 50,
        },
      },
    ]);
    await click(document.querySelector<HTMLButtonElement>("[data-pull-request-row]")!);
    expect(
      document.querySelector("[data-pull-request-root]")?.getAttribute("data-pull-request-root"),
    ).toBe("/repo");

    const selector = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Active repository"]',
    )!;
    await selectValue(selector, "/repo/packages/app");
    expect(activeRoot()).toBe("/repo/packages/app");
    expect(document.querySelector("[data-pull-request-root]")).toBeNull();
    expect(observed.pullRequestTargets.at(-1)).toEqual([
      {
        environmentId,
        input: {
          state: "open",
          involvement: "all",
          projectId,
          repositoryRoot: "/repo/packages/app",
          limit: 50,
        },
      },
    ]);

    await rerenderPanel(root, { supportsPullRequests: true, view: "graph" });
    await settle();
    expect(commands.graph).toHaveBeenLastCalledWith({
      environmentId,
      input: { cwd: "/repo/packages/app", cursor: null, limit: 50 },
    });
    await rerenderPanel(root, { supportsPullRequests: true, view: "changes" });
    const groupFor = (rootPath: string) =>
      [...document.querySelectorAll<HTMLElement>("[data-source-control-repository-group]")].find(
        (group) => group.querySelector(`[data-branch-root="${rootPath}"]`) !== null,
      )!;
    await click(
      groupFor("/repo/packages/app").querySelector<HTMLButtonElement>("button[aria-expanded]")!,
    );
    expect(activeRoot()).toBe("/repo/packages/app");
    expect(
      document.querySelector(
        "[data-source-control-repository-group]:last-child [data-branch-root]",
      ),
    ).not.toBeNull();
    await click(groupFor("/repo").querySelector<HTMLButtonElement>("button[aria-expanded]")!);
    expect(activeRoot()).toBe("/repo");
    await rerenderPanel(root, { supportsPullRequests: true, view: "graph" });
    await settle();
    expect(commands.graph.mock.calls.map((call) => call[0].input.cwd)).toContain("/repo");
    expect(commands.graph.mock.calls.map((call) => call[0].input.cwd)).toContain(
      "/repo/packages/app",
    );
  });

  it("updates the rendered Source Control title and request tab when the selected provider changes", async () => {
    statusByCwd.set("/repo", {
      ...reviewedStatus,
      sourceControlProvider: { kind: "github", name: "OuterHub", baseUrl: "https://github.com" },
    });
    statusByCwd.set("/repo/packages/app", {
      ...reviewedStatus,
      sourceControlProvider: { kind: "gitlab", name: "NestedLab", baseUrl: "https://gitlab.com" },
    });
    await renderPanel({ supportsPullRequests: true });
    await settle();

    expect(document.querySelector("h2")?.textContent).toBe("OuterHub");
    expect([...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toContain(
      "OuterHub Pull Requests",
    );

    await selectValue(
      document.querySelector<HTMLSelectElement>('select[aria-label="Active repository"]')!,
      "/repo/packages/app",
    );

    expect(document.querySelector("h2")?.textContent).toBe("NestedLab");
    expect([...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toContain(
      "NestedLab Merge Requests",
    );
  });

  it("retains per-root Graph expansion through A-B-A without reloading A's first page", async () => {
    commands.graph.mockImplementation(({ input }: { input: { cwd: string } }) =>
      Promise.resolve({
        _tag: "Success",
        value: {
          commits: [
            {
              sha: input.cwd === "/repo" ? "outer-sha" : "nested-sha",
              subject: input.cwd === "/repo" ? "Outer retained commit" : "Nested retained commit",
              refs: [],
              authorTimestamp: 1,
              parents: [],
            },
          ],
          nextCursor: "next-page",
        },
      }),
    );
    const root = await renderPanel({ view: "graph" });
    await settle();
    const outerCommit = button("Outer retained commit");
    await click(outerCommit);
    expect(outerCommit.getAttribute("aria-expanded")).toBe("true");
    const outerFirstPageCalls = commands.graph.mock.calls.filter(
      ([call]) => call.input.cwd === "/repo" && call.input.cursor === null,
    ).length;

    const selector = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Active repository"]',
    )!;
    await selectValue(selector, "/repo/packages/app");
    await settle();
    expect(button("Nested retained commit").getAttribute("aria-expanded")).toBe("false");

    await rerenderPanel(root, { view: "changes" });
    const outerGroup = [
      ...document.querySelectorAll<HTMLElement>("[data-source-control-repository-group]"),
    ].find((group) => group.querySelector('[data-branch-root="/repo"]') !== null)!;
    const stagedChanges = [...outerGroup.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === "Staged changes",
    );
    expect(stagedChanges).toBeDefined();
    await click(stagedChanges!);
    const outerDraft = outerGroup.querySelector<HTMLTextAreaElement>("textarea")!;
    await input(outerDraft, "keep this root-local draft");
    await click(outerGroup.querySelector<HTMLButtonElement>("button[aria-expanded]")!);
    await rerenderPanel(root, { view: "graph" });
    await selectValue(selector, "/repo");
    await settle();

    expect(button("Outer retained commit").getAttribute("aria-expanded")).toBe("true");
    expect(
      commands.graph.mock.calls.filter(
        ([call]) => call.input.cwd === "/repo" && call.input.cursor === null,
      ),
    ).toHaveLength(outerFirstPageCalls);
    await rerenderPanel(root, { view: "changes" });
    const liveOuterGroup = [
      ...document.querySelectorAll<HTMLElement>("[data-source-control-repository-group]"),
    ].find((group) => group.querySelector('[data-branch-root="/repo"]') !== null);
    expect(liveOuterGroup).toBeDefined();
    const liveOuterToggle =
      liveOuterGroup!.querySelector<HTMLButtonElement>("button[aria-expanded]");
    expect(liveOuterToggle?.getAttribute("aria-expanded")).toBe("false");
    await click(liveOuterToggle!);
    expect(liveOuterGroup!.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "keep this root-local draft",
    );
  });

  it("keeps reviewed tokens and refreshes after a stale-state rejection", async () => {
    const refreshStatus = vi.fn();
    const setError = vi.fn();
    const input = buildSourceControlCommitInput({
      cwd: "/repo",
      message: "keep draft",
      headCommit: "head-before-refresh",
      indexTree: "tree-before-refresh",
      refName: "feature/reviewed",
      pendingMergeHeads: [],
      confirmDefaultRef: false,
    });
    expect(input.precondition).toEqual({
      expectedHeadCommit: "head-before-refresh",
      expectedIndexTree: "tree-before-refresh",
      expectedRefName: "feature/reviewed",
      expectedMergeHeads: [],
    });
    await expect(
      handleSourceControlCommitFailure(
        { cause: Cause.fail({ code: "stale_git_state" }) },
        { refreshStatus, setError },
      ),
    ).resolves.toBe(true);
    expect(refreshStatus).toHaveBeenCalledTimes(1);
    expect(setError).toHaveBeenCalledWith(
      "Repository changed; review the staged changes and try again.",
    );
  });

  it("requires an index review before enabling a commit", () => {
    expect(
      canSubmitSourceControlCommit({
        workflowAvailable: true,
        stagedCount: 1,
        message: "commit",
        reviewedStateAvailable: false,
        hasReviewedBranch: true,
      }),
    ).toBe(false);
  });

  it("commits to the default ref without a confirmation dialog", async () => {
    await renderPanel();
    await click(button("Staged changes"));
    await input(document.querySelector("textarea")!, "reviewed commit");
    await click(button("Commit staged changes"));

    expect(commands.commit).toHaveBeenCalledWith({
      environmentId,
      input: {
        cwd: "/repo",
        message: "reviewed commit",
        precondition: {
          expectedHeadCommit: "head",
          expectedIndexTree: "index",
          expectedRefName: "main",
        },
      },
    });
  });

  it("confirms Amend on the default ref and sends amend=true", async () => {
    await renderPanel();
    await click(button("Staged changes"));
    await selectValue(document.querySelector('select[aria-label="Commit action"]')!, "amend");
    await click(button("Amend"));

    expect(commands.commit).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Commit to the default branch?");
    await click(button("Amend commit"));

    expect(commands.commit).toHaveBeenCalledWith({
      environmentId,
      input: {
        cwd: "/repo",
        message: "",
        confirmation: "approved",
        amend: true,
        precondition: {
          expectedHeadCommit: "head",
          expectedIndexTree: "index",
          expectedRefName: "main",
        },
        confirmDefaultRef: true,
      },
    });
  });

  it("generates a commit message through the repository workspace command", async () => {
    await renderPanel();
    await click(button("Generate"));
    await settle();

    expect(commands.generate).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/repo", paths: ["src/file.ts"] },
    });
    expect(
      (document.querySelector('textarea[aria-label="Commit message"]') as HTMLTextAreaElement)
        .value,
    ).toBe("generated message");
  });

  it("restores only a commit message from legacy persistence in a fresh session", async () => {
    window.localStorage.setItem(
      `t3code:source-control-composer:v1:${environmentId}:${threadId}`,
      JSON.stringify({
        [`${environmentId}\0${threadId}\0/repo`]: {
          message: "restore this message",
          instructions: "never restore this",
          action: "amend",
        },
      }),
    );

    await renderPanel();
    await click(
      document.querySelector<HTMLButtonElement>('button[aria-label="Generate options"]')!,
    );

    expect(
      (document.querySelector('textarea[aria-label="Commit message"]') as HTMLTextAreaElement)
        .value,
    ).toBe("restore this message");
    expect(
      (
        document.querySelector(
          'textarea[aria-label="Generation instructions"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("");
    expect(
      (document.querySelector('select[aria-label="Commit action"]') as HTMLSelectElement).value,
    ).toBe("commit");
  });

  it("lets the server generate from the complete index when the status page is partial", async () => {
    statusQuery.data = {
      ...reviewedStatus,
      workingTree: {
        ...reviewedStatus.workingTree,
        stagedCount: 2,
        nextCursor: 1,
      },
    };
    await renderPanel();
    await click(button("Generate"));
    await settle();

    expect(commands.generate).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/repo" },
    });
  });

  it("does not replace a message edited while generation is pending", async () => {
    const pending = deferred<unknown>();
    commands.generate.mockReturnValueOnce(pending.promise);
    await renderPanel();
    await click(button("Generate"));
    await input(document.querySelector('textarea[aria-label="Commit message"]')!, "manual message");
    pending.resolve({ _tag: "Success", value: { message: "stale generated message" } });
    await settle();

    expect(
      (document.querySelector('textarea[aria-label="Commit message"]') as HTMLTextAreaElement)
        .value,
    ).toBe("manual message");
  });

  it("does not apply generation from a repository that is no longer active", async () => {
    const pending = deferred<unknown>();
    commands.generate.mockReturnValueOnce(pending.promise);
    const root = await renderPanel({ cwd: "/repo" });
    await click(button("Generate"));
    await rerenderPanel(root, { cwd: "/nested-repo" });
    pending.resolve({ _tag: "Success", value: { message: "stale repository message" } });
    await settle();

    expect(
      (document.querySelector('textarea[aria-label="Commit message"]') as HTMLTextAreaElement)
        .value,
    ).not.toBe("stale repository message");
  });

  it("turns the primary action into Push when a clean branch is ahead", async () => {
    statusQuery.data = {
      ...reviewedStatus,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      aheadCount: 1,
      hasUpstream: true,
    };
    await renderPanel();

    expect(button("Push").disabled).toBe(false);
    await click(button("Push"));
    expect(commands.runAction).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Confirm Git action");
    await click(button("Continue"));
    expect(commands.runAction).toHaveBeenCalledWith({
      environmentId,
      input: {
        cwd: "/repo",
        action: "push",
        confirm: true,
        precondition: {
          expectedHeadCommit: "head",
          expectedIndexTree: "index",
          expectedRefName: "main",
        },
      },
    });
  });

  it("does not open a primary Push approval until its reviewed snapshot is complete", async () => {
    const incompleteStatus = {
      ...reviewedStatus,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      aheadCount: 1,
      hasUpstream: true,
      remoteName: "origin",
      remoteRefName: "feature/reviewed",
    } as Record<string, unknown>;
    delete incompleteStatus.indexTree;
    statusQuery.data = incompleteStatus as VcsStatusResult;
    const root = await renderPanel();

    expect(button("Push").disabled).toBe(true);
    await click(button("Push"));
    expect(document.body.textContent).not.toContain("Confirm Git action");
    expect(commands.runAction).not.toHaveBeenCalled();

    statusQuery.data = {
      ...reviewedStatus,
      ...incompleteStatus,
      indexTree: "reviewed-index",
    } as VcsStatusResult;
    await rerenderPanel(root, {});
    expect(button("Push").disabled).toBe(false);
    await click(button("Push"));
    expect(document.body.textContent).toContain("Repository /repo, branch main");
  });

  it("confirms the actual upstream target and lets the composer cancel without an RPC", async () => {
    statusQuery.data = {
      ...reviewedStatus,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      aheadCount: 1,
      hasUpstream: true,
      remoteName: "upstream",
      remoteRefName: "feature/retry",
    };
    await renderPanel();
    await click(button("Push"));
    expect(document.body.textContent).toContain("upstream/feature/retry");
    await click(button("Cancel"));
    expect(commands.runAction).not.toHaveBeenCalled();
  });

  it("cancels a composer Push approval when its reviewed source or destination changes", async () => {
    statusQuery.data = {
      ...reviewedStatus,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      aheadCount: 1,
      hasUpstream: true,
      remoteName: "origin",
      remoteRefName: "reviewed-target",
    };
    const root = await renderPanel();
    await click(button("Push"));
    expect(document.body.textContent).toContain("origin/reviewed-target");

    statusQuery.data = {
      ...statusQuery.data,
      refName: "other-branch",
      headCommit: "other-head",
      remoteName: "other",
      remoteRefName: "changed-target",
    };
    await rerenderPanel(root, {});
    await settle();

    expect(document.body.textContent).not.toContain("Confirm Git action");
    expect(commands.runAction).not.toHaveBeenCalled();
  });

  it("offers Publish Repository rather than a branch publish when no remote exists", async () => {
    statusQuery.data = {
      ...reviewedStatus,
      hasPrimaryRemote: false,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      aheadCount: 1,
      hasUpstream: false,
    };
    await renderPanel();

    expect(button("Publish Repository").disabled).toBe(false);
    await click(button("Publish Repository"));
    await click(button("Continue"));
    expect(document.body.textContent).toContain("Publish repository wizard");
    expect(commands.runAction).not.toHaveBeenCalled();
  });

  it("keeps an explicit message-only Amend primary when the branch is ahead", async () => {
    statusQuery.data = {
      ...reviewedStatus,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      aheadCount: 2,
    };
    await renderPanel();
    await selectValue(document.querySelector('select[aria-label="Commit action"]')!, "amend");
    expect(button("Amend").disabled).toBe(false);
    await click(button("Amend"));
    await click(button("Amend commit"));
    expect(commands.commit).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({ cwd: "/repo", message: "", amend: true }),
    });
  });

  it("confirms Commit & Push once and sends one durable compound command", async () => {
    await renderPanel();
    await click(button("Staged changes"));
    await input(document.querySelector('textarea[aria-label="Commit message"]')!, "compound");
    await selectValue(document.querySelector('select[aria-label="Commit action"]')!, "commit_push");
    await click(button("Commit & Push"));

    expect(commands.commit).not.toHaveBeenCalled();
    expect(commands.runAction).not.toHaveBeenCalled();
    await click(button("Continue"));
    await settle();

    expect(commands.commit).not.toHaveBeenCalled();
    expect(commands.runAction).toHaveBeenCalledWith({
      environmentId,
      input: {
        cwd: "/repo",
        action: "commit",
        message: "compound",
        compoundOperation: "commit-push",
        confirm: true,
        precondition: {
          expectedHeadCommit: "head",
          expectedIndexTree: "index",
          expectedRefName: "main",
        },
      },
    });
  });

  it("reviews staged and unstaged versions of a mixed file against the captured index", async () => {
    await renderPanel();
    await click(button("Staged changes"));
    await click(button("Unstaged changes"));

    expect(commands.diff).toHaveBeenNthCalledWith(1, {
      environmentId,
      input: {
        cwd: "/repo",
        path: "src/file.ts",
        comparison: "index",
        reviewedState: { headCommit: "head", indexTree: "index" },
      },
    });
    expect(commands.diff).toHaveBeenNthCalledWith(2, {
      environmentId,
      input: {
        cwd: "/repo",
        path: "src/file.ts",
        comparison: "worktree-index",
      },
    });
  });

  it("uses the untracked-file fallback instead of an empty index diff", async () => {
    statusQuery.data = {
      ...reviewedStatus,
      workingTree: {
        files: [
          {
            path: "src/untracked.ts",
            insertions: 1,
            deletions: 0,
            indexStatus: "untracked",
          },
        ],
        insertions: 1,
        deletions: 0,
      },
    };
    await renderPanel();
    await click(button("Untracked changes"));

    expect(document.body.textContent).toContain("untracked vs empty");
    expect(commands.diff).toHaveBeenCalledWith({
      environmentId,
      input: {
        cwd: "/repo",
        path: "src/untracked.ts",
        comparison: "worktree-index",
      },
    });
  });

  it("only enables commit after a successful staged review", async () => {
    await renderPanel();
    await click(button("Unstaged changes"));
    await input(document.querySelector("textarea")!, "reviewed commit");
    expect(button("Commit staged changes").disabled).toBe(true);

    await click(button("Staged changes"));
    expect(button("Commit staged changes").disabled).toBe(false);
  });

  it("keeps commit disabled while a staged review is pending and after it fails", async () => {
    const pending = deferred<unknown>();
    commands.diff.mockReset().mockReturnValueOnce(pending.promise);
    await renderPanel();
    await click(button("Staged changes"));
    await input(document.querySelector("textarea")!, "reviewed commit");
    expect(button("Commit staged changes").disabled).toBe(true);

    pending.resolve({
      _tag: "Failure",
      cause: Cause.fail(new Error("diff failed")),
    });
    await settle();
    expect(button("Commit staged changes").disabled).toBe(true);
  });

  it("does not authorize a staged response cancelled before it settles", async () => {
    const pending = deferred<unknown>();
    commands.diff.mockReset().mockReturnValueOnce(pending.promise);
    await renderPanel();
    await click(button("Staged changes"));
    await click(button("Cancel review"));
    pending.resolve({
      _tag: "Success",
      value: { diff: "staged", truncated: false },
    });
    await settle();
    await input(document.querySelector("textarea")!, "reviewed commit");

    expect(button("Commit staged changes").disabled).toBe(true);
  });

  it("does not authorize a stale staged response after reviewing the working tree", async () => {
    const pending = deferred<unknown>();
    commands.diff
      .mockReset()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({
        _tag: "Success",
        value: { diff: "working tree", truncated: false },
      });
    await renderPanel();
    await click(button("Staged changes"));
    await click(button("Unstaged changes"));
    pending.resolve({
      _tag: "Success",
      value: { diff: "staged", truncated: false },
    });
    await settle();
    await input(document.querySelector("textarea")!, "reviewed commit");

    expect(button("Commit staged changes").disabled).toBe(true);
  });

  it("drops review authorization and ignores in-flight responses after the review scope changes", async () => {
    const pending = deferred<unknown>();
    commands.diff.mockReset().mockReturnValueOnce(pending.promise);
    const root = await renderPanel();
    await click(button("Staged changes"));
    const nextEnvironmentId = EnvironmentId.make("environment-2");
    const nextThreadId = ThreadId.make("thread-2");
    await rerenderPanel(root, {
      cwd: "/other-repo",
      environmentId: nextEnvironmentId,
      threadId: nextThreadId,
      threadRef: { environmentId: nextEnvironmentId, threadId: nextThreadId },
    });
    pending.resolve({
      _tag: "Success",
      value: { diff: "staged", truncated: false },
    });
    await settle();
    await input(document.querySelector("textarea")!, "new scope commit");

    expect(button("Commit staged changes").disabled).toBe(true);
    expect(commands.commit).not.toHaveBeenCalled();
  });

  it("cancels Changes Initialize approval when the selected environment changes", async () => {
    statusQuery.data = { ...reviewedStatus, isRepo: false };
    commands.discover.mockResolvedValue({
      _tag: "Success",
      value: { projectRoot: "/repo", repositories: [], truncated: false },
    });
    const root = await renderPanel();

    await click(button("Initialize repository"));
    expect(document.body.textContent).toContain("Initialize Git repository?");
    const otherEnvironmentId = EnvironmentId.make("other");
    await rerenderPanel(root, {
      environmentId: otherEnvironmentId,
      threadRef: { environmentId: otherEnvironmentId, threadId },
    });

    expect(document.body.textContent).not.toContain("Initialize Git repository?");
    expect(commands.init).not.toHaveBeenCalled();
  });
});
