/* @vitest-environment happy-dom */
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, ProjectTeamSupervisionSummary } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { act, Profiler, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  registry: undefined as unknown,
  foundationPage: vi.fn(),
  supervision: vi.fn(),
  supervisionSupported: true,
  page: vi.fn(),
  navigate: vi.fn(),
  command: vi.fn(),
  enabled: true,
  supported: true,
  connected: true,
  available: true,
  focused: true,
}));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => fixture.focused,
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
    environment: {
      capabilities: {
        projectTeamFoundationReads: fixture.supported,
        projectTeamSupervisionReads: fixture.supervisionSupported,
      },
    },
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
  mobileWorkEnvironment: {
    foundationPage: fixture.foundationPage,
    page: fixture.page,
    supervision: fixture.supervision,
  },
}));

// Actual screen, foundation hook/cache, shared decoder, Team and Evidence remain mounted.
import { ProjectWorkScreen } from "./WorkScreens";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const metadata = { revision: 1, generation: 1, supported: true };
const profile = {
  ...metadata,
  recordId: "profile-1",
  status: "available",
  roleId: "implementer",
  roleRevision: 2,
  role: "implementer",
  model: "profile-model",
};
const accounting = {
  availability: "available",
  projectId,
  environmentId,
  bindingId: "binding-1",
  generation: 1,
  taskId: "task-1",
  attemptId: "attempt-1",
  observedAt: "2026-10-01T00:00:00.000Z",
  root: {
    taskId: "root",
    maximumTokens: 1000,
    deadlineAtMs: 2000,
    chargedTokens: 200,
    reservedTokens: 50,
    unknownChargedTokens: 40,
    remainingTokens: 750,
    heldCalls: 1,
    quarantinedCalls: 1,
  },
  attempt: {
    maximumTokens: 400,
    deadlineAtMs: 1500,
    chargedTokens: 150,
    reservedTokens: 10,
    unknownChargedTokens: 40,
    remainingTokens: 240,
    heldCalls: 1,
    quarantinedCalls: 1,
  },
};
const binding = {
  accounting,
  ...metadata,
  recordId: "binding-1",
  status: "running",
  taskId: "task-1",
  attemptId: "attempt-1",
  memberId: "member-1",
  roleRevisionId: "profile-1",
  providerInstanceId: "pi-local",
  model: "frozen-model",
  workerThreadId: "worker-1",
  profile,
};
const blocker = {
  recordId: "blocker-1",
  revision: 2,
  taskId: "task-blocked",
  reason: "Waiting for a decision",
  resolver: "human",
};
const question = {
  ...metadata,
  recordId: "question-1",
  status: "pending",
  taskId: "task-question",
  senderId: "member-1",
  targetGateId: "gate-1",
  targetRevision: 4,
};
const decode = Schema.decodeUnknownSync(ProjectTeamSupervisionSummary);
const decoded = decode({
  projectId,
  availability: "available",
  revision: 10,
  lifecycleRevision: 2,
  taskCounts: {
    draft: 1,
    specified: 2,
    ready: 3,
    "in-progress": 4,
    blocked: 5,
    "in-review": 6,
    completed: 7,
    failed: 8,
    canceled: 9,
    unknown: 10,
    total: 55,
  },
  coordinator: {
    ...metadata,
    recordId: "coordinator-1",
    status: "active",
    name: "Coordinator Alpha",
    roleRevisionId: "coordinator-profile",
    profile: {
      ...profile,
      recordId: "coordinator-profile",
      role: "coordinator",
      model: "coordinator-model",
    },
  },
  missions: {
    items: [{ ...metadata, recordId: "mission-1", status: "active", title: "Alpha mission" }],
    hasMore: false,
  },
  bindings: { items: [binding], hasMore: false },
  blockers: { items: [blocker], hasMore: false },
  questions: { items: [question], hasMore: false },
});
if (decoded.availability !== "available") throw new Error("Available fixture required");
const available = decoded;
let registry: AtomRegistry.AtomRegistry;
let first: ReturnType<typeof Atom.make<AsyncResult.AsyncResult<unknown, unknown>>>;
let second: typeof first;
let root: Root;
let host: HTMLDivElement;
let frames: string[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  registry = AtomRegistry.make();
  fixture.registry = registry;
  fixture.enabled = fixture.supported = fixture.connected = fixture.available = true;
  fixture.foundationPage.mockReset();
  fixture.page.mockReset();
  fixture.navigate.mockReset();
  fixture.command.mockReset();
  first = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(
    AsyncResult.success(available, { timestamp: Date.now() - 60_000 }),
  );
  second = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(AsyncResult.initial());
  fixture.foundationPage.mockReturnValue(
    Atom.make(AsyncResult.success({ projectId, revision: 10, items: [] })),
  );
  fixture.supervisionSupported = true;
  fixture.focused = true;
  fixture.supervision.mockReset();
  const unavailable = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(AsyncResult.initial());
  fixture.supervision.mockImplementation(
    (target: {
      environmentId: string;
      enabled: boolean;
      capability?: boolean;
      connectionPhase: string;
    }) =>
      target.enabled && target.capability && target.connectionPhase === "connected"
        ? target.environmentId === environmentId
          ? first
          : second
        : unavailable,
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
  vi.restoreAllMocks();
});
async function render(owner: string = environmentId, selectedProject: string = projectId) {
  await act(async () =>
    root.render(
      <StrictMode>
        <RegistryContext.Provider value={registry}>
          <Profiler id="project-screen" onRender={() => frames.push(host.textContent ?? "")}>
            <ProjectWorkScreen
              route={{ params: { environmentId: owner, projectId: selectedProject } }}
            />
          </Profiler>
        </RegistryContext.Provider>
      </StrictMode>,
    ),
  );
}
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent === label);
  if (!button) throw new Error("Missing button " + label);
  await act(async () => button.click());
}

describe("actual project screen supervision read", () => {
  it("renders assignment accounting from the existing complete Team read", async () => {
    const run = {
      kind: "run-binding",
      projectId,
      recordId: "binding-1",
      revision: 1,
      generation: 1,
      updatedAt: "2026-10-01T00:00:00.000Z",
      status: "settled",
      taskId: "task-1",
      attemptId: "attempt-1",
      memberId: "member-1",
      roleRevisionId: "role-1",
      providerInstanceId: "pi",
      threadId: "worker-1",
      environmentId,
      model: "frozen",
      configuration: {
        instructionsHash: "hash",
        toolIds: [],
        skillIds: [],
        runtimeVersion: "1",
        maxTokens: 1000,
        maxDurationMs: 1000,
        paidFallback: false,
      },
      worktree: "/workspace",
      branch: "task",
      leaseGeneration: 1,
      specRevision: 1,
      planRevision: 1,
    };
    fixture.foundationPage.mockReturnValue(
      Atom.make(
        AsyncResult.success({ projectId, revision: 10, items: [run], accounting: [accounting] }),
      ),
    );
    await render();
    expect(host.textContent).toContain("Task task-1 · attempt attempt-1");
    expect(host.textContent).toContain(
      "Shared root: 200 charged (40 unknown), 50 held; 750/1000 tokens remaining.",
    );
    expect(host.textContent).toContain("Original deadline");
    expect(fixture.supervision).not.toHaveBeenCalled();
    expect(fixture.command).not.toHaveBeenCalled();
    expect(fixture.navigate).not.toHaveBeenCalled();
  });

  it("withholds navigation for a non-finite receive timestamp without a render loop", async () => {
    first = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(
      AsyncResult.success(available, { timestamp: Number.NaN }),
    );
    await render();
    await click("Show supervision");
    expect(host.textContent).toContain("Coordinator Alpha");
    expect(host.textContent).toContain("Receive age unavailable: invalid or future receive time.");
    expect(host.textContent).toContain("Cached or unavailable summary");
    expect(host.textContent).not.toContain("Current recorded summary");
    expect(host.textContent).not.toContain("Inspect task task-1");
    expect(host.textContent).not.toContain("Inspect worker worker-1");
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(fixture.command).not.toHaveBeenCalled();
  });
  it("opens bounded supervision lazily and returns to work", async () => {
    await render();
    expect(fixture.supervision).not.toHaveBeenCalled();
    await click("Show supervision");
    expect(host.textContent).toContain("Coordinator Alpha");
    expect(host.textContent).toContain("Current recorded summary");
    expect(host.textContent).toContain("Received 60 seconds ago.");
    expect(host.textContent).toContain("Binding model: frozen-model");
    expect(host.textContent).toContain(
      "Shared root: 200 charged (40 unknown), 50 held; 750/1000 tokens remaining.",
    );
    expect(host.textContent).toContain(
      "This attempt: 150 charged (40 unknown), 10 held; 240/400 tokens remaining.",
    );
    expect(host.textContent).not.toContain("Issue intake");
    expect(fixture.command).not.toHaveBeenCalled();
    await click("Show project work");
    expect(host.textContent).toContain("Issue intake");
    expect(host.textContent).not.toContain("Coordinator Alpha");
  });
  it("refreshes scalar usage at the same revision without issuing work or per-worker reads", async () => {
    await render();
    await click("Show supervision");
    await act(async () =>
      registry.set(
        first,
        AsyncResult.success(
          {
            ...available,
            bindings: {
              ...available.bindings,
              items: [
                {
                  ...binding,
                  accounting: {
                    ...accounting,
                    root: { ...accounting.root, chargedTokens: 210, remainingTokens: 740 },
                  },
                },
              ],
            },
          },
          { timestamp: 1_000_000 },
        ),
      ),
    );
    expect(host.textContent).toContain("Shared root: 210 charged");
    expect(host.textContent).not.toContain("Shared root: 200 charged");
    fixture.connected = false;
    await render();
    expect(host.textContent).toContain("Shared root: 210 charged");
    expect(host.textContent).toContain("Cached or unavailable summary");
    expect(host.textContent).not.toContain("Inspect worker worker-1");
    expect(fixture.command).not.toHaveBeenCalled();
    expect(fixture.navigate).not.toHaveBeenCalled();
  });

  it("keeps the actual receive time during waiting refresh and unrelated rerender", async () => {
    await render();
    await click("Show supervision");
    const received = registry.get(first);
    if (received._tag !== "Success") throw new Error("Expected success");
    await act(async () =>
      registry.set(
        first,
        AsyncResult.success(available, { waiting: true, timestamp: received.timestamp }),
      ),
    );
    await render();
    expect(host.textContent).toContain("Cached or unavailable summary");
    expect(host.textContent).toContain("Received 60 seconds ago.");
    expect(host.textContent).not.toContain("Current recorded summary");
    expect(host.textContent).not.toContain("Inspect task task-1");
  });
  it("keeps owner cache on disconnect while withholding worker navigation", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    await render();
    await click("Show supervision");
    const received = registry.get(first);
    if (received._tag !== "Success") throw new Error("Expected success");
    clock.mockReturnValue(received.timestamp + 3_600_000);
    fixture.connected = false;
    await render();
    expect(host.textContent).toContain("Coordinator Alpha");
    expect(host.textContent).toContain("Cached or unavailable summary");
    expect(host.textContent).toContain("Received 3600 seconds ago.");
    expect(host.textContent).not.toContain("Inspect worker worker-1");
    fixture.connected = true;
    await render();
    expect(host.textContent).toContain("Current recorded summary");
  });
  for (const flag of ["enabled", "supervisionSupported", "available", "focused"] as const) {
    it(`withholds current supervision when ${flag} is removed`, async () => {
      await render();
      await click("Show supervision");
      fixture[flag] = false;
      await render();
      expect(host.textContent).not.toContain("Current recorded summary");
      expect(host.textContent).not.toContain("Inspect task task-1");
      expect(host.textContent).not.toContain("Inspect worker worker-1");
    });
  }
  it("changes environment without any committed foreign cached metadata", async () => {
    await render();
    await click("Show supervision");
    frames = [];
    await render("environment-2");
    expect(frames.every((frame) => !frame.includes("Coordinator Alpha"))).toBe(true);
    await click("Show supervision");
    expect(host.textContent).not.toContain("Coordinator Alpha");
    await act(async () =>
      registry.set(
        second,
        AsyncResult.success({
          ...available,
          coordinator: { ...available.coordinator, name: "Second owner" },
        }),
      ),
    );
    expect(host.textContent).toContain("Second owner");
    expect(host.textContent).not.toContain("Coordinator Alpha");
  });
  it("rejects foreign owner data before showing or navigating it", async () => {
    first = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(
      AsyncResult.success({ ...available, projectId: "foreign-project" }),
    );
    await render();
    await click("Show supervision");
    expect(host.textContent).not.toContain("Coordinator Alpha");
    expect(host.textContent).not.toContain("Current recorded summary");
    expect(fixture.navigate).not.toHaveBeenCalled();
  });
  it("navigates to an exact environment and task or existing worker without sending commands", async () => {
    await render();
    await click("Show supervision");
    await click("Inspect task task-1");
    expect(fixture.navigate).toHaveBeenLastCalledWith("WorkTask", {
      environmentId,
      projectId,
      taskId: "task-1",
    });
    await click("Inspect worker worker-1");
    expect(fixture.navigate).toHaveBeenLastCalledWith("Thread", {
      environmentId,
      threadId: "worker-1",
    });
    expect(fixture.command).not.toHaveBeenCalled();
  });
  it("displays the latest missing project state instead of an earlier available summary", async () => {
    await render();
    await click("Show supervision");
    await act(async () =>
      registry.set(first, AsyncResult.success({ projectId, availability: "missing" })),
    );
    expect(host.textContent).toContain("Project missing.");
    expect(host.textContent).not.toContain("Coordinator Alpha");
    expect(host.textContent).not.toContain("Current recorded summary");
  });

  it("uses previous success receive time on failure without showing transport error secrets", async () => {
    await render();
    await click("Show supervision");
    const previous = registry.get(first);
    if (previous._tag !== "Success") throw new Error("Expected success");
    await act(async () =>
      registry.set(
        first,
        AsyncResult.failure(Cause.fail(new Error("PRIVATE-TRANSPORT-DETAIL")), {
          previousSuccess: Option.some(previous),
        }),
      ),
    );
    expect(host.textContent).toContain("Coordinator Alpha");
    expect(host.textContent).toContain("Received 60 seconds ago.");
    expect(host.textContent).toContain("Could not refresh supervision");
    expect(host.textContent).not.toContain("PRIVATE-TRANSPORT-DETAIL");
    expect(host.textContent).not.toContain("Current recorded summary");
    expect(host.textContent).not.toContain("Inspect worker worker-1");
  });
  it("retains same-owner cache after incoherent input without marking it current", async () => {
    await render();
    await click("Show supervision");
    await act(async () =>
      registry.set(
        first,
        AsyncResult.success({ ...available, taskCounts: { ...available.taskCounts, total: 999 } }),
      ),
    );
    expect(host.textContent).toContain("Coordinator Alpha");
    expect(host.textContent).toContain("Unsupported or incoherent supervision metadata");
    expect(host.textContent).not.toContain("Current recorded summary");
    expect(host.textContent).not.toContain("Inspect task task-1");
  });
  it("keeps older-server capability absence explicit without issuing enabled supervision reads", async () => {
    fixture.supervisionSupported = false;
    await render();
    await click("Show supervision");
    expect(host.textContent).toContain("does not support supervision");
    expect(host.textContent).not.toContain("Coordinator Alpha");
    expect(fixture.supervision.mock.calls.every(([target]) => target.capability === false)).toBe(
      true,
    );
  });
  it("never commits a previous project's cache when switching project in the same environment", async () => {
    await render();
    await click("Show supervision");
    frames = [];
    await render(environmentId, "project-2");
    expect(frames.every((frame) => !frame.includes("Coordinator Alpha"))).toBe(true);
    await click("Show supervision");
    expect(host.textContent).not.toContain("Coordinator Alpha");
    expect(host.textContent).not.toContain("Current recorded summary");
  });
});
