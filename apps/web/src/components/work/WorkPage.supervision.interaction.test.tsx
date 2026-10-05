/* @vitest-environment happy-dom */
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, ProjectTeamSupervisionSummary } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { act, Profiler, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  config: undefined as unknown,
  phase: "connected",
  supervision: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => fixture.navigate,
}));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: fixture.phase } }),
}));
vi.mock("~/state/entities", () => ({ useProject: () => ({ title: "Selected project" }) }));
vi.mock("~/state/server", () => ({ serverEnvironment: { configValueAtom: () => fixture.config } }));
vi.mock("~/state/projectWork", () => ({
  projectWorkEnvironment: { supervision: fixture.supervision },
}));
vi.mock("../ui/sidebar", () => ({
  SidebarInset: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
}));
vi.mock("../WorkspacePageContainer", () => ({
  WorkspacePageContainer: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
}));
vi.mock("./WorkOverview", () => ({ WorkOverview: () => <p>Project overview</p> }));
vi.mock("./WorkTasks", () => ({
  WorkTasks: ({ targetTaskId }: { targetTaskId?: string }) => <p>Selected task {targetTaskId}</p>,
}));
vi.mock("../../features/projectTeams/Team", () => ({
  Team: () => <p>Project team destination</p>,
}));

// Mount the actual parent, query container, shared decoder and supervision display.
// These tests exercise client routing; real RPC, browser and device gates remain separate.
import { WorkPage } from "./WorkPage";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const decode = Schema.decodeUnknownSync(ProjectTeamSupervisionSummary);
const summary = decode({
  projectId,
  availability: "available",
  revision: 10,
  taskCounts: {
    draft: 0,
    specified: 0,
    ready: 0,
    "in-progress": 1,
    blocked: 0,
    "in-review": 0,
    completed: 0,
    failed: 0,
    canceled: 0,
    unknown: 0,
    total: 1,
  },
  missions: { items: [], hasMore: false },
  bindings: {
    items: [
      {
        recordId: "binding-1",
        revision: 1,
        generation: 1,
        supported: true,
        status: "running",
        taskId: "task-1",
        attemptId: "attempt-1",
        memberId: "member-1",
        roleRevisionId: "profile-1",
        providerInstanceId: "pi-local",
        model: "Recorded model",
        workerThreadId: "worker-1",
        profile: {
          recordId: "profile-1",
          revision: 1,
          generation: 1,
          supported: true,
          status: "available",
          roleId: "implementer",
          roleRevision: 1,
          role: "implementer",
          model: "Profile model",
        },
      },
    ],
    hasMore: false,
  },
  blockers: { items: [], hasMore: false },
  questions: { items: [], hasMore: false },
});
type Config = {
  settings: { projectWorkEnabled: boolean };
  environment: {
    capabilities: { projectWorkStream: boolean; projectTeamSupervisionReads?: boolean };
  };
};
let config: Atom.Writable<Config>;
let registry: AtomRegistry.AtomRegistry;
let data: ReturnType<typeof Atom.make<AsyncResult.AsyncResult<unknown, unknown>>>;
let root: Root;
let host: HTMLDivElement;
let frames: string[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  registry = AtomRegistry.make();
  config = Atom.make<Config>({
    settings: { projectWorkEnabled: true },
    environment: { capabilities: { projectWorkStream: false, projectTeamSupervisionReads: true } },
  });
  fixture.config = config;
  fixture.phase = "connected";
  fixture.navigate.mockReset();
  fixture.supervision.mockReset();
  data = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(
    AsyncResult.success(summary, { timestamp: 940_000 }),
  );
  const inactive = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(AsyncResult.initial());
  fixture.supervision.mockImplementation(
    (target: {
      environmentId: string;
      projectId: string;
      enabled: boolean;
      capability: boolean;
      connectionPhase: string;
    }) =>
      target.environmentId === environmentId &&
      target.projectId === projectId &&
      target.enabled &&
      target.capability &&
      target.connectionPhase === "connected"
        ? data
        : inactive,
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
async function render(environment = environmentId, project = projectId) {
  await act(async () =>
    root.render(
      <StrictMode>
        <RegistryContext.Provider value={registry}>
          <Profiler id="actual-work-page" onRender={() => frames.push(host.textContent ?? "")}>
            <WorkPage environmentId={environment} projectId={project} />
          </Profiler>
        </RegistryContext.Provider>
      </StrictMode>,
    ),
  );
}
async function tab(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((node) =>
    node.textContent?.includes(label),
  );
  if (!button) throw new Error("Missing actual Work tab " + label);
  await act(async () => button.click());
}
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent === label);
  if (!button) throw new Error("Missing mounted control " + label);
  await act(async () => button.click());
}

describe("actual WorkPage supervision mounting", () => {
  it("opens lazily, uses an exact existing worker route and returns to overview", async () => {
    await render();
    expect(fixture.supervision).not.toHaveBeenCalled();
    await tab("Supervision");
    expect(host.textContent).toContain("Current recorded summary");
    expect(host.textContent).toContain("Received 60 seconds ago.");
    await click("Inspect worker worker-1");
    expect(fixture.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: "worker-1" },
    });
    await tab("Overview");
    expect(host.textContent).toContain("Project overview");
    expect(host.textContent).not.toContain("Recorded model");
  });
  it("opens the recorded task in the existing Tasks section and returns to supervision", async () => {
    await render();
    await tab("Supervision");
    await click("Inspect task task-1");
    expect(host.textContent).toContain("Selected task task-1");
    expect(host.textContent).not.toContain("Recorded model");
    expect(fixture.navigate).not.toHaveBeenCalled();
    await tab("Supervision");
    expect(host.textContent).toContain("Recorded model");
  });
  it("opens the same project's Team section from cached metadata and returns", async () => {
    await render();
    await tab("Supervision");
    fixture.phase = "disconnected";
    await render();
    await click("Inspect project Selected project");
    expect(host.textContent).toContain("Project team destination");
    expect(host.textContent).not.toContain("Recorded model");
    expect(fixture.navigate).not.toHaveBeenCalled();
    await tab("Supervision");
    expect(host.textContent).toContain("No summary received.");
    expect(host.textContent).not.toContain("Recorded model");
  });
  it("keeps disconnected metadata historical and removes worker navigation", async () => {
    await render();
    await tab("Supervision");
    fixture.phase = "disconnected";
    await render();
    expect(host.textContent).toContain("Recorded model");
    expect(host.textContent).toContain("Cached or unavailable summary");
    expect(host.textContent).not.toContain("Inspect worker worker-1");
    expect(fixture.navigate).not.toHaveBeenCalled();
  });
  it("does not commit a prior owner's summary when the environment changes", async () => {
    await render();
    await tab("Supervision");
    frames = [];
    await render(EnvironmentId.make("environment-2"));
    expect(frames.every((frame) => !frame.includes("Recorded model"))).toBe(true);
    await tab("Supervision");
    expect(host.textContent).not.toContain("Recorded model");
    expect(fixture.navigate).not.toHaveBeenCalled();
  });
  it("does not commit a prior project's summary when the project changes", async () => {
    await render();
    await tab("Supervision");
    frames = [];
    await render(environmentId, ProjectId.make("project-2"));
    expect(frames.every((frame) => !frame.includes("Recorded model"))).toBe(true);
    await tab("Supervision");
    expect(host.textContent).not.toContain("Recorded model");
  });
  it("shows older-server capability absence without an enabled summary read", async () => {
    config = Atom.make<Config>({
      settings: { projectWorkEnabled: true },
      environment: { capabilities: { projectWorkStream: false } },
    });
    fixture.config = config;
    await render();
    await tab("Supervision");
    expect(host.textContent).toContain("does not support supervision");
    expect(host.textContent).not.toContain("Recorded model");
    expect(fixture.supervision.mock.calls.every(([target]) => target.capability === false)).toBe(
      true,
    );
  });
  it("removes the mounted read when project work is disabled", async () => {
    await render();
    await tab("Supervision");
    await act(async () =>
      registry.set(config, {
        settings: { projectWorkEnabled: false },
        environment: {
          capabilities: { projectWorkStream: false, projectTeamSupervisionReads: true },
        },
      }),
    );
    expect(host.textContent).toContain("Project Work is turned off");
    expect(host.textContent).not.toContain("Recorded model");
    expect(fixture.navigate).not.toHaveBeenCalled();
  });
});
