/* @vitest-environment happy-dom */
import {
  EnvironmentId,
  ProjectId,
  ProjectTeamSupervisionSummary,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act, Profiler, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const controls = vi.hoisted(() => new Map<string, () => void>());
// Mounted React lifecycle with Native hosts represented by DOM elements; this is not a device test.
vi.mock("react-native", async () => {
  const React = await import("react");
  return {
    View: ({ children }: { children: ReactNode }) => React.createElement("div", {}, children),
  };
});
vi.mock("./WorkScreens", async () => {
  const React = await import("react");
  return {
    WorkCard: ({ title, children }: { title: string; children: ReactNode }) =>
      React.createElement("section", {}, React.createElement("h2", {}, title), children),
    Notice: ({ children }: { children: ReactNode }) => React.createElement("p", {}, children),
    WorkButton: ({
      children,
      onPress,
      disabled,
    }: {
      children: ReactNode;
      onPress: () => void;
      disabled?: boolean;
    }) => {
      const label = React.Children.toArray(children).join("");
      React.useLayoutEffect(() => {
        controls.set(label, onPress);
      });
      return React.createElement("button", { disabled, onClick: onPress }, children);
    },
  };
});
import { WorkSupervision, type WorkSupervisionProps } from "./WorkSupervision";

const environmentId = EnvironmentId.make("environment-1");
const otherEnvironmentId = EnvironmentId.make("environment-2");
const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const threadId = ThreadId.make("worker-1");
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
const binding = {
  ...metadata,
  recordId: "binding-1",
  status: "running",
  taskId: "task-1",
  attemptId: "attempt-1",
  memberId: "member-1",
  roleRevisionId: "profile-1",
  providerInstanceId: "pi-local",
  model: "frozen-model",
  workerThreadId: threadId,
  profile,
};
const { profile: _profile, ...bindingWithoutProfile } = binding;
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
const now = 1_000_000;

describe("mounted mobile recorded supervision", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: WorkSupervisionProps;
  let frames: string[];
  let unmounted: boolean;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    controls.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    frames = [];
    unmounted = false;
    props = {
      environmentId,
      projectId,
      title: "Project Alpha",
      connected: true,
      enabled: true,
      supported: true,
      current: true,
      snapshot: { environmentId, data: available, receivedAt: now - 30_000 },
      now,
      onOpenTask: vi.fn(),
      onOpenWorker: vi.fn(),
      onInspectProject: vi.fn(),
    };
  });
  afterEach(async () => {
    if (!unmounted) await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  async function render(overrides: Partial<WorkSupervisionProps> = {}) {
    props = { ...props, ...overrides };
    await act(async () =>
      root.render(
        <StrictMode>
          <Profiler id="supervision" onRender={() => frames.push(host.textContent ?? "")}>
            <WorkSupervision {...props} />
          </Profiler>
        </StrictMode>,
      ),
    );
  }
  async function summary(data: ProjectTeamSupervisionSummary) {
    await render({
      snapshot: { environmentId: props.environmentId, data, receivedAt: now - 30_000 },
    });
  }
  function held(label: string) {
    const control = controls.get(label);
    if (!control) throw new Error("Missing mounted control " + label);
    return control;
  }
  async function click(label: string) {
    const button = [...host.querySelectorAll("button")].find((item) => item.textContent === label);
    if (!button) throw new Error("Missing button " + label);
    await act(async () => button.click());
  }
  function noAssignments() {
    expect(
      [...host.querySelectorAll("button")].filter((item) =>
        /Inspect task|Inspect worker/.test(item.textContent ?? ""),
      ),
    ).toHaveLength(0);
  }

  it("shows coherent buckets, revisions and frozen binding model separately from its profile", async () => {
    await render();
    for (const text of [
      "Current recorded summary",
      "Project revision 10",
      "Lifecycle revision 2",
      "Received 30 seconds ago",
      "Coordinator Alpha",
      "coordinator-model",
      "Binding model: frozen-model",
      "Profile: implementer · profile-model",
      "Record revision 1 · Generation 1",
      "Alpha mission",
      "Waiting for a decision",
      "Gate gate-1 · Target revision 4",
      "do not verify execution health",
    ])
      expect(host.textContent).toContain(text);
    for (const [key, count] of Object.entries(available.taskCounts))
      expect(host.textContent).toContain(`${key} ${count}`);
    expect(frames.every((frame) => frame.includes("Project Alpha"))).toBe(true);
  });
  it("opens each task, worker and explicit project in the captured owner", async () => {
    await render();
    await click("Inspect task task-1");
    await click("Inspect task task-blocked");
    await click("Inspect task task-question");
    await click("Inspect worker worker-1");
    await click("Inspect project Project Alpha");
    expect(props.onOpenTask).toHaveBeenNthCalledWith(1, {
      environmentId,
      projectId,
      taskId: "task-1",
    });
    expect(props.onOpenTask).toHaveBeenNthCalledWith(2, {
      environmentId,
      projectId,
      taskId: "task-blocked",
    });
    expect(props.onOpenTask).toHaveBeenNthCalledWith(3, {
      environmentId,
      projectId,
      taskId: "task-question",
    });
    expect(props.onOpenWorker).toHaveBeenCalledWith({ environmentId, projectId, threadId });
    expect(props.onInspectProject).toHaveBeenCalledWith({ environmentId, projectId });
  });
  for (const flag of ["connected", "enabled", "supported", "current"] as const) {
    it(`keeps cached metadata but revokes mounted and held assignment controls when ${flag} is false`, async () => {
      await render();
      const task = held("Inspect task task-1"),
        worker = held("Inspect worker worker-1");
      await render({ [flag]: false });
      expect(host.textContent).toContain("Cached or unavailable summary");
      expect(host.textContent).toContain("Cached · Received 30 seconds ago");
      expect(host.textContent).toContain("frozen-model");
      noAssignments();
      await act(async () => {
        task();
        worker();
      });
      expect(props.onOpenTask).not.toHaveBeenCalled();
      expect(props.onOpenWorker).not.toHaveBeenCalled();
      await click("Inspect project Project Alpha");
      expect(props.onInspectProject).toHaveBeenCalledWith({ environmentId, projectId });
    });
  }
  for (const error of ["", "Read failed"])
    it(`shows error ${JSON.stringify(error)} and revokes held navigation`, async () => {
      await render();
      const task = held("Inspect task task-1");
      await render({ error });
      expect(host.textContent).toContain("Read error: " + (error || "No details recorded"));
      noAssignments();
      await act(async () => task());
      expect(props.onOpenTask).not.toHaveBeenCalled();
    });
  for (const receivedAt of [-1, NaN, Infinity, now + 1])
    it(`refuses invalid receive time ${receivedAt}`, async () => {
      await render();
      const worker = held("Inspect worker worker-1");
      await render({ snapshot: { environmentId, data: available, receivedAt } });
      expect(host.textContent).toContain("Receive age unavailable");
      noAssignments();
      await act(async () => worker());
      expect(props.onOpenWorker).not.toHaveBeenCalled();
    });
  for (const value of [-1, NaN, Infinity])
    it(`refuses invalid clock input ${value}`, async () => {
      await render({ now: value });
      noAssignments();
      expect(host.textContent).toContain("Receive age unavailable");
    });
  it("accepts finite zero receive time and updates age only when the parent renders", async () => {
    await render({ now: 0, snapshot: { environmentId, data: available, receivedAt: 0 } });
    expect(host.textContent).toContain("Received 0 seconds ago");
    await click("Inspect worker worker-1");
    await render({ now: 123_000 });
    expect(host.textContent).toContain("Received 123 seconds ago");
  });
  it("shows missing snapshots and bounded read errors", async () => {
    await render({ snapshot: undefined, error: "x".repeat(241) });
    expect(host.textContent).toContain("No summary received");
    expect(host.textContent).toContain("x".repeat(240));
    expect(host.textContent).not.toContain("x".repeat(241));
    noAssignments();
  });
  for (const availability of [
    "missing",
    "deleted",
    "archived",
    "tombstoned",
    "unsupported",
  ] as const)
    it(`shows ${availability} without assignment metadata`, async () => {
      await summary({ projectId, availability });
      expect(host.textContent).toContain(`Project ${availability}`);
      expect(host.textContent).not.toContain("frozen-model");
      noAssignments();
    });
  for (const switchOwner of [{ environmentId: otherEnvironmentId }, { projectId: otherProjectId }])
    it(`excludes stale owner fields in every committed switch frame ${JSON.stringify(switchOwner)}`, async () => {
      await render();
      const task = held("Inspect task task-1"),
        inspect = held("Inspect project Project Alpha");
      frames.length = 0;
      await render({ ...switchOwner, title: "Project Beta" });
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frame).not.toContain("frozen-model");
        expect(frame).not.toContain("Coordinator Alpha");
        expect(frame).not.toContain("Project revision 10");
      }
      expect(host.textContent).toContain("Snapshot owner mismatch");
      await act(async () => {
        task();
        inspect();
      });
      expect(props.onOpenTask).not.toHaveBeenCalled();
      expect(props.onInspectProject).not.toHaveBeenCalled();
      await summary({ ...available, projectId: props.projectId });
      await click("Inspect worker worker-1");
      expect(props.onOpenWorker).toHaveBeenCalledWith({
        environmentId: props.environmentId,
        projectId: props.projectId,
        threadId,
      });
    });
  for (const foreign of [
    { environmentId: otherEnvironmentId, data: available },
    { environmentId, data: { ...available, projectId: otherProjectId } },
  ])
    it(`rejects raw foreign snapshots ${JSON.stringify([foreign.environmentId, foreign.data.projectId])}`, async () => {
      await render({ snapshot: { ...foreign, receivedAt: now } });
      expect(host.textContent).toContain("Snapshot owner mismatch");
      expect(host.textContent).not.toContain("frozen-model");
      noAssignments();
    });
  it("never revives a held control from an earlier owner lifetime", async () => {
    await render();
    const task = held("Inspect task task-1"),
      worker = held("Inspect worker worker-1"),
      inspect = held("Inspect project Project Alpha");
    await render({ environmentId: otherEnvironmentId });
    await render({ environmentId });
    await act(async () => {
      task();
      worker();
      inspect();
    });
    expect(props.onOpenTask).not.toHaveBeenCalled();
    expect(props.onOpenWorker).not.toHaveBeenCalled();
    expect(props.onInspectProject).not.toHaveBeenCalled();
    await click("Inspect task task-1");
    expect(props.onOpenTask).toHaveBeenCalledWith({ environmentId, projectId, taskId: "task-1" });
  });
  it("revokes still-current held task, worker and project controls after unmount", async () => {
    await render();
    const task = held("Inspect task task-1"),
      worker = held("Inspect worker worker-1"),
      inspect = held("Inspect project Project Alpha");
    await act(async () => root.unmount());
    unmounted = true;
    await act(async () => {
      task();
      worker();
      inspect();
    });
    expect(props.onOpenTask).not.toHaveBeenCalled();
    expect(props.onOpenWorker).not.toHaveBeenCalled();
    expect(props.onInspectProject).not.toHaveBeenCalled();
  });
  it("retains duplicate thread metadata while revoking ambiguous worker navigation", async () => {
    await render();
    const worker = held("Inspect worker worker-1");
    await summary({
      ...available,
      bindings: {
        items: [binding, { ...binding, recordId: "binding-2", taskId: "task-2" }],
        hasMore: false,
      },
    });
    expect(host.textContent).toContain("binding-1");
    expect(host.textContent).toContain("binding-2");
    expect(host.textContent).toContain("Worker thread is shared by multiple bindings");
    expect(
      [...host.querySelectorAll("button")].some(
        (item) => item.textContent === "Inspect worker worker-1",
      ),
    ).toBe(false);
    await act(async () => worker());
    expect(props.onOpenWorker).not.toHaveBeenCalled();
    await click("Inspect task task-2");
    expect(props.onOpenTask).toHaveBeenCalledWith({ environmentId, projectId, taskId: "task-2" });
  });
  for (const replacement of [
    { ...binding, revision: 2 },
    { ...binding, generation: 2 },
    { ...binding, taskId: "task-2" },
    { ...binding, workerThreadId: ThreadId.make("worker-2") },
    { ...binding, attemptId: "attempt-2" },
    { ...binding, memberId: "member-2" },
    { ...binding, model: "replacement-model" },
    { ...binding, profile: { ...profile, revision: 2 } },
    { ...binding, profile: { ...profile, generation: 2 } },
    { ...binding, profile: { ...profile, roleRevision: 3 } },
    { ...binding, profile: { ...profile, model: "replacement-profile-model" } },
    { ...binding, roleRevisionId: "profile-2", profile: { ...profile, recordId: "profile-2" } },
  ])
    it(`refuses held assignment controls after replacing ${JSON.stringify(replacement)}`, async () => {
      await render();
      const task = held("Inspect task task-1"),
        worker = held("Inspect worker worker-1");
      await summary({ ...available, bindings: { items: [replacement], hasMore: false } });
      await act(async () => {
        task();
        worker();
      });
      expect(props.onOpenTask).not.toHaveBeenCalled();
      expect(props.onOpenWorker).not.toHaveBeenCalled();
      await click(`Inspect task ${replacement.taskId}`);
      expect(props.onOpenTask).toHaveBeenCalledWith({
        environmentId,
        projectId,
        taskId: replacement.taskId,
      });
    });
  it("revokes held controls after removal and after unmount", async () => {
    await render();
    const task = held("Inspect task task-1"),
      worker = held("Inspect worker worker-1"),
      inspect = held("Inspect project Project Alpha");
    await summary({ ...available, bindings: { items: [], hasMore: false } });
    await act(async () => {
      task();
      worker();
    });
    expect(props.onOpenTask).not.toHaveBeenCalled();
    expect(props.onOpenWorker).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    unmounted = true;
    await act(async () => inspect());
    expect(props.onInspectProject).not.toHaveBeenCalled();
  });
  for (const category of ["blockers", "questions"] as const)
    it(`fences ${category} replacement and removal`, async () => {
      await render();
      const task = held(
        category === "blockers" ? "Inspect task task-blocked" : "Inspect task task-question",
      );
      await summary({
        ...available,
        [category]: {
          items:
            category === "blockers"
              ? [{ ...blocker, revision: 3 }]
              : [{ ...question, generation: 2 }],
          hasMore: false,
        },
      });
      await act(async () => task());
      expect(props.onOpenTask).not.toHaveBeenCalled();
      await summary({ ...available, [category]: { items: [], hasMore: false } });
      await act(async () => task());
      expect(props.onOpenTask).not.toHaveBeenCalled();
    });
  for (const replacement of [
    { ...binding, status: "future-status" },
    { ...binding, supported: false },
    bindingWithoutProfile,
    { ...binding, profile: { ...profile, status: "future-profile" } },
    { ...binding, profile: { ...profile, role: "future-role" } },
    { ...binding, profile: { ...profile, supported: false } },
    { ...binding, profile: { ...profile, recordId: "other-profile" } },
    {
      ...binding,
      profile: {
        recordId: "profile-1",
        revision: 1,
        status: "broken-profile",
        supported: false,
        issue: "malformed" as const,
      },
    },
    {
      recordId: "binding-1",
      revision: 1,
      status: "broken-binding",
      supported: false as const,
      issue: "malformed" as const,
    },
  ])
    it(`keeps uncertain binding/profile visible without assignment navigation ${JSON.stringify(replacement)}`, async () => {
      await render();
      const worker = held("Inspect worker worker-1");
      await summary(decode({ ...available, bindings: { items: [replacement], hasMore: false } }));
      const card = [...host.querySelectorAll("section")].find(
        (item) => item.querySelector("h2")?.textContent === "Recorded bindings",
      );
      expect(card?.textContent).toContain("binding-1");
      expect(card?.querySelectorAll("button")).toHaveLength(0);
      await act(async () => worker());
      expect(props.onOpenWorker).not.toHaveBeenCalled();
    });
  it("shows future and malformed coordinator, mission and question markers", async () => {
    await summary(
      decode({
        ...available,
        coordinator: {
          recordId: "coordinator-broken",
          revision: 1,
          status: "future-coordinator",
          supported: false,
          issue: "malformed",
        },
        missions: {
          items: [
            {
              ...metadata,
              recordId: "mission-future",
              title: "Future mission",
              status: "future-mission",
            },
            {
              recordId: "mission-broken",
              revision: 1,
              status: "broken",
              supported: false,
              issue: "malformed",
            },
          ],
          hasMore: false,
        },
        questions: {
          items: [
            { ...question, status: "future-question" },
            {
              recordId: "question-broken",
              revision: 1,
              status: "broken",
              supported: false,
              issue: "malformed",
            },
          ],
          hasMore: false,
        },
      }),
    );
    for (const text of [
      "future-coordinator",
      "Malformed coordinator",
      "Future mission",
      "Unsupported mission",
      "Malformed mission",
      "future-question",
      "Unsupported question",
      "Malformed question",
    ])
      expect(host.textContent).toContain(text);
    expect(
      [...host.querySelectorAll("button")].some(
        (item) => item.textContent === "Inspect task task-question",
      ),
    ).toBe(false);
  });
  for (const category of ["missions", "bindings", "blockers", "questions"] as const)
    it(`rejects duplicate ${category} before any preview fields render`, async () => {
      const row = available[category].items[0]!;
      await render();
      const task = held("Inspect task task-1");
      await summary(decode({ ...available, [category]: { items: [row, row], hasMore: false } }));
      expect(host.textContent).toContain("Malformed or incoherent summary");
      expect(host.textContent).not.toContain("frozen-model");
      noAssignments();
      await act(async () => task());
      expect(props.onOpenTask).not.toHaveBeenCalled();
    });
  for (const category of ["missions", "bindings", "blockers", "questions"] as const)
    it(`rejects oversized raw ${category} without truncating into a misleading summary`, async () => {
      const row = available[category].items[0]!;
      const count = category === "bindings" ? 9 : 6;
      const raw = Object.assign({}, available, {
        [category]: {
          items: Array.from({ length: count }, (_, i) => ({ ...row, recordId: `overflow-${i}` })),
          hasMore: true,
        },
      });
      await summary(raw);
      expect(host.textContent).toContain("Malformed or incoherent summary");
      noAssignments();
    });
  it("renders exactly the fixed preview bounds and sends more inspection to the project", async () => {
    await summary(
      decode({
        ...available,
        missions: {
          items: Array.from({ length: 5 }, (_, i) => ({
            ...available.missions.items[0],
            recordId: `mission-${i}`,
          })),
          hasMore: true,
        },
        bindings: {
          items: Array.from({ length: 8 }, (_, i) => ({ ...binding, recordId: `binding-${i}` })),
          hasMore: true,
        },
        blockers: {
          items: Array.from({ length: 5 }, (_, i) => ({ ...blocker, recordId: `blocker-${i}` })),
          hasMore: true,
        },
        questions: {
          items: Array.from({ length: 5 }, (_, i) => ({ ...question, recordId: `question-${i}` })),
          hasMore: true,
        },
      }),
    );
    for (const category of ["missions", "bindings", "blockers", "questions"])
      await click(`Inspect more ${category} in Project Alpha`);
    expect(props.onInspectProject).toHaveBeenCalledTimes(4);
    for (const call of vi.mocked(props.onInspectProject).mock.calls)
      expect(call).toEqual([{ environmentId, projectId }]);
    expect(host.textContent).toContain("binding-7");
    expect(host.textContent).toContain("question-4");
  });
  for (const corrupt of [
    { taskCounts: { ...available.taskCounts, total: 54 } },
    { bindings: { items: [{ ...binding, revision: 11 }], hasMore: false } },
    {
      bindings: { items: [{ ...binding, profile: { ...profile, revision: 11 } }], hasMore: false },
    },
  ])
    it(`rejects incoherent raw summary ${JSON.stringify(corrupt)}`, async () => {
      await summary({ ...available, ...corrupt });
      expect(host.textContent).toContain("Malformed or incoherent");
      noAssignments();
    });
  it("strips private bodies, configuration, instructions and paths before rendering or fencing controls", async () => {
    await summary(
      Object.assign({}, available, {
        body: "PRIVATE-BODY",
        configuration: "PRIVATE-CONFIG",
        path: "PRIVATE-PATH",
        bindings: {
          items: [
            Object.assign({}, binding, {
              instructions: "PRIVATE-INSTRUCTIONS",
              configuration: "PRIVATE-CONFIG",
              worktree: "PRIVATE-WORKTREE",
              profile: Object.assign({}, profile, { instructions: "PRIVATE-PROFILE" }),
            }),
          ],
          hasMore: false,
        },
        questions: {
          items: [Object.assign({}, question, { body: "PRIVATE-QUESTION" })],
          hasMore: false,
        },
      }),
    );
    for (const text of [
      "PRIVATE-BODY",
      "PRIVATE-CONFIG",
      "PRIVATE-PATH",
      "PRIVATE-INSTRUCTIONS",
      "PRIVATE-WORKTREE",
      "PRIVATE-PROFILE",
      "PRIVATE-QUESTION",
    ])
      expect(host.textContent).not.toContain(text);
    await click("Inspect worker worker-1");
    expect(props.onOpenWorker).toHaveBeenCalledWith({ environmentId, projectId, threadId });
  });
});
