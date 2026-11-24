import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
} from "@t3tools/contracts";
import { act, render } from "../../test/render";
import { CommandPalette } from "./CommandPalette";
import { openCommandPalette, pickFileInCommandPalette } from "../commandPaletteBus";
import { primaryServerKeybindingsAtom } from "../state/server";

const scopes = vi.hoisted(() => ({
  denied: undefined as string | undefined,
  sourceControl: undefined as unknown,
  browse: undefined as unknown,
  browseAtoms: new Set<unknown>(),
  browseTargets: [] as Array<{ readonly environmentId: unknown; readonly input: unknown }>,
}));
const setup = (deniedScope?: string, sourceControl?: unknown, browse?: unknown) => {
  scopes.denied = deniedScope;
  scopes.sourceControl = sourceControl;
  scopes.browse = browse;
  scopes.browseTargets = [];
};
const githubAvailable = {
  versionControlSystems: [],
  sourceControlProviders: [
    {
      kind: "github",
      label: "GitHub",
      status: "available",
      version: { _tag: "None" },
      installHint: "Install GitHub CLI",
      detail: { _tag: "None" },
      auth: {
        status: "authenticated",
        account: { _tag: "Some", value: "demo" },
        host: { _tag: "None" },
        detail: { _tag: "None" },
      },
    },
  ],
};

vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: unknown) =>
    atom === primaryServerKeybindingsAtom ? DEFAULT_RESOLVED_KEYBINDINGS : [],
}));
vi.mock("../hooks/useTheme", async (original) => ({
  ...(await original<typeof import("../hooks/useTheme")>()),
  useRenderedAppearance: () => "light",
  useTheme: () => ({ theme: "t3-chat", resolvedTheme: "light", appearanceMode: "light" }),
}));
vi.mock("../hooks/useCustomThemes", () => ({ useCustomThemes: () => [] }));
vi.mock("../hooks/useEnvironmentTheme", () => ({ useEnvironmentThemeDefinitions: () => [] }));
vi.mock("../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../hooks/useSettings")>()),
  useClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useUpdateEnvironmentSettings: () => () => undefined,
}));
vi.mock("../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ scratchEnvironmentId: () => null }),
}));
vi.mock("../hooks/useNewProject", () => ({ useNewProject: () => async () => undefined }));
vi.mock("../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: null,
    handleNewThread: async () => undefined,
  }),
  useNewThreadHandler: () => async () => undefined,
}));
vi.mock("../hooks/useOpenPanelPullRequestUrl", () => ({ useOpenPanelPullRequestUrl: () => null }));
vi.mock("../connection/useDesktopLocalBootstraps", () => ({ useDesktopLocalBootstraps: () => [] }));
vi.mock("../state/use-atom-command", () => ({
  // The add-project destination step starts a clone and follows its project id.
  useAtomCommand: () => async () => ({ _tag: "Success", value: { projectId: "project-cloned" } }),
}));
vi.mock("../state/use-atom-query-runner", () => ({
  // Doubles as the add-project folder scan, which finds nothing to track.
  useAtomQueryRunner: () => async () => ({ _tag: "Success", value: { folders: [] } }),
}));
vi.mock("../state/environments", async (original) => ({
  ...(await original<typeof import("../state/environments")>()),
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "local",
        label: "Local",
        connection: { phase: "connected" },
        entry: { target: { _tag: "PrimaryConnectionTarget" } },
        serverConfig: {
          environment: { platform: { os: "linux" }, capabilities: { projectCloneTracking: true } },
          settings: { addProjectBaseDirectory: "/workspace/" },
          newProjectsRoot: "/workspace/",
        },
      },
    ],
  }),
  usePrimaryEnvironmentId: () => "local",
  useEnvironmentProviders: () => new Map(),
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => [],
  useThreadShells: () => [],
  useVisibleThreadShells: () => [],
  useHiddenThreadKeys: () => new Set(),
  useAnyEnvironmentHiding: () => false,
  useEnvironmentThreadRefs: () => [],
  useServerConfigs: () => new Map(),
  waitForProject: async () => undefined,
}));
vi.mock("../state/queries", async (original) => ({
  ...(await original<typeof import("../state/queries")>()),
  useThreadSearch: (_environmentIds: unknown, query: string) => ({
    matches: [],
    query,
    isPending: false,
  }),
}));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  useEnvironmentScope: (_environmentId: unknown, scope: string) => scope !== scopes.denied,
  readEnvironmentScope: () => true,
}));
vi.mock("../state/filesystem", async (original) => {
  const actual = await original<typeof import("../state/filesystem")>();
  const browse = actual.filesystemEnvironment.browse;
  return {
    ...actual,
    filesystemEnvironment: {
      ...actual.filesystemEnvironment,
      // Marks browse queries so the query mock below can answer them with `scopes.browse`.
      browse: Object.assign((target: Parameters<typeof browse>[0]) => {
        scopes.browseTargets.push(target);
        const atom = browse(target);
        scopes.browseAtoms.add(atom);
        return atom;
      }, browse),
    },
    useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
  };
});
vi.mock("../state/query", async (original) => ({
  ...(await original<typeof import("../state/query")>()),
  useEnvironmentQuery: (atom: unknown) =>
    scopes.browseAtoms.has(atom)
      ? { data: scopes.browse ?? null, isPending: false }
      : { data: scopes.sourceControl, isLoading: false },
}));
vi.mock("./settings/useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
}));

// The real palette and Base UI input must agree that confirming composition is typing.
describe.each(["repository", "folder", "destination"] as const)("add-project %s", (step) => {
  it.each([
    { isComposing: true, keyCode: 13 },
    { isComposing: false, keyCode: 229 },
  ])("keeps Enter in the input during composition: %j", async (composition) => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() => openCommandPalette({ open: "add-project" }));
    await page.getByText(step === "folder" ? "Local folder" : "Git URL", { exact: true }).click();
    const input = () => page.getByRole("combobox");
    if (step === "destination") {
      await input().fill("https://example.com/team/project.git");
      await userEvent.keyboard("{Enter}");
    }
    const value = step === "repository" ? "https://example.com/team/計画.git" : "/workspace/計画";
    await input().fill(value);
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      ...composition,
    });
    await act(() => input().element().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    await expect.element(input()).toHaveValue(value);
    if (step === "repository") {
      await userEvent.keyboard("{Enter}");
      await expect.element(input()).toHaveValue("/workspace/計画");
    } else {
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
    }
  });
});

it.each([
  { step: "folder", source: "Local folder", keys: "", description: /^(?!.*(Ctrl|⌘)).*Add.*Enter/ },
  {
    step: "highlighted folder",
    source: "Local folder",
    keys: "{ArrowDown}",
    description: /Add.*(Ctrl|⌘) Enter/,
  },
  { step: "repository", source: "Git URL", keys: "", description: /Continue.*Enter/ },
  { step: "new project", source: "New project", keys: "", description: /Create.*Enter/ },
  {
    step: "permission-blocked folder",
    source: "Local folder",
    keys: "",
    deniedScope: AuthOrchestrationOperateScope,
    description: "This connection cannot add projects.",
  },
  {
    step: "permission-blocked destination",
    source: "Git URL",
    keys: "https://example.com/team/project.git{Enter}",
    deniedScope: AuthSourceControlWriteScope,
    description: "This connection needs permission to write source control and add projects.",
  },
])(
  "tells screen readers how to submit the $step step",
  async ({ source, keys, deniedScope, description }) => {
    setup(deniedScope);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() => openCommandPalette({ open: "add-project" }));
    await page.getByText(source, { exact: true }).click();
    if (keys) await userEvent.keyboard(keys);
    await expect.element(page.getByRole("combobox")).toHaveAccessibleDescription(description);
  },
);

it("keeps the caret in place when an edit briefly makes the folder path not a path", async () => {
  setup();
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette({ open: "add-project" }));
  await page.getByText("Local folder", { exact: true }).click();
  const input = () => page.getByRole("combobox");
  await input().fill("/workspace/project");
  await userEvent.keyboard("{Home}{ArrowRight}{Backspace}");
  await expect.element(input()).toHaveValue("workspace/project");
  await userEvent.keyboard("/");
  await expect.element(input()).toHaveValue("/workspace/project");
  await userEvent.keyboard("w");
  await expect.element(input()).toHaveValue("/wworkspace/project");
});

it.each([
  { flow: "Git URL", value: "https://github.com/pingdotgg/t3code.git", submit: "Continue (Enter)" },
  { flow: "New project", value: "demo-tab-order", submit: /^Create \(/ },
])("moves focus from the $flow input to its enabled submit button on Tab", async (step) => {
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette({ open: "add-project" }));
  await page.getByText(step.flow, { exact: true }).click();
  const input = page.getByRole("combobox");
  await input.fill(step.value);
  const submit = page.getByRole("button", { name: step.submit });
  await expect.element(submit).toBeEnabled();
  await userEvent.keyboard("{Tab}");
  await expect.element(submit).toHaveFocus();
});

it("tells screen readers whether a new project will be published", async () => {
  setup(undefined, githubAvailable);
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette({ open: "add-project" }));
  await page.getByText("New project", { exact: true }).click();
  await page.getByRole("combobox").fill("demo-project");
  const option = page.getByRole("option", { name: /Create private repository/ });
  await expect.element(option).toHaveAttribute("aria-checked", "false");
  await option.click();
  await expect.element(option).toHaveAttribute("aria-checked", "true");
});

describe("pick-file", () => {
  const environmentId = EnvironmentId.make("env-files");
  const listing = {
    parentPath: "/home/user/captures",
    entries: [
      { name: "old", fullPath: "/home/user/captures/old", kind: "directory" },
      { name: "session.mitm", fullPath: "/home/user/captures/session.mitm", kind: "file" },
    ],
  };

  it.each([
    { how: "clicking it", choose: () => page.getByText("session.mitm", { exact: true }).click() },
    {
      how: "typing its path and pressing Enter",
      choose: async () => {
        await page.getByRole("combobox").fill("~/captures/session.mitm");
        await userEvent.keyboard("{Enter}");
      },
    },
  ])("lists files and resolves with the one chosen by $how", async ({ choose }) => {
    setup(undefined, undefined, listing);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    let picked: Promise<string | null> = Promise.resolve(null);
    await act(() => {
      picked = pickFileInCommandPalette(environmentId);
    });
    await expect.element(page.getByRole("combobox")).toHaveValue("~/");
    await expect.element(page.getByText("old", { exact: true })).toBeInTheDocument();
    // Picking a file never adds a project.
    await expect.element(page.getByRole("button", { name: /Add/ })).not.toBeInTheDocument();
    await choose();
    await expect(picked).resolves.toBe("/home/user/captures/session.mitm");
    await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
    expect(scopes.browseTargets).toContainEqual({
      environmentId,
      input: expect.objectContaining({ includeFiles: true }),
    });
  });

  it("offers nothing outside the pick, so it never browses another environment", async () => {
    setup(undefined, undefined, listing);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() => {
      void pickFileInCommandPalette(environmentId);
    });
    await expect.element(page.getByRole("combobox")).toHaveValue("~/");
    await page.getByRole("combobox").fill("add project");
    await expect.element(page.getByText("Add project", { exact: true })).not.toBeInTheDocument();
    expect(scopes.browseTargets.map((target) => target.environmentId)).toEqual(
      scopes.browseTargets.map(() => environmentId),
    );
  });

  it("a second pick ends the first unpicked and takes the user's choice itself", async () => {
    setup(undefined, undefined, listing);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    let first: Promise<string | null> = Promise.resolve("unset");
    let second: Promise<string | null> = Promise.resolve("unset");
    await act(() => {
      first = pickFileInCommandPalette(environmentId);
    });
    await act(() => {
      second = pickFileInCommandPalette(environmentId);
    });
    await expect(first).resolves.toBeNull();
    await page.getByText("session.mitm", { exact: true }).click();
    await expect(second).resolves.toBe("/home/user/captures/session.mitm");
  });

  it.each([
    { how: "pressing Escape", leave: () => userEvent.keyboard("{Escape}") },
    // Leaving the pick view must not strand the pick in the root palette on another environment.
    { how: "clearing the path", leave: () => page.getByRole("combobox").fill("") },
  ])("closes unpicked on $how", async ({ leave }) => {
    setup(undefined, undefined, listing);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    let picked: Promise<string | null> = Promise.resolve("unset");
    await act(() => {
      picked = pickFileInCommandPalette(environmentId);
    });
    await expect.element(page.getByRole("combobox")).toHaveValue("~/");
    await leave();
    await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
    await expect(picked).resolves.toBeNull();
  });
});
