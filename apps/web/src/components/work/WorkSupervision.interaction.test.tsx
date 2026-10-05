/* @vitest-environment happy-dom */
import {
  EnvironmentId,
  ProjectId,
  ProjectTeamSupervisionSummary,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act, Profiler, StrictMode, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WorkSupervision, type WorkSupervisionProps } from "./WorkSupervision";

const controls = vi.hoisted(() => new Map<string, () => void>());
// Retain a mounted control's handler while still rendering the actual web Button.
vi.mock("../ui/button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui/button")>();
  const React = await import("react");
  return {
    ...actual,
    Button: ({
      onClick,
      children,
      ...rest
    }: Omit<ComponentProps<typeof actual.Button>, "onClick"> & {
      onClick?: () => void;
      children?: ReactNode;
    }) => {
      const label = React.Children.toArray(children).join("");
      React.useLayoutEffect(() => {
        controls.set(label, () => onClick?.());
      });
      return React.createElement(actual.Button, { ...rest, onClick }, children);
    },
  };
});
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
const blocker = {
  recordId: "blocker-1",
  revision: 2,
  taskId: "blocked-task",
  reason: "Waiting for a decision",
  resolver: "human",
};
const question = {
  ...metadata,
  recordId: "question-1",
  status: "pending",
  taskId: "question-task",
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
    items: [
      { ...metadata, recordId: "mission-z", status: "paused", title: "Zeta mission" },
      { ...metadata, recordId: "mission-a", status: "active", title: "Alpha mission" },
    ],
    hasMore: false,
  },
  bindings: { items: [binding], hasMore: false },
  blockers: { items: [blocker], hasMore: false },
  questions: { items: [question], hasMore: false },
});
if (decoded.availability !== "available") throw new Error("Available fixture required");
const available = decoded;
const now = 1_000_000;

describe("mounted web recorded supervision", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: WorkSupervisionProps;
  let unmounted: boolean;
  let frames: string[];
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    controls.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    unmounted = false;
    frames = [];
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
  async function render(patch: Partial<WorkSupervisionProps> = {}) {
    props = { ...props, ...patch };
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
  function button(label: string) {
    const value = [...host.querySelectorAll("button")].find((item) => item.textContent === label);
    if (!value) throw new Error(`Missing button ${label}: ${host.textContent}`);
    return value;
  }
  async function click(label: string) {
    await act(async () => button(label).click());
  }
  function held(label: string) {
    const value = controls.get(label);
    if (!value) throw new Error(`Missing mounted handler ${label}`);
    return value;
  }
  function noAssignments() {
    expect(
      [...host.querySelectorAll("button")].filter((item) =>
        /Inspect task|Inspect worker/.test(item.textContent ?? ""),
      ),
    ).toHaveLength(0);
  }

  it("presents recorded counts, revisions, deterministic previews and separate frozen/profile models", async () => {
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
      "Waiting for a decision",
      "Gate gate-1 · Target revision 4",
      "do not verify execution health",
    ])
      expect(host.textContent).toContain(text);
    for (const [state, count] of Object.entries(available.taskCounts)) {
      const term = [...host.querySelectorAll("dt")].find((item) => item.textContent === state);
      expect(term?.parentElement?.querySelector("dd")?.textContent).toBe(String(count));
    }
    expect(host.textContent?.indexOf("Zeta mission")).toBeLessThan(
      host.textContent?.indexOf("Alpha mission") ?? 0,
    );
    expect(host.querySelectorAll("h3")).toHaveLength(6);
  });
  it("inspects each assignment and worker with the exact environment/project owner", async () => {
    await render();
    await click("Inspect task task-1");
    await click("Inspect task blocked-task");
    await click("Inspect task question-task");
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
      taskId: "blocked-task",
    });
    expect(props.onOpenTask).toHaveBeenNthCalledWith(3, {
      environmentId,
      projectId,
      taskId: "question-task",
    });
    expect(props.onOpenWorker).toHaveBeenCalledWith({ environmentId, projectId, threadId });
    expect(props.onInspectProject).toHaveBeenCalledWith({ environmentId, projectId });
  });
  for (const flag of ["connected", "enabled", "supported", "current"] as const) {
    it(`preserves cache metadata and revokes held assignment inspection when ${flag} is false`, async () => {
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
  for (const error of ["", "Read failed", "x".repeat(241)])
    it(`renders bounded read errors ${error.length} without held assignment access`, async () => {
      await render();
      const task = held("Inspect task task-1");
      await render({ error });
      expect(host.textContent).toContain(
        `Read error: ${error.slice(0, 240) || "No details recorded"}`,
      );
      if (error.length > 240) expect(host.textContent).not.toContain(error);
      noAssignments();
      await act(async () => task());
      expect(props.onOpenTask).not.toHaveBeenCalled();
    });
  for (const receivedAt of [-1, NaN, Infinity, now + 1])
    it(`invalid receive time ${receivedAt} removes assignment links`, async () => {
      await render();
      const worker = held("Inspect worker worker-1");
      await render({ snapshot: { environmentId, data: available, receivedAt } });
      expect(host.textContent).toContain("Receive age unavailable");
      noAssignments();
      await act(async () => worker());
      expect(props.onOpenWorker).not.toHaveBeenCalled();
    });
  for (const value of [-1, NaN, Infinity])
    it(`invalid clock ${value} fails closed`, async () => {
      await render({ now: value });
      expect(host.textContent).toContain("Receive age unavailable");
      noAssignments();
    });
  it("updates receive age only from supplied parent time, accepting finite zero", async () => {
    await render({ now: 0, snapshot: { environmentId, data: available, receivedAt: 0 } });
    expect(host.textContent).toContain("Received 0 seconds ago");
    await render({ now: 123_000 });
    expect(host.textContent).toContain("Received 123 seconds ago");
    await click("Inspect worker worker-1");
    expect(props.onOpenWorker).toHaveBeenCalledOnce();
  });
  it("shows no received snapshot without inventing counts", async () => {
    Reflect.deleteProperty(props, "snapshot");
    await render();
    expect(host.textContent).toContain("No summary received");
    expect(host.querySelector("dl")).toBeNull();
    noAssignments();
  });
  for (const availability of [
    "missing",
    "deleted",
    "archived",
    "tombstoned",
    "unsupported",
  ] as const)
    it(`shows ${availability} without unavailable records`, async () => {
      await render();
      const task = held("Inspect task task-1");
      await summary({ projectId, availability });
      expect(host.textContent).toContain(`Project ${availability}`);
      expect(host.textContent).not.toContain("frozen-model");
      noAssignments();
      await act(async () => task());
      expect(props.onOpenTask).not.toHaveBeenCalled();
    });
  for (const owner of [{ environmentId: otherEnvironmentId }, { projectId: otherProjectId }])
    it(`never renders stale owner records on switch ${JSON.stringify(owner)}`, async () => {
      await render();
      const task = held("Inspect task task-1"),
        project = held("Inspect project Project Alpha");
      frames.length = 0;
      await render({ ...owner, title: "Project Beta" });
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frame).not.toContain("frozen-model");
        expect(frame).not.toContain("Coordinator Alpha");
        expect(frame).not.toContain("Project revision 10");
      }
      expect(host.textContent).toContain("Snapshot owner mismatch");
      await act(async () => {
        task();
        project();
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
  it("never revives held controls when an environment is switched away and back", async () => {
    await render();
    const task = held("Inspect task task-1"),
      worker = held("Inspect worker worker-1"),
      project = held("Inspect project Project Alpha");
    await render({ environmentId: otherEnvironmentId });
    await render({ environmentId });
    await act(async () => {
      task();
      worker();
      project();
    });
    expect(props.onOpenTask).not.toHaveBeenCalled();
    expect(props.onOpenWorker).not.toHaveBeenCalled();
    expect(props.onInspectProject).not.toHaveBeenCalled();
    await click("Inspect task task-1");
    expect(props.onOpenTask).toHaveBeenCalledOnce();
  });
  it("revokes all held inspection after unmount", async () => {
    await render();
    const task = held("Inspect task task-1"),
      worker = held("Inspect worker worker-1"),
      project = held("Inspect project Project Alpha");
    await act(async () => root.unmount());
    unmounted = true;
    await act(async () => {
      task();
      worker();
      project();
    });
    expect(props.onOpenTask).not.toHaveBeenCalled();
    expect(props.onOpenWorker).not.toHaveBeenCalled();
    expect(props.onInspectProject).not.toHaveBeenCalled();
  });
  it("uses current inspection callbacks at activation", async () => {
    await render();
    const task = held("Inspect task task-1"),
      old = props.onOpenTask;
    await render({ onOpenTask: vi.fn() });
    await act(async () => task());
    expect(old).not.toHaveBeenCalled();
    expect(props.onOpenTask).toHaveBeenCalledWith({ environmentId, projectId, taskId: "task-1" });
  });
  it("shows all bounded sentinel notices and opens explicit project inspection", async () => {
    await summary({
      ...available,
      missions: { ...available.missions, hasMore: true },
      bindings: { ...available.bindings, hasMore: true },
      blockers: { ...available.blockers, hasMore: true },
      questions: { ...available.questions, hasMore: true },
    });
    for (const category of ["missions", "bindings", "blockers", "questions"]) {
      expect(host.textContent).toContain(`More ${category} recorded`);
      await click(`Inspect more ${category} in Project Alpha`);
    }
    expect(props.onInspectProject).toHaveBeenCalledTimes(4);
    expect(props.onInspectProject).toHaveBeenLastCalledWith({ environmentId, projectId });
    expect(host.textContent).toContain("Record order does not indicate recency");
  });
  it("shows an empty available project without invented coordinator or activity", async () => {
    const empty = {
      ...available,
      taskCounts: {
        draft: 0,
        specified: 0,
        ready: 0,
        "in-progress": 0,
        blocked: 0,
        "in-review": 0,
        completed: 0,
        failed: 0,
        canceled: 0,
        unknown: 0,
        total: 0,
      },
      missions: { items: [], hasMore: false },
      bindings: { items: [], hasMore: false },
      blockers: { items: [], hasMore: false },
      questions: { items: [], hasMore: false },
    };
    Reflect.deleteProperty(empty, "coordinator");
    await summary(empty);
    expect(host.textContent).toContain("No coordinator recorded");
    expect(host.textContent).toContain("No bindings in this preview");
    expect(host.textContent).toContain("No unresolved questions in this preview");
    noAssignments();
  });
  it("retains ambiguous worker metadata and allows only unambiguous task inspection", async () => {
    await render();
    const worker = held("Inspect worker worker-1");
    await summary({
      ...available,
      bindings: {
        items: [binding, { ...binding, recordId: "binding-2", taskId: "task-2" }],
        hasMore: false,
      },
    });
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
  for (const [field, replacement] of [
    ["revision", 2],
    ["generation", 2],
    ["taskId", "task-2"],
    ["attemptId", "attempt-2"],
    ["memberId", "member-2"],
    ["model", "replacement-model"],
    ["workerThreadId", "worker-2"],
  ] as const)
    it(`rechecks held binding identity after ${field} replacement`, async () => {
      await render();
      const task = held("Inspect task task-1"),
        worker = held("Inspect worker worker-1");
      const changed = { ...binding };
      Reflect.set(changed, field, replacement);
      await summary({ ...available, bindings: { items: [changed], hasMore: false } });
      await act(async () => {
        task();
        worker();
      });
      expect(props.onOpenTask).not.toHaveBeenCalled();
      expect(props.onOpenWorker).not.toHaveBeenCalled();
    });
  it("revokes held links when the summary revision changes even if a record is unchanged", async () => {
    await render();
    const task = held("Inspect task task-1"),
      worker = held("Inspect worker worker-1");
    await summary({ ...available, revision: 11 });
    await act(async () => {
      task();
      worker();
    });
    expect(props.onOpenTask).not.toHaveBeenCalled();
    expect(props.onOpenWorker).not.toHaveBeenCalled();
    await click("Inspect worker worker-1");
    expect(props.onOpenWorker).toHaveBeenCalledOnce();
  });
  for (const field of ["revision", "generation", "roleRevision", "model"] as const)
    it(`rechecks frozen profile ${field} on held links`, async () => {
      await render();
      const task = held("Inspect task task-1"),
        worker = held("Inspect worker worker-1");
      const changed = { ...profile };
      Reflect.set(changed, field, field === "model" ? "replacement-profile-model" : 3);
      await summary({
        ...available,
        bindings: { items: [{ ...binding, profile: changed }], hasMore: false },
      });
      await act(async () => {
        task();
        worker();
      });
      expect(props.onOpenTask).not.toHaveBeenCalled();
      expect(props.onOpenWorker).not.toHaveBeenCalled();
    });
  for (const change of [
    { status: "future", supported: true },
    { supported: false },
    { profile: { ...profile, role: "future" } },
    { profile: { ...profile, status: "future" } },
    { profile: { ...profile, recordId: "other-profile" } },
    { profile: { ...profile, supported: false } },
  ])
    it(`preserves unsupported binding metadata without assignment navigation ${JSON.stringify(change)}`, async () => {
      await render();
      const task = held("Inspect task task-1");
      await summary({
        ...available,
        bindings: { items: [{ ...binding, ...change }], hasMore: false },
      });
      expect(host.textContent).toContain("Assignment navigation unavailable");
      expect(
        [...host.querySelectorAll("button")].some(
          (item) => item.textContent === "Inspect task task-1",
        ),
      ).toBe(false);
      await act(async () => task());
      expect(props.onOpenTask).not.toHaveBeenCalled();
    });
  it("requires a recorded exact profile before assignment navigation", async () => {
    const missing = { ...binding };
    Reflect.deleteProperty(missing, "profile");
    await summary({ ...available, bindings: { items: [missing], hasMore: false } });
    expect(host.textContent).toContain("Profile not recorded");
    expect(host.textContent).toContain("Assignment navigation unavailable");
  });
  it("accepts recorded retired profiles without relabeling them as current configuration", async () => {
    await summary({
      ...available,
      bindings: {
        items: [{ ...binding, profile: { ...profile, status: "retired" } }],
        hasMore: false,
      },
    });
    expect(host.textContent).toContain("Recorded retired");
    await click("Inspect task task-1");
    expect(props.onOpenTask).toHaveBeenCalledOnce();
  });
  it("keeps a supported binding task inspectable without a worker thread", async () => {
    const withoutWorker = { ...binding };
    Reflect.deleteProperty(withoutWorker, "workerThreadId");
    await summary({ ...available, bindings: { items: [withoutWorker], hasMore: false } });
    await click("Inspect task task-1");
    expect(props.onOpenTask).toHaveBeenCalledOnce();
    expect(
      [...host.querySelectorAll("button")].some((item) =>
        /Inspect worker/.test(item.textContent ?? ""),
      ),
    ).toBe(false);
  });
  for (const status of ["future", "pending"])
    it(`question recorded ${status} is inspectable only with known metadata`, async () => {
      await summary({
        ...available,
        questions: { items: [{ ...question, status }], hasMore: false },
      });
      if (status === "future") {
        expect(host.textContent).toContain("Unsupported question metadata");
        expect(
          [...host.querySelectorAll("button")].some(
            (item) => item.textContent === "Inspect task question-task",
          ),
        ).toBe(false);
      } else {
        await click("Inspect task question-task");
        expect(props.onOpenTask).toHaveBeenCalledWith({
          environmentId,
          projectId,
          taskId: "question-task",
        });
      }
    });
  it("shows malformed physical markers without fields or assignment links", async () => {
    const marker = {
      revision: 1,
      status: "unknown",
      supported: false as const,
      issue: "malformed" as const,
    };
    await summary({
      ...available,
      coordinator: { ...marker, recordId: "bad-coordinator" },
      missions: { items: [{ ...marker, recordId: "bad-mission" }], hasMore: false },
      bindings: { items: [{ ...marker, recordId: "bad-binding" }], hasMore: false },
      blockers: { items: [], hasMore: false },
      questions: { items: [{ ...marker, recordId: "bad-question" }], hasMore: false },
    });
    for (const kind of ["coordinator", "mission", "binding", "question"])
      expect(host.textContent).toContain(`Malformed ${kind} metadata`);
    expect(host.textContent).not.toContain("frozen-model");
    noAssignments();
  });
  for (const category of ["missions", "bindings", "blockers", "questions"] as const)
    it(`rejects duplicate and ahead-of-fence ${category} records`, async () => {
      for (const kind of ["duplicate", "future"] as const) {
        const invalid = structuredClone(available);
        const items = invalid[category].items;
        const item = items[0];
        if (!item) throw new Error("Fixture requires item");
        if (kind === "duplicate") Reflect.set(items, items.length, item);
        else Reflect.set(item, "revision", 11);
        await summary(invalid);
        expect(host.textContent).toContain("Malformed or incoherent");
        expect(host.textContent).not.toContain("frozen-model");
        noAssignments();
      }
    });
  for (const corruption of [
    "counts",
    "profile-revision",
    "coordinator-revision",
    "oversized-preview",
    "foreign-project",
    "foreign-environment",
  ] as const)
    it(`rejects ${corruption} input without rendering private or foreign records`, async () => {
      const invalid = structuredClone(available);
      if (corruption === "counts") Reflect.set(invalid.taskCounts, "total", 54);
      if (corruption === "profile-revision") {
        const row = invalid.bindings.items[0];
        if (row && "profile" in row && row.profile) Reflect.set(row.profile, "revision", 11);
      }
      if (corruption === "coordinator-revision" && invalid.coordinator)
        Reflect.set(invalid.coordinator, "revision", 11);
      if (corruption === "oversized-preview")
        Reflect.set(
          invalid.missions,
          "items",
          Array.from({ length: 6 }, (_, i) => ({
            ...available.missions.items[0],
            recordId: `mission-${i}`,
          })),
        );
      if (corruption === "foreign-project") Reflect.set(invalid, "projectId", otherProjectId);
      await render({
        snapshot: {
          environmentId: corruption === "foreign-environment" ? otherEnvironmentId : environmentId,
          data: invalid,
          receivedAt: now,
        },
      });
      expect(host.textContent).not.toContain("Coordinator Alpha");
      expect(host.textContent).not.toContain("frozen-model");
      expect(host.querySelector("dl")).toBeNull();
      noAssignments();
    });
  it("strips unknown private fields before rendering or constructing navigation identities", async () => {
    const raw = structuredClone(available);
    const row = raw.bindings.items[0];
    if (!row) throw new Error("Binding fixture required");
    for (const key of ["configuration", "objective", "payload_json", "body", "answer", "history"])
      Reflect.set(row, key, "PRIVATE-DATA");
    Reflect.set(raw.taskCounts, "private", "PRIVATE-DATA");
    await summary(raw);
    expect(host.textContent).not.toContain("PRIVATE-DATA");
    await click("Inspect worker worker-1");
    expect(props.onOpenWorker).toHaveBeenCalledWith({ environmentId, projectId, threadId });
  });

  for (const category of ["bindings", "blockers", "questions"] as const)
    it(`removal or replacement revokes held ${category} task inspection`, async () => {
      const label =
        category === "bindings"
          ? "Inspect task task-1"
          : category === "blockers"
            ? "Inspect task blocked-task"
            : "Inspect task question-task";
      for (const remove of [false, true]) {
        await summary(available);
        const task = held(label);
        const changed = structuredClone(available);
        const item = changed[category].items[0];
        if (!item) throw new Error("Fixture item required");
        if (remove) Reflect.set(changed[category], "items", []);
        else Reflect.set(item, "taskId", "replacement-task");
        await summary(changed);
        await act(async () => task());
        expect(props.onOpenTask).not.toHaveBeenCalled();
      }
    });
  it("does not grant binding inspection from a malformed frozen profile marker", async () => {
    await summary({
      ...available,
      bindings: {
        items: [
          {
            ...binding,
            profile: {
              recordId: "profile-1",
              revision: 1,
              status: "unknown",
              supported: false,
              issue: "malformed",
            },
          },
        ],
        hasMore: false,
      },
    });
    expect(host.textContent).toContain("Malformed profile metadata");
    expect(host.textContent).toContain("Assignment navigation unavailable");
    expect(
      [...host.querySelectorAll("button")].some(
        (item) => item.textContent === "Inspect task task-1",
      ),
    ).toBe(false);
  });
  it("labels future coordinator and mission states without inventing activity", async () => {
    const coordinator = available.coordinator;
    if (!coordinator || !("name" in coordinator)) throw new Error("Coordinator fixture required");
    await summary({
      ...available,
      coordinator: { ...coordinator, status: "future", supported: false },
      missions: {
        items: [
          {
            ...metadata,
            recordId: "mission-future",
            title: "Future mission",
            status: "future",
            supported: false,
          },
        ],
        hasMore: false,
      },
    });
    expect(host.textContent).toContain("Unsupported coordinator metadata");
    expect(host.textContent).toContain("Unsupported mission metadata");
    expect(host.textContent).toContain("Recorded future");
  });
});
