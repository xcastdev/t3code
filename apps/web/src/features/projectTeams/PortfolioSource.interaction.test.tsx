/* @vitest-environment happy-dom */
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { act, Profiler, StrictMode, version as reactVersion } from "react";
import { flushSync, version as reactDomVersion } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PortfolioSource, type PortfolioSourceProps } from "./PortfolioSource";

const factory = vi.hoisted(() => vi.fn());
vi.mock("../../state/projectWork", () => ({ projectWorkEnvironment: { supervision: factory } }));
const environmentId = EnvironmentId.make("environment-1");
const otherEnvironmentId = EnvironmentId.make("environment-2");
const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const threadId = ThreadId.make("worker-1");
const owner = { environmentId, projectId };
const project = { ...owner, title: "Alpha", connected: true, enabled: true, supported: true };
const beta = {
  ...project,
  environmentId: otherEnvironmentId,
  projectId: otherProjectId,
  title: "Beta",
};
const now = 1_000_000;
const receivedAt = now - 30_000;
const binding = {
  recordId: "binding-1",
  revision: 1,
  generation: 1,
  supported: true,
  status: "running",
  taskId: "task-1",
  attemptId: "attempt-1",
  memberId: "member-1",
  roleRevisionId: "role-1",
  providerInstanceId: "pi-local",
  model: "frozen-model",
  workerThreadId: threadId,
};
const summary = {
  projectId,
  availability: "available",
  revision: 10,
  lifecycleRevision: 2,
  taskCounts: {
    draft: 1,
    specified: 0,
    ready: 0,
    "in-progress": 1,
    blocked: 0,
    "in-review": 0,
    completed: 0,
    failed: 0,
    canceled: 0,
    unknown: 0,
    total: 2,
  },
  missions: { items: [], hasMore: false },
  bindings: { items: [binding], hasMore: false },
  blockers: { items: [], hasMore: false },
  questions: { items: [], hasMore: false },
};
type Result = AsyncResult.AsyncResult<unknown, unknown>;
type State = ReturnType<typeof Atom.make<Result>>;
const ownerKey = (target: typeof owner) => JSON.stringify([target.environmentId, target.projectId]);

describe("mounted Portfolio page query source", () => {
  let registry: AtomRegistry.AtomRegistry;
  let states: Map<string, State>;
  let queries: Map<string, Atom.Atom<Result>>;
  let reads: Map<string, number>;
  let root: Root;
  let host: HTMLDivElement;
  let unmounted: boolean;
  let frames: string[];
  let props: PortfolioSourceProps;
  function add(target: typeof owner, result: Result = AsyncResult.initial()) {
    const key = ownerKey(target);
    const state = Atom.make<Result>(result);
    states.set(key, state);
    queries.set(
      key,
      Atom.make((get) => {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return get(state);
      }),
    );
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(Date, "now").mockReturnValue(now);
    registry = AtomRegistry.make();
    states = new Map();
    queries = new Map();
    reads = new Map();
    add(owner, AsyncResult.success(summary, { timestamp: receivedAt }));
    add(beta);
    const unavailable = Atom.make<Result>(AsyncResult.initial());
    factory.mockReset();
    factory.mockImplementation(
      (
        target: typeof owner & { enabled: boolean; capability: boolean; connectionPhase: string },
      ) => {
        if (!target.enabled || !target.capability || target.connectionPhase !== "connected")
          return unavailable;
        const atom = queries.get(ownerKey(target));
        if (!atom) throw new Error("Unprepared owner query");
        return atom;
      },
    );
    props = {
      projects: [project],
      hasPrevious: true,
      hasNext: true,
      onPrevious: vi.fn(),
      onNext: vi.fn(),
      onRefresh: vi.fn(),
      onOpenProject: vi.fn(),
      onOpenTask: vi.fn(),
      onOpenWorker: vi.fn(),
    };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    unmounted = false;
    frames = [];
  });
  afterEach(async () => {
    if (!unmounted) await act(async () => root.unmount());
    registry.dispose();
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  async function render(patch: Partial<PortfolioSourceProps> = {}) {
    props = { ...props, ...patch };
    await act(async () =>
      root.render(
        <StrictMode>
          <RegistryContext.Provider value={registry}>
            <Profiler id="portfolio-source" onRender={() => frames.push(host.textContent ?? "")}>
              <PortfolioSource {...props} />
            </Profiler>
          </RegistryContext.Provider>
        </StrictMode>,
      ),
    );
  }
  async function update(result: Result, target = owner) {
    const state = states.get(ownerKey(target));
    if (!state) throw new Error("Unprepared owner state");
    await act(async () => registry.set(state, result));
  }
  function button(label: string) {
    const node = [...host.querySelectorAll("button")].find((item) => item.textContent === label);
    if (!node) throw new Error(`Missing control ${label}: ${host.textContent}`);
    return node;
  }
  async function click(label: string) {
    await act(async () => button(label).click());
  }
  function held(label: string) {
    const node = button(label);
    const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
    if (!key) throw new Error("Actual mounted React button props missing");
    const callback = Reflect.get(Reflect.get(node, key), "onClick");
    if (typeof callback !== "function") throw new Error("Actual mounted click missing");
    return () => callback({});
  }
  function noAssignments() {
    expect(
      [...host.querySelectorAll("button")].filter((item) =>
        /Inspect task|Inspect worker/.test(item.textContent ?? ""),
      ),
    ).toHaveLength(0);
  }
  it("uses actual React/DOM identity and exact bounded query owners for recorded navigation", async () => {
    expect(reactVersion).toBe("19.2.6");
    expect(reactDomVersion).toBe("19.2.6");
    await render();
    expect(factory).toHaveBeenLastCalledWith({
      ...owner,
      enabled: true,
      capability: true,
      connectionPhase: "connected",
    });
    expect(reads.get(ownerKey(owner))).toBe(1);
    expect(host.textContent).toContain("Current recorded summary");
    await click("Inspect task task-1");
    await click("Inspect worker worker-1");
    await click("Inspect project Alpha");
    expect(props.onOpenTask).toHaveBeenCalledWith({ ...owner, taskId: "task-1" });
    expect(props.onOpenWorker).toHaveBeenCalledWith({ ...owner, threadId });
    expect(props.onOpenProject).toHaveBeenCalledWith(owner);
  });
  it("refreshes current page queries and parent pagination with no automatic fanout", async () => {
    add(
      beta,
      AsyncResult.success({ ...summary, projectId: otherProjectId }, { timestamp: receivedAt }),
    );
    await render({ projects: [project, beta] });
    expect(props.onRefresh).not.toHaveBeenCalled();
    await click("Refresh portfolio");
    expect(reads.get(ownerKey(owner))).toBe(2);
    expect(reads.get(ownerKey(beta))).toBe(2);
    expect(props.onRefresh).toHaveBeenCalledOnce();
    await click("Previous portfolio page");
    await click("Next portfolio page");
    expect(props.onPrevious).toHaveBeenCalledOnce();
    expect(props.onNext).toHaveBeenCalledOnce();
  });
  it("routes identical task and worker IDs through each current owner query", async () => {
    add(
      beta,
      AsyncResult.success({ ...summary, projectId: otherProjectId }, { timestamp: receivedAt }),
    );
    await render({ projects: [project, beta] });
    const tasks = [...host.querySelectorAll("button")].filter(
      (control) => control.textContent === "Inspect task task-1",
    );
    const workers = [...host.querySelectorAll("button")].filter(
      (control) => control.textContent === "Inspect worker worker-1",
    );
    expect(tasks).toHaveLength(2);
    expect(workers).toHaveLength(2);
    await act(async () => {
      tasks[0]?.click();
      tasks[1]?.click();
      workers[0]?.click();
      workers[1]?.click();
    });
    expect(props.onOpenTask).toHaveBeenNthCalledWith(1, { ...owner, taskId: "task-1" });
    expect(props.onOpenTask).toHaveBeenNthCalledWith(2, {
      environmentId: otherEnvironmentId,
      projectId: otherProjectId,
      taskId: "task-1",
    });
    expect(props.onOpenWorker).toHaveBeenNthCalledWith(1, { ...owner, threadId });
    expect(props.onOpenWorker).toHaveBeenNthCalledWith(2, {
      environmentId: otherEnvironmentId,
      projectId: otherProjectId,
      threadId,
    });
  });
  it("refreshes only eligible committed owners when a held page control survives availability changes", async () => {
    add(
      beta,
      AsyncResult.success({ ...summary, projectId: otherProjectId }, { timestamp: receivedAt }),
    );
    await render({ projects: [project, beta] });
    const refresh = held("Refresh portfolio");
    await render({ projects: [{ ...project, connected: false }, beta] });
    await act(async () => refresh());
    expect(reads.get(ownerKey(owner))).toBe(1);
    expect(reads.get(ownerKey(beta))).toBe(2);
    expect(props.onRefresh).toHaveBeenCalledOnce();
  });
  for (const flag of ["connected", "enabled", "supported"] as const) {
    it(`does not poll initially ${flag} unavailable owners`, async () => {
      await render({ projects: [{ ...project, [flag]: false }] });
      expect(reads.size).toBe(0);
      noAssignments();
      expect(button("Refresh portfolio").disabled).toBe(true);
    });
    it(`keeps original decoded receive time and revokes controls across ${flag} changes`, async () => {
      await render();
      const task = held("Inspect task task-1"),
        worker = held("Inspect worker worker-1"),
        refresh = held("Refresh portfolio");
      vi.mocked(Date.now).mockReturnValue(now + 90_000);
      await render({ projects: [{ ...project, [flag]: false }] });
      expect(host.textContent).toContain("Cached · received 2m ago");
      expect(host.textContent).toContain("frozen-model");
      noAssignments();
      const before = reads.get(ownerKey(owner));
      await act(async () => {
        task();
        worker();
        refresh();
      });
      expect(props.onOpenTask).not.toHaveBeenCalled();
      expect(props.onOpenWorker).not.toHaveBeenCalled();
      expect(reads.get(ownerKey(owner))).toBe(before);
      await click("Inspect project Alpha");
      expect(props.onOpenProject).toHaveBeenCalledWith(owner);
      await render({ projects: [project] });
      await click("Inspect worker worker-1");
      expect(props.onOpenWorker).toHaveBeenCalledOnce();
    });
  }
  it("shows initial loading and keeps successfully received metadata during a waiting refresh", async () => {
    add(owner);
    await render();
    expect(host.textContent).toContain("Loading summaries");
    expect(host.textContent).toContain("No summary received");
    await update(AsyncResult.success(summary, { timestamp: receivedAt }));
    const task = held("Inspect task task-1");
    vi.mocked(Date.now).mockReturnValue(now + 60_000);
    await update(AsyncResult.success(summary, { timestamp: receivedAt, waiting: true }));
    expect(host.textContent).toContain("Cached · received 1m ago");
    noAssignments();
    await act(async () => task());
    expect(props.onOpenTask).not.toHaveBeenCalled();
  });
  it("retains Failure.previousSuccess timestamp and never exposes transport errors", async () => {
    await render();
    vi.mocked(Date.now).mockReturnValue(now + 60_000);
    await update(
      AsyncResult.failure(Cause.fail("PRIVATE-CREDENTIAL"), {
        previousSuccess: Option.some(
          AsyncResult.success(summary, { timestamp: receivedAt - 20_000 }),
        ),
      }),
    );
    expect(host.textContent).toContain("Cached · received 1m ago");
    expect(host.textContent).toContain("Could not refresh supervision");
    expect(host.textContent).not.toContain("PRIVATE-CREDENTIAL");
    noAssignments();
  });
  for (const result of [
    AsyncResult.initial<unknown>(),
    AsyncResult.failure(Cause.fail("PRIVATE-CREDENTIAL")),
  ]) {
    it(`retains accepted local metadata through ${result._tag}`, async () => {
      await render();
      vi.mocked(Date.now).mockReturnValue(now + 60_000);
      await update(result);
      expect(host.textContent).toContain("Cached · received 1m ago");
      expect(host.textContent).toContain("frozen-model");
      noAssignments();
    });
  }
  for (const availability of [
    "missing",
    "deleted",
    "archived",
    "tombstoned",
    "unsupported",
  ] as const) {
    it(`replaces previous records with ${availability} metadata`, async () => {
      await render();
      const worker = held("Inspect worker worker-1");
      await update(AsyncResult.success({ projectId, availability }, { timestamp: receivedAt }));
      expect(host.textContent).toContain(`Project ${availability}`);
      expect(host.textContent).not.toContain("frozen-model");
      noAssignments();
      await act(async () => worker());
      expect(props.onOpenWorker).not.toHaveBeenCalled();
    });
  }
  for (const [label, data] of [
    ["foreign project", { ...summary, projectId: otherProjectId }],
    ["incoherent counts", { ...summary, taskCounts: { ...summary.taskCounts, total: 99 } }],
    ["duplicate binding", { ...summary, bindings: { items: [binding, binding], hasMore: false } }],
    [
      "oversized records",
      {
        ...summary,
        bindings: {
          items: Array.from({ length: 9 }, (_, i) => ({ ...binding, recordId: `binding-${i}` })),
          hasMore: true,
        },
      },
    ],
  ] as const) {
    it(`rejects ${label} metadata at the actual shared decoder`, async () => {
      add(owner, AsyncResult.success(data, { timestamp: receivedAt }));
      await render();
      expect(host.textContent).toContain("Unsupported or incoherent supervision metadata");
      expect(host.textContent).not.toContain("frozen-model");
      noAssignments();
    });
  }
  it("caches only bounded public decoded metadata after additive raw payloads", async () => {
    add(
      owner,
      AsyncResult.success(
        { ...summary, privatePayload: "PRIVATE-RAW-PAYLOAD" },
        { timestamp: receivedAt },
      ),
    );
    await render();
    expect(host.textContent).toContain("frozen-model");
    expect(host.textContent).not.toContain("PRIVATE-RAW-PAYLOAD");
    await update(AsyncResult.initial());
    expect(host.textContent).toContain("frozen-model");
    expect(host.textContent).not.toContain("PRIVATE-RAW-PAYLOAD");
  });
  it("retains only the prior accepted metadata after a malformed refresh", async () => {
    await render();
    const worker = held("Inspect worker worker-1");
    await update(
      AsyncResult.success({ ...summary, projectId: otherProjectId }, { timestamp: now }),
    );
    expect(host.textContent).toContain("Cached · received 30s ago");
    expect(host.textContent).toContain("frozen-model");
    noAssignments();
    await act(async () => worker());
    expect(props.onOpenWorker).not.toHaveBeenCalled();
  });
  for (const replacement of [
    { ...project, environmentId: otherEnvironmentId },
    { ...project, projectId: otherProjectId },
    beta,
  ]) {
    it(`discards foreign page cache and held callbacks for ${ownerKey(replacement)}`, async () => {
      add(replacement);
      await render();
      const task = held("Inspect task task-1"),
        worker = held("Inspect worker worker-1"),
        inspect = held("Inspect project Alpha"),
        refresh = held("Refresh portfolio"),
        next = held("Next portfolio page");
      frames.length = 0;
      await render({ projects: [replacement] });
      for (const frame of frames) expect(frame).not.toContain("frozen-model");
      await render({ projects: [project] });
      const before = reads.get(ownerKey(owner));
      await act(async () => {
        task();
        worker();
        inspect();
        refresh();
        next();
      });
      expect(props.onOpenTask).not.toHaveBeenCalled();
      expect(props.onOpenWorker).not.toHaveBeenCalled();
      expect(props.onOpenProject).not.toHaveBeenCalled();
      expect(props.onRefresh).not.toHaveBeenCalled();
      expect(props.onNext).not.toHaveBeenCalled();
      expect(reads.get(ownerKey(owner))).toBe(before);
      await click("Inspect task task-1");
      expect(props.onOpenTask).toHaveBeenCalledOnce();
    });
  }
  it("bounds unique page owners at25 with no duplicate query or display", async () => {
    const projects = Array.from({ length: 27 }, (_, i) => ({
      ...project,
      projectId: ProjectId.make(`project-page-${i}`),
      title: `Page project ${i}`,
    }));
    for (const target of projects)
      add(
        target,
        AsyncResult.success({ ...summary, projectId: target.projectId }, { timestamp: receivedAt }),
      );
    await render({ projects: [projects[0]!, projects[0]!, ...projects.slice(1)] });
    expect(host.querySelectorAll("h3")).toHaveLength(25);
    expect(reads.size).toBe(25);
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(host.textContent).not.toContain("Page project 25");
    await click("Refresh portfolio");
    expect([...reads.values()].every((count) => count === 2)).toBe(true);
  });
  for (const [name, result] of [
    ["Initial", AsyncResult.initial()],
    ["waiting Success", AsyncResult.success(summary, { timestamp: receivedAt, waiting: true })],
    [
      "waiting Failure",
      AsyncResult.failure(Cause.fail("unavailable"), {
        waiting: true,
        previousSuccess: Option.some(AsyncResult.success(summary, { timestamp: receivedAt })),
      }),
    ],
  ] as const) {
    it(`fences held top controls during a precommit ${name} registry update`, async () => {
      await render();
      const refresh = held("Refresh portfolio"),
        previous = held("Previous portfolio page"),
        next = held("Next portfolio page");
      const refreshQuery = vi.spyOn(registry, "refresh");
      await act(async () => {
        registry.set(states.get(ownerKey(owner))!, result);
        refresh();
        previous();
        next();
      });
      expect({
        queryRefresh: refreshQuery.mock.calls.length,
        parentRefresh: vi.mocked(props.onRefresh).mock.calls.length,
        previous: vi.mocked(props.onPrevious).mock.calls.length,
        next: vi.mocked(props.onNext).mock.calls.length,
      }).toEqual({ queryRefresh: 0, parentRefresh: 0, previous: 0, next: 0 });
    });
  }
  it("allows held top controls after a committed nonwaiting read failure", async () => {
    await render();
    const refresh = held("Refresh portfolio"),
      previous = held("Previous portfolio page"),
      next = held("Next portfolio page");
    await update(AsyncResult.failure(Cause.fail("unavailable")));
    const refreshQuery = vi.spyOn(registry, "refresh");
    await act(async () => {
      refresh();
      previous();
      next();
    });
    expect(refreshQuery).toHaveBeenCalledExactlyOnceWith(queries.get(ownerKey(owner)));
    expect(props.onRefresh).toHaveBeenCalledOnce();
    expect(props.onPrevious).toHaveBeenCalledOnce();
    expect(props.onNext).toHaveBeenCalledOnce();
  });
  it("fences actual registry changes before a newer React commit", async () => {
    await render();
    const task = held("Inspect task task-1"),
      worker = held("Inspect worker worker-1");
    const state = states.get(ownerKey(owner))!;
    await act(async () => {
      registry.set(
        state,
        AsyncResult.success({ ...summary, revision: 11 }, { timestamp: receivedAt }),
      );
      task();
      worker();
    });
    expect(props.onOpenTask).not.toHaveBeenCalled();
    expect(props.onOpenWorker).not.toHaveBeenCalled();
  });
  it("revokes held record controls when same IDs acquire different recorded metadata", async () => {
    await render();
    const task = held("Inspect task task-1"),
      worker = held("Inspect worker worker-1");
    await update(
      AsyncResult.success(
        {
          ...summary,
          revision: 11,
          bindings: { items: [{ ...binding, model: "replacement-model" }], hasMore: false },
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
    await click("Inspect worker worker-1");
    expect(props.onOpenWorker).toHaveBeenCalledWith({ ...owner, threadId });
  });
  it("preserves focused controls and mounted entries when only polling receive time changes", async () => {
    await render();
    const worker = button("Inspect worker worker-1");
    worker.focus();
    await update(AsyncResult.success(summary, { timestamp: receivedAt + 10_000 }));
    expect(button("Inspect worker worker-1")).toBe(worker);
    expect(document.activeElement).toBe(worker);
    await act(async () => worker.click());
    expect(props.onOpenWorker).toHaveBeenCalledWith({ ...owner, threadId });
  });
  it("rechecks latest page availability and reverse controls after old public metadata retires", async () => {
    await render();
    const refresh = held("Refresh portfolio"),
      previous = held("Previous portfolio page"),
      next = held("Next portfolio page");
    await update(
      AsyncResult.success(
        {
          ...summary,
          revision: 11,
          bindings: { items: [{ ...binding, model: "replacement-model" }], hasMore: false },
        },
        { timestamp: receivedAt },
      ),
    );
    await render({
      projects: [{ ...project, connected: false }],
      hasPrevious: false,
      hasNext: false,
    });
    const before = reads.get(ownerKey(owner));
    await act(async () => {
      refresh();
      previous();
      next();
    });
    expect(props.onRefresh).not.toHaveBeenCalled();
    expect(props.onPrevious).not.toHaveBeenCalled();
    expect(props.onNext).not.toHaveBeenCalled();
    expect(reads.get(ownerKey(owner))).toBe(before);
  });
  it("refreshes the latest same-owner query and eligible flags from held controls", async () => {
    await render();
    const refresh = held("Refresh portfolio");
    const originalReads = reads.get(ownerKey(owner));
    let replacements = 0;
    const replacement = Atom.make(() => {
      replacements++;
      return AsyncResult.success(summary, { timestamp: receivedAt });
    });
    queries.set(ownerKey(owner), replacement);
    await render();
    const before = replacements;
    await act(async () => refresh());
    expect(replacements).toBe(before + 1);
    expect(reads.get(ownerKey(owner))).toBe(originalReads);
    expect(props.onRefresh).toHaveBeenCalledOnce();
  });
  it("uses latest owner callbacks without clock repaint on unrelated parent renders", async () => {
    await render();
    const task = held("Inspect task task-1"),
      old = props.onOpenTask;
    vi.mocked(Date.now).mockReturnValue(now + 300_000);
    await render({ onOpenTask: vi.fn(), projects: [{ ...project, title: "Renamed" }] });
    await act(async () => task());
    expect(old).not.toHaveBeenCalled();
    expect(props.onOpenTask).toHaveBeenCalledWith({ ...owner, taskId: "task-1" });
    expect(reads.get(ownerKey(owner))).toBe(1);
    await update(AsyncResult.success(summary, { timestamp: receivedAt }));
    await update(AsyncResult.failure(Cause.fail("failure")));
    expect(host.textContent).toContain("Cached · received 5m ago");
  });
  for (const timestamp of [NaN, Infinity, -1, now + 1]) {
    it(`stably fails closed for receive timestamp ${timestamp}`, async () => {
      add(owner, AsyncResult.success(summary, { timestamp }));
      await render();
      expect(frames.length).toBeLessThan(10);
      expect(host.textContent).toContain("Invalid or future receive time");
      noAssignments();
      expect(host.textContent).not.toContain("NaN");
      expect(host.textContent).not.toContain("Infinity");
    });
  }
  it("supports parent refresh and pagination for an empty page", async () => {
    await render({ projects: [] });
    expect(host.textContent).toContain("No projects in this page");
    expect(reads.size).toBe(0);
    await click("Refresh portfolio");
    await click("Previous portfolio page");
    expect(props.onRefresh).toHaveBeenCalledOnce();
    expect(props.onPrevious).toHaveBeenCalledOnce();
  });
  it("revokes all held controls after unmount and cancels clock sampling", async () => {
    await render();
    const task = held("Inspect task task-1"),
      worker = held("Inspect worker worker-1"),
      inspect = held("Inspect project Alpha"),
      refresh = held("Refresh portfolio"),
      previous = held("Previous portfolio page");
    await act(async () => {
      flushSync(() =>
        registry.set(
          states.get(ownerKey(owner))!,
          AsyncResult.success(summary, { timestamp: receivedAt }),
        ),
      );
      root.unmount();
    });
    unmounted = true;
    const before = reads.get(ownerKey(owner));
    await act(async () => {
      task();
      worker();
      inspect();
      refresh();
      previous();
    });
    expect(props.onOpenTask).not.toHaveBeenCalled();
    expect(props.onOpenWorker).not.toHaveBeenCalled();
    expect(props.onOpenProject).not.toHaveBeenCalled();
    expect(props.onRefresh).not.toHaveBeenCalled();
    expect(props.onPrevious).not.toHaveBeenCalled();
    expect(reads.get(ownerKey(owner))).toBe(before);
  });
});
