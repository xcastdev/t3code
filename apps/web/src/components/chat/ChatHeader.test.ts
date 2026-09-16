/* @vitest-environment happy-dom */

import { act } from "react";
import {
  cloneElement,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type ProjectScript } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

const headerState = vi.hoisted(() => ({
  primaryEnvironmentId: null as unknown,
  remoteMode: "local-exec" as "local-exec" | "remote-links" | "remote-unavailable",
}));

vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>();
  return {
    ...actual,
    isAtomCommandInterrupted: () => false,
    squashAtomCommandFailure: (error: unknown) => error,
  };
});
vi.mock("../GitActionsControl", () => ({
  default: () => createElement("div", { "data-testid": "git" }),
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => createElement("span") }));
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  WorkspaceBreadcrumbItem: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  WorkspaceBreadcrumbSeparator: () => createElement("span"),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  TooltipPopup: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  TooltipTrigger: ({ render, children }: { render?: ReactNode; children?: ReactNode }) =>
    isValidElement(render)
      ? cloneElement(render as ReactElement<{ children?: unknown }>, {}, children)
      : createElement("span", null, children),
}));
vi.mock("../../remoteOpen", () => ({
  openRemoteEditorUrl: vi.fn().mockResolvedValue(true),
  useRemoteCapableEditors: () => ["vscode"],
  useRemoteOpenHint: () => [false, vi.fn()],
  useRemoteOpenState: () =>
    headerState.remoteMode === "remote-links"
      ? { mode: "remote-links", host: { host: "remote.example" } }
      : { mode: headerState.remoteMode },
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => headerState.primaryEnvironmentId,
  useEnvironment: () => ({ label: "test machine" }),
}));
vi.mock("~/editorPreferences", () => ({
  usePreferredEditor: (available: readonly string[]) => [available[0] ?? null, vi.fn()],
}));
vi.mock("~/hooks/useT3ProjectFileScripts", () => ({ useT3ProjectFileScripts: () => [] }));
vi.mock("~/hooks/useThreadActionMenu", () => ({
  useThreadActionMenu: () => ({ openMenu: vi.fn(), closeMenu: vi.fn() }),
}));
vi.mock("~/localApi", () => ({ readLocalApi: () => null }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { updateMetadata: Symbol("update") } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn().mockResolvedValue({ _tag: "Success", value: undefined }),
}));
vi.mock("../../panelAnimations", () => ({
  observeResponsiveBreakpointFade: () => undefined,
  usePanelAnimationSettings: () => ({ active: false, durationMs: 0 }),
}));
vi.mock("../projectScriptEditor", () => ({
  EMPTY_PROJECT_SCRIPT_INPUT: {
    name: "",
    command: "",
    icon: "play",
    runOnWorktreeCreate: false,
    waitForSetup: false,
    keybinding: null,
    previewUrl: null,
    autoOpenPreview: false,
  },
  editorRequestForScript: (script: ProjectScript) => ({ scriptId: script.id, initial: script }),
  ProjectScriptEditorDialog: () => null,
  ScriptIcon: ({ icon }: { icon: string }) => createElement("span", { "data-script-icon": icon }),
}));

import {
  ChatHeader,
  resolveChatHeaderActionLayout,
  resolveRenameCommit,
  shouldShowOpenInPicker,
} from "./ChatHeader";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

const environmentId = EnvironmentId.make("environment");
const projectScripts: readonly ProjectScript[] = [
  { id: "dev", name: "Dev", command: "vp dev", icon: "play", runOnWorktreeCreate: false },
];
const headerRoots: Root[] = [];
const unusedAddScript = async (_input: unknown): Promise<never> => {
  throw new Error("unexpected script mutation");
};
const unusedUpdateScript = async (_scriptId: unknown, _input: unknown): Promise<never> => {
  throw new Error("unexpected script mutation");
};
const unusedDeleteScript = async (_scriptId: unknown): Promise<never> => {
  throw new Error("unexpected script mutation");
};

function header(overrides: Partial<React.ComponentProps<typeof ChatHeader>> = {}) {
  return createElement(ChatHeader, {
    activeThreadEnvironmentId: environmentId,
    activeThreadId: "thread" as never,
    activeThreadTitle: "Thread",
    isServerThread: false,
    activeProject: {
      id: "project" as never,
      title: "Project",
      workspaceRoot: "/repo",
      environmentId,
      defaultModelSelection: null,
      scripts: projectScripts,
      createdAt: new Date().toISOString() as never,
      updatedAt: new Date().toISOString() as never,
    } as never,
    openInCwd: "/repo",
    activeProjectScripts: projectScripts,
    preferredScriptId: null,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    availableEditors: ["vscode"],
    rightPanelOpen: true,
    rightPanelHasActiveSurface: false,
    onNewThreadInProject: () => undefined,
    onRunProjectScript: () => undefined,
    onAddProjectScript: unusedAddScript,
    onUpdateProjectScript: unusedUpdateScript,
    onDeleteProjectScript: unusedDeleteScript,
    ...overrides,
  });
}

async function mountHeader(overrides: Partial<React.ComponentProps<typeof ChatHeader>> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  headerRoots.push(root);
  await act(async () => root.render(header(overrides)));
  return { container, root };
}

function labeled(label: string): Element | null {
  return document.querySelector(`[aria-label="${label}"]`);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.replaceChildren();
  headerState.primaryEnvironmentId = environmentId;
  headerState.remoteMode = "local-exec";
});

afterEach(async () => {
  for (const root of headerRoots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("ChatHeader rendered action controls", () => {
  it("reserves the shared global-control footprint when chat owns the controls", async () => {
    await mountHeader({ rightPanelOpen: true, reserveGlobalControls: true });

    expect(document.querySelector("[data-chat-header-actions]")!.className).toContain(
      "pr-[var(--workspace-global-controls-width)]",
    );
  });

  it("releases the control clearance only for an active panel surface", async () => {
    await mountHeader({
      rightPanelOpen: true,
      rightPanelHasActiveSurface: true,
      reserveGlobalControls: false,
    });

    expect(document.querySelector("[data-chat-header-actions]")!.className).toContain("pr-0");
  });

  it.each([
    ["non-Electron desktop two-control", false, 2, 28, 13, 73],
    ["Electron desktop two-control", true, 2, 28, 113, 173],
    ["non-Electron desktop four-control", false, 4, 28, 13, 137],
    ["Electron desktop four-control", true, 4, 28, 113, 237],
    ["non-Electron compact two-control", false, 2, 32, 13, 81],
    ["Electron compact two-control", true, 2, 32, 113, 181],
    ["non-Electron compact four-control", false, 4, 32, 13, 153],
    ["Electron compact four-control", true, 4, 32, 113, 253],
  ] as const)(
    "keeps one %s reservation across the chat composition",
    async (_viewport, electron, controls, controlSize, edgeInset, expectedReservation) => {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      headerRoots.push(root);
      await act(async () =>
        root.render(
          createElement(
            WorkspacePageHeader,
            { electron, reserveGlobalControls: true },
            header({
              rightPanelOpen: true,
              rightPanelHasActiveSurface: false,
              parentReservesGlobalControls: true,
            }),
          ),
        ),
      );

      const pageHeader = container.querySelector("header")!;
      const actions = container.querySelector("[data-chat-header-actions]")!;
      expect(pageHeader.className).toContain("pr-[var(--workspace-global-controls-width)]");
      expect(pageHeader.className).not.toContain("wco:pr-[var(--workspace-native-controls-inset)]");
      // The page header owns the full edge-inclusive footprint. The nested actions
      // must add no fallback or duplicate global padding inside that content box.
      expect(actions.className).toContain("pr-0");
      expect(actions.className).not.toContain("workspace-global-controls-width");
      expect(controls * controlSize + (controls - 1) * 4 + edgeInset).toBe(expectedReservation);
    },
  );

  it("does not render the Git workflow control", async () => {
    await mountHeader();

    expect(document.querySelector('[data-testid="git"]')).toBeNull();
  });

  it.each([
    [projectScripts, true, "Project actions", null],
    [projectScripts, false, "Project scripts", "Open in editor"],
    [undefined, true, "Open in editor", "Project actions"],
  ] as const)(
    "renders one usable control for scripts=%s openIn=%s",
    async (scripts, showOpen, expected, absent) => {
      headerState.primaryEnvironmentId = showOpen ? environmentId : null;
      await mountHeader({
        activeProjectScripts: scripts,
      });
      if (expected === "Project actions") {
        expect(labeled("Project actions")).not.toBeNull();
        expect(document.querySelectorAll('[aria-label="Project actions"]')).toHaveLength(1);
        expect(labeled("Choose project action")).not.toBeNull();
      } else if (expected === "Project scripts") {
        expect(labeled("Run Dev")).not.toBeNull();
      } else {
        const editorTrigger = labeled("Choose editor");
        expect(editorTrigger).not.toBeNull();
        expect((editorTrigger as HTMLButtonElement).disabled).toBe(false);
      }
      if (absent) expect(labeled(absent)).toBeNull();
    },
  );
});

describe("resolveChatHeaderActionLayout", () => {
  it.each([
    [true, true, "combined"],
    [true, false, "scripts"],
    [false, true, "open-in"],
    [false, false, "none"],
  ] as const)("maps scripts=%s and open-in=%s to %s", (hasScripts, showOpenInPicker, expected) => {
    expect(resolveChatHeaderActionLayout({ hasScripts, showOpenInPicker })).toBe(expected);
  });
});

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(true);
  });

  it("shows the picker for remote environments in deep-link mode", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        remoteOpenMode: "remote-links",
      }),
    ).toBe(true);
  });

  it("shows the picker's unavailable state for remote environments without an SSH route", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
        remoteOpenMode: "remote-unavailable",
      }),
    ).toBe(true);
  });

  it("hides the picker for non-primary local backends", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: "remote-links",
      }),
    ).toBe(false);
  });
});

describe("resolveRenameCommit", () => {
  it("commits a trimmed changed title", () => {
    expect(resolveRenameCommit({ title: "  New title ", originalTitle: "Old" })).toEqual({
      action: "commit",
      title: "New title",
    });
  });

  it("rejects empty and whitespace-only titles", () => {
    expect(resolveRenameCommit({ title: "   ", originalTitle: "Old" })).toEqual({
      action: "reject-empty",
    });
  });

  it("no-ops when the trimmed title is unchanged", () => {
    expect(resolveRenameCommit({ title: " Old ", originalTitle: "Old" })).toEqual({
      action: "noop",
    });
  });
});
