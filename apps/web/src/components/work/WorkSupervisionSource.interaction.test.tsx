/* @vitest-environment happy-dom */
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ProjectTeamSupervisionSummary,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { act, Profiler, StrictMode, version as reactVersion } from "react";
import { flushSync, version as reactDomVersion } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WorkSupervisionSource, type WorkSupervisionSourceProps } from "./WorkSupervisionSource";

const factory = vi.hoisted(() => vi.fn());
vi.mock("../../state/projectWork", () => ({ projectWorkEnvironment: { supervision: factory } }));
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
const receivedAt = now - 30_000;

type Result = AsyncResult.AsyncResult<unknown, unknown>;
type State = ReturnType<typeof Atom.make<Result>>;
describe("mounted web supervision query source", () => {
  let registry: AtomRegistry.AtomRegistry;
  let first: State;
  let second: State;
  let query: Atom.Atom<Result>;
  let reads: number;
  let root: Root;
  let host: HTMLDivElement;
  let unmounted: boolean;
  let props: WorkSupervisionSourceProps;
  let frames: string[];
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(Date, "now").mockReturnValue(now);
    registry = AtomRegistry.make();
    first = Atom.make<Result>(AsyncResult.success(available, { timestamp: receivedAt }));
    second = Atom.make<Result>(AsyncResult.initial());
    const unavailable = Atom.make<Result>(AsyncResult.initial());
    reads = 0;
    query = Atom.make((get) => {
      reads++;
      return get(first);
    });
    factory.mockReset();
    factory.mockImplementation(
      (target: {
        environmentId: string;
        projectId: string;
        enabled: boolean;
        capability: boolean;
        connectionPhase: string;
      }) =>
        target.enabled && target.capability && target.connectionPhase === "connected"
          ? target.environmentId === environmentId && target.projectId === projectId
            ? query
            : second
          : unavailable,
    );
    props = {
      environmentId,
      projectId,
      title: "Project Alpha",
      connected: true,
      enabled: true,
      supported: true,
      onOpenTask: vi.fn(),
      onOpenWorker: vi.fn(),
      onInspectProject: vi.fn(),
    };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    frames = [];
    unmounted = false;
  });
  afterEach(async () => {
    if (!unmounted) await act(async () => root.unmount());
    registry.dispose();
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  async function render(patch: Partial<WorkSupervisionSourceProps> = {}) {
    props = { ...props, ...patch };
    await act(async () =>
      root.render(
        <StrictMode>
          <RegistryContext.Provider value={registry}>
            <Profiler id="source" onRender={() => frames.push(host.textContent ?? "")}>
              <WorkSupervisionSource {...props} />
            </Profiler>
          </RegistryContext.Provider>
        </StrictMode>,
      ),
    );
  }
  async function update(result: Result) {
    await act(async () => registry.set(first, result));
  }
  function button(label: string) {
    const node = [...host.querySelectorAll("button")].find((item) => item.textContent === label);
    if (!node) throw new Error(`Missing button ${label}: ${host.textContent}`);
    return node;
  }
  async function click(label: string) {
    await act(async () => button(label).click());
  }
  function held(label: string) {
    const node = button(label);
    const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
    if (!key) throw new Error("Actual mounted React button props missing");
    const click = Reflect.get(Reflect.get(node, key), "onClick");
    if (typeof click !== "function") throw new Error("Actual mounted click missing");
    return () => click({});
  }
  function noAssignments() {
    expect(
      [...host.querySelectorAll("button")].filter((item) =>
        /Inspect task|Inspect worker/.test(item.textContent ?? ""),
      ),
    ).toHaveLength(0);
  }
  it("uses one default bounded query for the exact owner and real widget navigation", async () => {
    expect(reactVersion).toBe("19.2.6");
    expect(reactDomVersion).toBe("19.2.6");
    await render();
    expect(factory).toHaveBeenLastCalledWith({
      environmentId,
      projectId,
      enabled: true,
      capability: true,
      connectionPhase: "connected",
    });
    expect(reads).toBe(1);
    expect(host.textContent).toContain("Current recorded summary");
    expect(host.textContent).toContain("Received 30 seconds ago");
    await click("Inspect task task-1");
    await click("Inspect worker worker-1");
    await click("Inspect project Project Alpha");
    expect(props.onOpenTask).toHaveBeenCalledWith({ environmentId, projectId, taskId: "task-1" });
    expect(props.onOpenWorker).toHaveBeenCalledWith({ environmentId, projectId, threadId });
    expect(props.onInspectProject).toHaveBeenCalledWith({ environmentId, projectId });
  });
  for (const flag of ["connected", "enabled", "supported"] as const) {
    it(`does not acquire a live query with initial ${flag} false`, async () => {
      await render({ [flag]: false });
      expect(reads).toBe(0);
      noAssignments();
      expect(button("Refresh summary").disabled).toBe(true);
    });
    it(`preserves original owner cache and revokes held controls when ${flag} becomes false`, async () => {
      await render();
      const task = held("Inspect task task-1"),
        worker = held("Inspect worker worker-1"),
        refresh = held("Refresh summary");
      vi.mocked(Date.now).mockReturnValue(now + 90_000);
      await render({ [flag]: false });
      expect(host.textContent).toContain("Cached · Received 120 seconds ago");
      expect(host.textContent).toContain("frozen-model");
      noAssignments();
      const before = reads;
      await act(async () => {
        task();
        worker();
        refresh();
      });
      expect(props.onOpenTask).not.toHaveBeenCalled();
      expect(props.onOpenWorker).not.toHaveBeenCalled();
      expect(reads).toBe(before);
      await click("Inspect project Project Alpha");
      expect(props.onInspectProject).toHaveBeenCalledWith({ environmentId, projectId });
    });
  }
  it("preserves Success.timestamp through waiting results without granting navigation", async () => {
    await render();
    const task = held("Inspect task task-1");
    vi.mocked(Date.now).mockReturnValue(now + 60_000);
    await update(AsyncResult.success(available, { timestamp: receivedAt, waiting: true }));
    expect(host.textContent).toContain("Cached · Received 90 seconds ago");
    noAssignments();
    await act(async () => task());
    expect(props.onOpenTask).not.toHaveBeenCalled();
  });
  it("uses Failure.previousSuccess.timestamp and canned errors without private transport details", async () => {
    await render();
    const worker = held("Inspect worker worker-1");
    vi.mocked(Date.now).mockReturnValue(now + 60_000);
    await update(
      AsyncResult.failure(Cause.fail(new Error("PRIVATE-TOKEN-SECRET")), {
        previousSuccess: Option.some(
          AsyncResult.success(available, { timestamp: receivedAt - 20_000 }),
        ),
      }),
    );
    expect(host.textContent).toContain("Cached · Received 110 seconds ago");
    expect(host.textContent).toContain("Could not refresh supervision");
    expect(host.textContent).not.toContain("PRIVATE-TOKEN-SECRET");
    noAssignments();
    await act(async () => worker());
    expect(props.onOpenWorker).not.toHaveBeenCalled();
  });
  for (const result of [
    AsyncResult.initial<unknown>(),
    AsyncResult.failure(Cause.fail("PRIVATE-TOKEN-SECRET")),
  ])
    it(`retains local received metadata through ${result._tag} without rebasing`, async () => {
      await render();
      vi.mocked(Date.now).mockReturnValue(now + 60_000);
      await update(result);
      expect(host.textContent).toContain("Cached · Received 90 seconds ago");
      expect(host.textContent).toContain("frozen-model");
      noAssignments();
    });
  for (const [label, data] of [
    ["foreign owner", { ...available, projectId: otherProjectId }],
    ["unknown availability", { ...available, availability: "future" }],
    ["incoherent counts", { ...available, taskCounts: { ...available.taskCounts, total: 999 } }],
    [
      "duplicate binding",
      { ...available, bindings: { ...available.bindings, items: [binding, binding] } },
    ],
  ] as const)
    it(`rejects ${label} summary`, async () => {
      first = Atom.make<Result>(AsyncResult.success(data, { timestamp: receivedAt }));
      query = Atom.make((get) => get(first));
      await render();
      expect(host.textContent).toContain("Unsupported or incoherent supervision metadata");
      expect(host.textContent).not.toContain("frozen-model");
      expect(host.textContent).not.toContain("PRIVATE-UNKNOWN-PAYLOAD");
      noAssignments();
    });
  it("displays only shared-decoder public metadata from additive transport payloads", async () => {
    first = Atom.make<Result>(
      AsyncResult.success(
        { ...available, privatePayload: "PRIVATE-UNKNOWN-PAYLOAD" },
        { timestamp: receivedAt },
      ),
    );
    query = Atom.make((get) => get(first));
    await render();
    expect(host.textContent).toContain("frozen-model");
    expect(host.textContent).not.toContain("PRIVATE-UNKNOWN-PAYLOAD");
    await update(AsyncResult.initial());
    expect(host.textContent).not.toContain("PRIVATE-UNKNOWN-PAYLOAD");
  });
  it("keeps accepted local cache when a later result is rejected", async () => {
    await render();
    const task = held("Inspect task task-1");
    await update(
      AsyncResult.success({ ...available, projectId: otherProjectId }, { timestamp: now }),
    );
    expect(host.textContent).toContain("frozen-model");
    expect(host.textContent).toContain("Cached · Received 30 seconds ago");
    noAssignments();
    await act(async () => task());
    expect(props.onOpenTask).not.toHaveBeenCalled();
  });
  for (const availability of [
    "missing",
    "archived",
    "unsupported",
    "deleted",
    "tombstoned",
  ] as const)
    it(`renders ${availability} without current assignment navigation`, async () => {
      await render();
      await update(AsyncResult.success({ projectId, availability }, { timestamp: receivedAt }));
      expect(host.textContent).toContain(`Project ${availability}`);
      noAssignments();
    });
  for (const owner of [{ environmentId: otherEnvironmentId }, { projectId: otherProjectId }])
    it(`remounts cache on owner change and fences away/back handlers ${JSON.stringify(owner)}`, async () => {
      await render();
      const task = held("Inspect task task-1"),
        worker = held("Inspect worker worker-1"),
        project = held("Inspect project Project Alpha"),
        refresh = held("Refresh summary");
      frames.length = 0;
      await render(owner);
      for (const frame of frames) expect(frame).not.toContain("frozen-model");
      await act(async () => {
        task();
        worker();
        project();
        refresh();
      });
      expect(props.onInspectProject).not.toHaveBeenCalled();
      expect(props.onOpenTask).not.toHaveBeenCalled();
      await render({ environmentId, projectId });
      const before = reads;
      await act(async () => {
        task();
        worker();
        project();
        refresh();
      });
      expect(reads).toBe(before);
      expect(props.onOpenWorker).not.toHaveBeenCalled();
      expect(props.onInspectProject).not.toHaveBeenCalled();
      await click("Inspect task task-1");
      expect(props.onOpenTask).toHaveBeenCalledOnce();
    });
  it("fences registry changes before React commits the new observed result", async () => {
    await render();
    const task = held("Inspect task task-1"),
      worker = held("Inspect worker worker-1");
    await act(async () => {
      registry.set(
        first,
        AsyncResult.success({ ...available, revision: 11 }, { timestamp: receivedAt }),
      );
      task();
      worker();
    });
    expect(props.onOpenTask).not.toHaveBeenCalled();
    expect(props.onOpenWorker).not.toHaveBeenCalled();
  });
  it("rechecks pure widget record identity and summary revision on held controls", async () => {
    await render();
    const task = held("Inspect task task-1"),
      worker = held("Inspect worker worker-1");
    await update(
      AsyncResult.success(
        {
          ...available,
          revision: 11,
          bindings: { items: [{ ...binding, model: "new-model" }], hasMore: false },
        },
        { timestamp: receivedAt },
      ),
    );
    await act(async () => {
      task();
      worker();
    });
    expect(props.onOpenTask).not.toHaveBeenCalled();
    expect(props.onOpenWorker).not.toHaveBeenCalled();
  });
  it("refreshes the latest committed query after a same-owner factory replacement", async () => {
    await render();
    const refresh = held("Refresh summary");
    let replacementReads = 0;
    const next = Atom.make((get) => {
      replacementReads++;
      return get(first);
    });
    query = next;
    await render();
    const before = replacementReads;
    const oldReads = reads;
    await act(async () => refresh());
    expect(replacementReads).toBe(before + 1);
    expect(reads).toBe(oldReads);
  });
  it("uses latest committed owner callbacks", async () => {
    await render();
    const task = held("Inspect task task-1"),
      old = props.onOpenTask;
    await render({ onOpenTask: vi.fn() });
    await act(async () => task());
    expect(old).not.toHaveBeenCalled();
    expect(props.onOpenTask).toHaveBeenCalledWith({ environmentId, projectId, taskId: "task-1" });
  });
  for (const timestamp of [now + 1, NaN, Infinity, -1])
    it(`fails closed for invalid or future receive timestamp ${timestamp}`, async () => {
      first = Atom.make<Result>(AsyncResult.success(available, { timestamp }));
      query = Atom.make((get) => get(first));
      await render();
      expect(host.textContent).toContain("Receive age unavailable");
      noAssignments();
    });
  it("samples the clock on query changes with no repaint timer or receive-time rewrite", async () => {
    await render();
    vi.mocked(Date.now).mockReturnValue(now + 300_000);
    await render({ title: "Renamed" });
    expect(host.textContent).toContain("Received 30 seconds ago");
    await update(AsyncResult.success(available, { timestamp: receivedAt }));
    expect(host.textContent).toContain("Received 330 seconds ago");
  });
  it("revokes every held control and cancels queued query clock sampling after unmount", async () => {
    await render();
    const task = held("Inspect task task-1"),
      worker = held("Inspect worker worker-1"),
      project = held("Inspect project Project Alpha"),
      refresh = held("Refresh summary");
    await act(async () => {
      flushSync(() =>
        registry.set(first, AsyncResult.success(available, { timestamp: receivedAt })),
      );
      root.unmount();
    });
    unmounted = true;
    const before = reads;
    await act(async () => {
      task();
      worker();
      project();
      refresh();
    });
    expect(props.onOpenTask).not.toHaveBeenCalled();
    expect(props.onOpenWorker).not.toHaveBeenCalled();
    expect(props.onInspectProject).not.toHaveBeenCalled();
    expect(reads).toBe(before);
  });
});
