/* @vitest-environment happy-dom */
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, ProjectTeamEvidenceApplicability } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { act, Profiler, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  registry: undefined as unknown,
  foundationPage: vi.fn(),
  page: vi.fn(),
  navigate: vi.fn(),
  command: vi.fn(),
  enabled: true,
  supported: true,
  connected: true,
  available: true,
}));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
  useNavigation: () => ({ navigate: fixture.navigate, goBack: vi.fn() }),
}));
vi.mock("react-native", async () => {
  const React = await import("react");
  const container = ({ children }: { children: ReactNode }) =>
    React.createElement("div", {}, children);
  return {
    Platform: { OS: "ios" },
    View: container,
    ScrollView: container,
    Pressable: ({
      children,
      onPress,
      disabled,
    }: {
      children: ReactNode;
      onPress: () => void;
      disabled?: boolean;
    }) => React.createElement("button", { onClick: onPress, disabled }, children),
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/AppText", async () => {
  const React = await import("react");
  return {
    AppText: ({ children }: { children: ReactNode }) => React.createElement("span", {}, children),
    AppTextInput: () => null,
  };
});
vi.mock("../../components/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../state/entities", () => ({
  useProject: ({ projectId }: { projectId: string }) =>
    fixture.available ? { title: projectId } : null,
  useProjects: () => [],
  useEnvironmentServerConfig: () => ({
    settings: { projectWorkEnabled: fixture.enabled },
    environment: { capabilities: { projectTeamFoundationReads: fixture.supported } },
  }),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
  useRemoteEnvironmentRuntime: () => ({
    connectionState: fixture.connected ? "connected" : "disconnected",
  }),
}));
vi.mock("../../state/atom-registry", () => ({
  get appAtomRegistry() {
    return fixture.registry;
  },
}));
vi.mock("../../state/projects", () => ({ environmentProjects: {} }));
vi.mock("../../state/presentation", () => ({ environmentPresentations: {} }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => fixture.command }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "fixture-command" }));
vi.mock("../home/home-thread-navigation", () => ({ createHomeThreadNavigationAction: vi.fn() }));
vi.mock("./workEnvironment", () => ({
  mobileWorkEnvironment: { foundationPage: fixture.foundationPage, page: fixture.page },
}));

// Actual screen, foundation hook/cache, shared decoder, Team and Evidence remain mounted.
import { ProjectWorkScreen } from "./WorkScreens";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const decodeEvidence = Schema.decodeSync(ProjectTeamEvidenceApplicability);
function record(marker: string, index = 0) {
  return decodeEvidence({
    projectId,
    revision: 1,
    generation: 0,
    updatedAt: "2026-10-01T14:00:00Z",
    kind: "evidence-applicability",
    recordId: marker + index,
    status: "current",
    taskId: "task-1",
    evidenceId: marker + index,
    specRevision: 1,
    planRevision: 1,
    repository: "owner/repository",
    worktree: "/fixture/worktree",
    testedTree: "tested-tree",
    testedCommit: "tested-commit",
    baseSha: "base",
    headSha: "head",
    command: marker + index,
    exitCode: 0,
    artifactId: "raw-artifact",
    environmentSummary: "Recorded fixture",
    integration: true,
  });
}
const page = (marker: string, count = 1) => ({
  projectId,
  revision: 2,
  items: Array.from({ length: count }, (_, index) => record(marker, index)),
});
let registry: AtomRegistry.AtomRegistry;
let first: ReturnType<typeof Atom.make<AsyncResult.AsyncResult<unknown>>>;
let second: typeof first;
let root: Root;
let host: HTMLDivElement;
let frames: string[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  fixture.registry = registry;
  fixture.enabled = fixture.supported = fixture.connected = fixture.available = true;
  fixture.foundationPage.mockReset();
  fixture.page.mockReset();
  fixture.navigate.mockReset();
  fixture.command.mockReset();
  first = Atom.make<AsyncResult.AsyncResult<unknown>>(AsyncResult.success(page("FIRST-OWNER-")));
  second = Atom.make<AsyncResult.AsyncResult<unknown>>(AsyncResult.initial());
  fixture.foundationPage.mockImplementation(
    ({ environmentId: owner }: { environmentId: string }) =>
      owner === environmentId ? first : second,
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  frames = [];
});
afterEach(async () => {
  await act(async () => root.unmount());
  registry.dispose();
  host.remove();
  vi.unstubAllGlobals();
});
async function render(owner: string = environmentId) {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <Profiler id="project-screen" onRender={() => frames.push(host.textContent ?? "")}>
          <ProjectWorkScreen route={{ params: { environmentId: owner, projectId } }} />
        </Profiler>
      </RegistryContext.Provider>,
    ),
  );
}
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent === label);
  if (!button) throw new Error("Missing button " + label);
  await act(async () => button.click());
}

describe("project screen evidence inspection", () => {
  it("opens recorded evidence lazily and returns to existing work without another foundation read", async () => {
    await render();
    expect(host.textContent).toContain("Issue intake");
    expect(host.textContent).not.toContain("FIRST-OWNER-");
    const reads = fixture.foundationPage.mock.calls.length;
    await click("Show evidence");
    expect(host.textContent).toContain("FIRST-OWNER-0");
    expect(host.textContent).toContain("Complete recorded snapshot");
    expect(host.textContent).toContain("Last complete project read:");
    await click("Show project work");
    expect(host.textContent).toContain("Issue intake");
    expect(host.textContent).not.toContain("FIRST-OWNER-");
    expect(fixture.foundationPage).toHaveBeenCalledTimes(reads);
    expect(fixture.command).not.toHaveBeenCalled();
  });
  it("never commits old environment evidence after replacing the route with the same project ID", async () => {
    await render();
    await click("Show evidence");
    frames = [];
    await render("environment-2");
    expect(frames.every((frame) => !frame.includes("FIRST-OWNER-"))).toBe(true);
    await click("Show evidence");
    expect(host.textContent).not.toContain("FIRST-OWNER-");
    expect(host.textContent).toContain("Cached or incomplete evidence");
    await act(async () => registry.set(second, AsyncResult.success(page("SECOND-OWNER-"))));
    expect(host.textContent).toContain("SECOND-OWNER-0");
    expect(host.textContent).not.toContain("FIRST-OWNER-");
    await click("Open task task-1");
    expect(fixture.navigate).toHaveBeenLastCalledWith("WorkTask", {
      environmentId: "environment-2",
      projectId,
      taskId: "task-1",
    });
  });
  it("retains same-owner cached evidence while withholding completeness during refresh", async () => {
    await render();
    await click("Show evidence");
    await act(async () => registry.set(first, AsyncResult.initial()));
    expect(host.textContent).toContain("FIRST-OWNER-0");
    expect(host.textContent).toContain("Cached or incomplete evidence");
    expect(host.textContent).toContain("· cached");
    expect(host.textContent).not.toContain("Complete recorded snapshot");
    expect(fixture.command).not.toHaveBeenCalled();
  });
  it("marks disconnected recorded metadata stale and restores the same owner on reconnect", async () => {
    await render();
    await click("Show evidence");
    fixture.connected = false;
    await render();
    expect(host.textContent).toContain("FIRST-OWNER-0");
    expect(host.textContent).toContain("Disconnected");
    expect(host.textContent).not.toContain("Complete recorded snapshot");
    fixture.connected = true;
    await render();
    expect(host.textContent).toContain("Complete recorded snapshot");
  });
  it("withholds evidence when capability or Project Work is removed and permits explicit return", async () => {
    await render();
    await click("Show evidence");
    fixture.supported = false;
    await render();
    expect(host.textContent).toContain("does not support evidence inspection");
    expect(host.textContent).not.toContain("FIRST-OWNER-");
    await click("Show project work");
    expect(host.textContent).toContain("Issue intake");
    fixture.supported = true;
    fixture.enabled = false;
    await render();
    await click("Show evidence");
    expect(host.textContent).not.toContain("FIRST-OWNER-");
    expect(host.textContent).toContain("disabled or unavailable");
  });
  it("uses bounded evidence pages and actual task navigation with reverse task filtering", async () => {
    registry.set(first, AsyncResult.success(page("PAGE-", 41)));
    await render();
    await click("Show evidence");
    expect(host.textContent).toContain("Page 1 of 3");
    expect(host.textContent).not.toContain("PAGE-20");
    await click("Next evidence page");
    expect(host.textContent).toContain("Page 2 of 3");
    expect(host.textContent).toContain("PAGE-20");
    await click("Inspect evidence for task task-1");
    expect(host.textContent).toContain("Page 1 of 3");
    await click("Show all project evidence");
    expect(host.textContent).toContain("Page 1 of 3");
    await click("Open task task-1");
    expect(fixture.navigate).toHaveBeenLastCalledWith("WorkTask", {
      environmentId,
      projectId,
      taskId: "task-1",
    });
    expect(fixture.command).not.toHaveBeenCalled();
  });
});
