/* @vitest-environment happy-dom */

import { act, forwardRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useRightPanelStore } from "~/rightPanelStore";

const atoms = vi.hoisted(() => ({ prepare: Symbol("prepare-pull-request-thread") }));
const preparePullRequestThread = vi.hoisted(() => vi.fn());

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    environment: { capabilities: { sourceControlWorkspace: true } },
    error: null,
    isRunning: false,
    operation: null,
  }),
}));
vi.mock("~/state/git", () => ({
  gitEnvironment: { preparePullRequestThread: atoms.prepare },
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: () => Symbol("server-config") },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) => {
    if (atom === atoms.prepare) return preparePullRequestThread;
    return vi.fn();
  },
}));
vi.mock("~/state/vcs", () => ({
  vcsActionManager: {
    resetError: vi.fn(),
    stateAtom: () => Symbol("action-state"),
    track: (_registry: unknown, _scope: unknown, _action: unknown, execute: () => unknown) =>
      execute(),
  },
  vcsEnvironment: { status: () => Symbol("status") },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
    },
  }),
}));
vi.mock("~/lib/sourceControlActions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/sourceControlActions")>();
  return {
    ...actual,
    readCachedPullRequestResolution: () => null,
    usePullRequestResolution: () => ({
      data: {
        pullRequest: {
          number: 7,
          title: "Scoped pull request",
          headBranch: "feature/scoped",
          baseBranch: "main",
          state: "open",
        },
      },
      error: null,
      isFetching: false,
      isPending: false,
    }),
  };
});
vi.mock("@tanstack/react-pacer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-pacer")>();
  return {
    ...actual,
    useDebouncedValue: (value: string) => [value, { state: { isPending: false } }],
  };
});
vi.mock("../sourceControlPresentation", () => ({
  getSourceControlPresentation: () => ({
    Icon: () => null,
    providerName: "GitHub",
    terminology: { singular: "pull request", shortLabel: "PR" },
  }),
}));
vi.mock("./ui/button", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: React.ComponentProps<"button"> & { size?: unknown; variant?: unknown }) => (
    <button {...props} />
  ),
}));
vi.mock("./ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("./ui/input", () => ({
  Input: forwardRef<HTMLInputElement, React.ComponentProps<"input">>((props, ref) => (
    <input ref={ref} {...props} />
  )),
}));
vi.mock("./ui/spinner", () => ({ Spinner: () => null }));

import { PullRequestThreadDialogHost } from "./PullRequestThreadDialogHost";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");
const threadRef = scopeThreadRef(environmentId, threadId);
const roots: Root[] = [];

async function render(projectRoot: string, reference: string): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <PullRequestThreadDialogHost
        open
        environmentId={environmentId}
        threadId={threadId}
        threadRef={threadRef}
        projectRoot={projectRoot}
        initialReference={reference}
        onOpenChange={() => undefined}
        onPrepared={() => undefined}
      />,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useRightPanelStore.setState({ sourceControlRepositoryRootByThreadKey: {} });
  preparePullRequestThread.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { branch: "feature/scoped", worktreePath: "/repo/.t3/worktrees/scoped" },
  });
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("PullRequestThreadDialog checkout scope", () => {
  it.each([
    [
      "the selected nested repository",
      "/repo/packages/api",
      "https://github.com/nested/api/pull/7",
      "https://github.com/nested/api/pull/7",
    ],
    ["the project root when repository selection is omitted", null, "#7", "7"],
  ])(
    "sends %s through the real checkout action with its normalized reference",
    async (_name, repositoryRoot, typedReference, reference) => {
      useRightPanelStore.getState().setSourceControlRepositoryRoot(threadRef, repositoryRoot);
      await render("/repo", typedReference);
      const worktree = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Worktree",
      );
      expect(worktree).toBeDefined();

      await act(async () => {
        worktree!.click();
        await Promise.resolve();
      });

      expect(preparePullRequestThread).toHaveBeenCalledWith({
        environmentId,
        input: {
          cwd: repositoryRoot ?? "/repo",
          reference,
          mode: "worktree",
          threadId,
        },
      });
    },
  );
});
