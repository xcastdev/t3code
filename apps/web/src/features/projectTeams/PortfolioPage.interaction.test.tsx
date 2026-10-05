/* @vitest-environment happy-dom */
import { RegistryContext } from "@effect/atom-react";
import { scopeProject, type EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = await vi.hoisted(async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    projects: Atom.make<ReadonlyArray<EnvironmentProject>>([]),
    configs: Atom.make(
      new Map<
        EnvironmentId,
        {
          settings: { projectWorkEnabled: boolean };
          environment: { capabilities: { projectTeamSupervisionReads: boolean } };
        }
      >(),
    ),
    environments: Atom.make(new Map<EnvironmentId, { connection: { phase: string } }>()),
    supervision: vi.fn(),
  };
});
vi.mock("~/state/projects", () => ({ environmentProjects: { projectsAtom: fixture.projects } }));
vi.mock("~/state/entities", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return { useProjects: () => useAtomValue(fixture.projects) };
});
vi.mock("~/state/server", () => ({ environmentServerConfigsAtom: fixture.configs }));
vi.mock("~/state/presentation", () => ({
  environmentPresentations: { presentationsAtom: fixture.environments },
}));
vi.mock("~/state/projectWork", () => ({
  projectWorkEnvironment: { supervision: fixture.supervision },
}));

// Actual parent, approved query container and Portfolio display; transport is controlled here.
import { PortfolioPage } from "./PortfolioPage";
import type { PortfolioSourceProps } from "./PortfolioSource";
const navigationCallbacks = () => ({
  onOpenProject: vi.fn<PortfolioSourceProps["onOpenProject"]>(),
  onOpenTask: vi.fn<PortfolioSourceProps["onOpenTask"]>(),
  onOpenWorker: vi.fn<PortfolioSourceProps["onOpenWorker"]>(),
});

const environmentId = EnvironmentId.make("environment-1");
const decodeProject = Schema.decodeUnknownSync(OrchestrationProjectShell);
function project(index: number, environment = environmentId) {
  return scopeProject(
    environment,
    decodeProject({
      id: `project-${index}`,
      title: `Project ${index}`,
      workspaceRoot: `/fixture/project-${index}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-05T00:00:00Z",
      updatedAt: "2026-10-05T00:00:00Z",
    }),
  );
}
function summary(projectId: ProjectId) {
  return {
    projectId,
    availability: "available",
    revision: 1,
    lifecycleRevision: 1,
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
  };
}

describe("mounted bounded Portfolio project catalogue", () => {
  let registry: AtomRegistry.AtomRegistry;
  let root: Root;
  let host: HTMLDivElement;
  let reads: Set<string>;
  let callbacks: ReturnType<typeof navigationCallbacks>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    registry = AtomRegistry.make();
    reads = new Set();
    registry.set(fixture.projects, []);
    registry.set(
      fixture.configs,
      new Map([
        [
          environmentId,
          {
            settings: { projectWorkEnabled: true },
            environment: { capabilities: { projectTeamSupervisionReads: true } },
          },
        ],
      ]),
    );
    registry.set(
      fixture.environments,
      new Map([[environmentId, { connection: { phase: "connected" } }]]),
    );
    const unavailable = Atom.make(AsyncResult.initial());
    const queries = new Map<string, Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>>();
    fixture.supervision.mockReset();
    fixture.supervision.mockImplementation(
      (target: {
        environmentId: EnvironmentId;
        projectId: ProjectId;
        enabled: boolean;
        capability: boolean;
        connectionPhase: string;
      }) => {
        if (!target.enabled || !target.capability || target.connectionPhase !== "connected")
          return unavailable;
        const key = JSON.stringify([target.environmentId, target.projectId]);
        let query = queries.get(key);
        if (!query) {
          query = Atom.make(() => {
            reads.add(key);
            return AsyncResult.success(summary(target.projectId), { timestamp: 970_000 });
          });
          queries.set(key, query);
        }
        return query;
      },
    );
    callbacks = navigationCallbacks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    registry.dispose();
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function render(projects: ReadonlyArray<EnvironmentProject>) {
    registry.set(fixture.projects, projects);
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <PortfolioPage {...callbacks} />
        </RegistryContext.Provider>,
      ),
    );
  }
  function button(text: string) {
    const found = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === text,
    );
    if (!found) throw new Error(`Missing button ${text}`);
    return found;
  }
  async function click(text: string) {
    await act(async () => button(text).click());
  }
  function held(text: string) {
    const node = button(text);
    const key = Object.keys(node).find((key) => key.startsWith("__reactProps$"));
    if (!key) throw new Error("Missing mounted event props");
    const handler = Reflect.get(Reflect.get(node, key), "onClick");
    if (typeof handler !== "function") throw new Error("Missing mounted callback");
    return () => handler({});
  }
  it("subscribes only to the visible25 unique owners and advances to the remaining owner", async () => {
    const projects = Array.from({ length: 26 }, (_, index) => project(index));
    await render([projects[0]!, ...projects]);
    expect(reads.size).toBe(25);
    expect(host.querySelectorAll("h3")).toHaveLength(25);
    expect(host.textContent).not.toContain("Project 25");
    await click("Next portfolio page");
    expect(host.querySelectorAll("h3")).toHaveLength(1);
    expect(host.textContent).toContain("Project 25");
    expect(reads.size).toBe(26);
    await click("Previous portfolio page");
    expect(host.querySelectorAll("h3")).toHaveLength(25);
  });
  it("can leave a metadata page whose owners do not support supervision", async () => {
    const remote = EnvironmentId.make("supported-environment");
    registry.set(
      fixture.configs,
      new Map([
        [
          remote,
          {
            settings: { projectWorkEnabled: true },
            environment: { capabilities: { projectTeamSupervisionReads: true } },
          },
        ],
      ]),
    );
    registry.set(fixture.environments, new Map([[remote, { connection: { phase: "connected" } }]]));
    await render([
      ...Array.from({ length: 25 }, (_, index) => project(index)),
      project(25, remote),
    ]);
    expect(reads.size).toBe(0);
    expect(button("Next portfolio page").disabled).toBe(false);
    await click("Next portfolio page");
    expect(host.textContent).toContain("Project 25");
    expect(reads.size).toBe(1);
  });
  it("revokes a held worker link on a disconnect before React commits its metadata update", async () => {
    await render([project(0)]);
    const worker = held("Inspect worker worker-1");
    await act(async () => {
      registry.set(
        fixture.environments,
        new Map([[environmentId, { connection: { phase: "disconnected" } }]]),
      );
      worker();
    });
    expect(callbacks.onOpenWorker).not.toHaveBeenCalled();
  });
  it("revokes a held task link on capability loss before React commits", async () => {
    await render([project(0)]);
    const task = held("Inspect task task-1");
    await act(async () => {
      registry.set(
        fixture.configs,
        new Map([
          [
            environmentId,
            {
              settings: { projectWorkEnabled: true },
              environment: { capabilities: { projectTeamSupervisionReads: false } },
            },
          ],
        ]),
      );
      task();
    });
    expect(callbacks.onOpenTask).not.toHaveBeenCalled();
  });
  it("retires held project inspection when its owner is removed before commit", async () => {
    await render([project(0)]);
    const inspect = held("Inspect project Project 0");
    await act(async () => {
      registry.set(fixture.projects, [project(1)]);
      inspect();
    });
    expect(callbacks.onOpenProject).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Project 1");
  });
  it("resets a removed page to the surviving owner's current catalogue", async () => {
    const projects = Array.from({ length: 26 }, (_, index) => project(index));
    await render(projects);
    await click("Next portfolio page");
    await act(async () => registry.set(fixture.projects, [projects[0]!]));
    expect(host.textContent).toContain("Project 0");
    expect(button("Previous portfolio page").disabled).toBe(true);
  });
});
