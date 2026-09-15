/* @vitest-environment happy-dom */

import { act, Children, cloneElement, isValidElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const statusQuery = vi.hoisted(() => ({
  data: {
    isRepo: true,
    hasPrimaryRemote: false,
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
const gitActionRun = vi.hoisted(() => vi.fn(() => Promise.resolve({ _tag: "Success", value: {} })));

const sourceControlDiscovery = vi.hoisted(() => Symbol("source-control-discovery"));
const sourceControlDiscoveryQuery = vi.hoisted(() => ({
  data: {
    sourceControlProviders: [
      {
        kind: "github",
        label: "GitHub",
        status: "available",
        installHint: null,
        auth: {
          status: "authenticated",
          account: { _id: "Option", _tag: "Some", value: "octo" },
          detail: { _id: "Option", _tag: "None" },
        },
      },
    ],
  },
  error: null,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ availableEditors: [] }) }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: (failure: unknown) => failure,
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: symbol | null) =>
    query === sourceControlDiscovery ? sourceControlDiscoveryQuery : statusQuery,
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: () => Symbol("config") },
}));
vi.mock("~/state/threads", () => ({ threadEnvironment: { updateMetadata: Symbol("update") } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: { status: () => Symbol("status"), refreshStatus: Symbol("refresh") },
}));
vi.mock("~/state/sourceControl", () => ({
  sourceControlEnvironment: { discovery: () => sourceControlDiscovery },
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
vi.mock("~/lib/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
  randomUUID: () => "action",
}));
vi.mock("~/sourceControlPresentation", () => ({
  DEFAULT_CHANGE_REQUEST_TERMINOLOGY: { singular: "pull request", shortLabel: "PR" },
  getSourceControlPresentation: () => ({
    Icon: () => <span />,
    terminology: { singular: "pull request", shortLabel: "PR" },
  }),
}));
vi.mock("~/lib/sourceControlActions", () => ({
  useGitStackedAction: () => ({ run: gitActionRun }),
  useSourceControlActionRunning: () => false,
  useVcsInitAction: () => ({ isPending: false, run: vi.fn() }),
  useVcsPullAction: () => ({ run: vi.fn() }),
  useSourceControlPublishRepositoryAction: () => ({ isPending: false, run: vi.fn() }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@base-ui/react/radio", () => ({
  Radio: {
    Root: ({ children, value, ...props }: React.ComponentProps<"button"> & { value: string }) => (
      <button {...props} data-radio-value={value}>
        {children}
      </button>
    ),
  },
}));

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
vi.mock("../ui/checkbox", () => ({
  Checkbox: ({ onCheckedChange, ...props }: { onCheckedChange?: () => void }) => (
    <input type="checkbox" onChange={() => onCheckedChange?.()} {...props} />
  ),
}));
vi.mock("../ui/radio-group", () => ({
  RadioGroup: ({
    children,
    onValueChange,
  }: {
    children: React.ReactNode;
    onValueChange: (value: string) => void;
  }) => (
    <div>
      {Children.map(children, (child) =>
        isValidElement<{ value: string; onClick?: () => void }>(child)
          ? cloneElement(child as ReactElement<{ value: string; onClick?: () => void }>, {
              onClick: () => onValueChange(child.props.value),
            })
          : child,
      )}
    </div>
  ),
}));
vi.mock("../ui/spinner", () => ({ Spinner: () => <span /> }));
vi.mock("../ui/toggle", () => ({ toggleVariants: () => "" }));
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
vi.mock("../ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
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
vi.mock("../ui/wizard", () => ({
  WizardFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  WizardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  WizardPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  WizardPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  WizardSteps: () => <div />,
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
  gitActionRun.mockClear();
  document.body.replaceChildren();
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.unstubAllGlobals();
});

describe("SourceControlActions target lifetime", () => {
  it("windows a large chooser while preserving exact all and partial commit scopes", async () => {
    statusQuery.data = {
      ...statusQuery.data,
      workingTree: {
        files: Array.from({ length: 101 }, (_, index) => ({
          path: `src/file-${String(index + 1).padStart(3, "0")}.ts`,
          insertions: 1,
          deletions: 0,
          indexStatus: "unstaged" as const,
        })),
        insertions: 101,
        deletions: 0,
        totalCount: 101,
      },
    };
    const host = document.createElement("div");
    const target = document.createElement("div");
    document.body.append(host, target);
    const root = createRoot(host);
    roots.push(root);
    await render(root, target);
    await act(async () => {
      [...target.querySelectorAll("button")]
        .filter((button) => button.textContent === "Commit")
        .at(-1)
        ?.click();
    });
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Edit")
        ?.click();
    });
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(101);
    expect(
      [...document.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Show 1more files"),
      ),
    ).toBe(true);
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Show 1more files"))
        ?.click();
    });
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(102);
  });

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
    const draft = document.querySelector("textarea")!;
    await typeMessage(draft, "keep this commit message");

    await render(root, null);
    expect(document.querySelector("textarea")?.value).toBe("keep this commit message");

    await render(root, nextTarget);
    expect(document.querySelector("textarea")?.value).toBe("keep this commit message");
  });

  it("keeps publish wizard input when its Source Control target disappears and returns", async () => {
    const host = document.createElement("div");
    const firstTarget = document.createElement("div");
    const nextTarget = document.createElement("div");
    document.body.append(host, firstTarget, nextTarget);
    const root = createRoot(host);
    roots.push(root);

    await render(root, firstTarget);
    await act(async () => {
      [...firstTarget.querySelectorAll("button")]
        .find((button) => button.textContent === "Publish repository...")
        ?.click();
    });
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Next")
        ?.click();
    });
    const repository = document.querySelector<HTMLInputElement>("#publish-repository-path")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(repository, "octo/persistent-repository");
    await act(async () => repository.dispatchEvent(new Event("input", { bubbles: true })));

    await render(root, null);
    expect(document.querySelector<HTMLInputElement>("#publish-repository-path")?.value).toBe(
      "octo/persistent-repository",
    );

    await render(root, nextTarget);
    expect(document.querySelector<HTMLInputElement>("#publish-repository-path")?.value).toBe(
      "octo/persistent-repository",
    );
  });
});
