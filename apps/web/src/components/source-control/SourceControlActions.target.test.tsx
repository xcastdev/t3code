/* @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const statusQuery = vi.hoisted(() => ({
  data: {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: true,
    workingTree: {
      files: [{ path: "src/file.ts", insertions: 1, deletions: 0, indexStatus: "modified" }],
      insertions: 1,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
  },
  error: null,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ availableEditors: [] }) }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: (failure: unknown) => failure,
}));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => statusQuery }));
vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: () => Symbol("config") },
}));
vi.mock("~/state/threads", () => ({ threadEnvironment: { updateMetadata: Symbol("update") } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: { status: () => Symbol("status"), refreshStatus: Symbol("refresh") },
}));
vi.mock("~/state/entities", () => ({ useThreadShell: () => null }));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (selector: (store: unknown) => unknown) =>
    selector({
      getDraftSession: () => null,
      getDraftThreadByRef: () => null,
      setDraftThreadContext: () => undefined,
    }),
}));
vi.mock("~/editorPreferences", () => ({ useOpenInPreferredEditor: () => vi.fn() }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("~/lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));
vi.mock("~/terminal-links", () => ({ resolvePathLinkTarget: (path: string) => path }));
vi.mock("~/lib/utils", () => ({ randomUUID: () => "action" }));
vi.mock("~/sourceControlPresentation", () => ({
  DEFAULT_CHANGE_REQUEST_TERMINOLOGY: { singular: "pull request", shortLabel: "PR" },
  getSourceControlPresentation: () => ({
    Icon: () => <span />,
    terminology: { singular: "pull request", shortLabel: "PR" },
  }),
}));
vi.mock("~/lib/sourceControlActions", () => ({
  useGitStackedAction: () => ({ run: vi.fn() }),
  useSourceControlActionRunning: () => false,
  useVcsInitAction: () => ({ isPending: false, run: vi.fn() }),
  useVcsPullAction: () => ({ run: vi.fn() }),
}));
vi.mock("./PublishRepositoryDialog", () => ({ PublishRepositoryDialog: () => null }));

vi.mock("../StartTruncatedPath", () => ({ StartTruncatedPath: () => <span /> }));
vi.mock("../ui/button", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: React.ComponentProps<"button"> & { size?: unknown; variant?: unknown }) => (
    <button {...props} />
  ),
}));
vi.mock("../ui/checkbox", () => ({ Checkbox: () => <input type="checkbox" /> }));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("../ui/group", () => ({
  Group: ({ children, ...props }: React.ComponentProps<"div">) => <div {...props}>{children}</div>,
  GroupSeparator: (props: React.ComponentProps<"div">) => <div {...props} />,
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({
    render,
    children,
  }: {
    render: React.ReactElement;
    children: React.ReactNode;
  }) => (
    <>
      {render}
      {children}
    </>
  ),
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({
    render,
    children,
  }: {
    render: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <>
      {render}
      {children}
    </>
  ),
}));
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/textarea", () => ({
  Textarea: (props: React.ComponentProps<"textarea">) => <textarea {...props} />,
}));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (value: unknown) => value,
  toastManager: { add: vi.fn(), close: vi.fn(), update: vi.fn() },
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({
    render,
    children,
  }: {
    render: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <>
      {render}
      {children}
    </>
  ),
}));

import SourceControlActions from "./SourceControlActions";

const roots: Root[] = [];
const ActionsWithTarget = SourceControlActions as unknown as (props: {
  activeThreadRef: { environmentId: string; threadId: string };
  gitCwd: string;
  target: HTMLElement | null;
}) => React.ReactNode;

async function render(root: Root, target: HTMLElement | null): Promise<void> {
  await act(async () => {
    root.render(
      <ActionsWithTarget
        activeThreadRef={{ environmentId: "environment", threadId: "thread" }}
        gitCwd="/repo"
        target={target}
      />,
    );
  });
}

async function typeMessage(input: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(input, value);
  await act(async () => input.dispatchEvent(new Event("input", { bubbles: true })));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.replaceChildren();
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.unstubAllGlobals();
});

describe("SourceControlActions target lifetime", () => {
  it("keeps an open commit draft when its Source Control target disappears and returns", async () => {
    const host = document.createElement("div");
    const firstTarget = document.createElement("div");
    const nextTarget = document.createElement("div");
    document.body.append(host, firstTarget, nextTarget);
    const root = createRoot(host);
    roots.push(root);

    await render(root, firstTarget);
    expect(firstTarget.querySelector("[data-source-control-actions]")).not.toBeNull();

    await act(async () => {
      [...firstTarget.querySelectorAll("button")]
        .find((button) => button.textContent === "Commit")
        ?.click();
    });
    const draft = firstTarget.querySelector("textarea")!;
    await typeMessage(draft, "keep this commit message");

    await render(root, null);
    expect(firstTarget.querySelector("textarea")).toBeNull();

    await render(root, nextTarget);
    expect(nextTarget.querySelector("textarea")?.value).toBe("keep this commit message");
  });
});
