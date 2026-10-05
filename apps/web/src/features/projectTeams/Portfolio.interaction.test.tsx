/* @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProjectTeamSupervisionSummary,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vite-plus/test";

import { Portfolio, type PortfolioProps } from "./Portfolio";

const environmentId = EnvironmentId.make("environment-1");
const otherEnvironmentId = EnvironmentId.make("environment-2");
const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const threadId = ThreadId.make("worker-1");
const decodeSummary = Schema.decodeUnknownSync(ProjectTeamSupervisionSummary);
const now = 1_000_000;
const metadata = { revision: 1, generation: 1, supported: true };
const profile = {
  ...metadata,
  recordId: "profile-1",
  status: "available",
  roleId: "implementer",
  roleRevision: 2,
  role: "Implementer",
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
const summary = decodeSummary({
  projectId,
  availability: "available",
  revision: 10,
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
    profile: { ...profile, role: "Coordinator", model: "coordinator-model" },
  },
  missions: {
    items: [
      { ...metadata, recordId: "mission-z", status: "paused", title: "Zeta mission" },
      { ...metadata, recordId: "mission-a", status: "active", title: "Alpha mission" },
    ],
    hasMore: false,
  },
  bindings: { items: [binding], hasMore: false },
  blockers: {
    items: [
      {
        recordId: "blocker-1",
        taskId: "task-blocked",
        revision: 2,
        reason: "Waiting for a decision",
        resolver: "human",
      },
    ],
    hasMore: false,
  },
  questions: {
    items: [
      {
        ...metadata,
        recordId: "question-1",
        status: "pending",
        taskId: "task-question",
        senderId: "member-1",
        targetGateId: "gate-1",
        targetRevision: 4,
      },
    ],
    hasMore: false,
  },
});
if (summary.availability !== "available") throw new Error("Available fixture required");
const available = summary;
const entry = {
  environmentId,
  projectId,
  title: "Project Alpha",
  connected: true,
  enabled: true,
  supported: true,
  current: true,
  snapshot: { environmentId, data: available, receivedAt: now - 30_000 },
} satisfies PortfolioProps["entries"][number];

const { snapshot: _snapshot, ...entryWithoutSnapshot } = entry;

describe("Portfolio mounted read-only presentation", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: PortfolioProps;
  let frames: string[];
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    frames = [];
    props = {
      entries: [entry],
      now,
      loading: false,
      hasPrevious: false,
      hasNext: false,
      onPrevious: vi.fn(),
      onNext: vi.fn(),
      onRefresh: vi.fn(),
      onOpenProject: vi.fn(),
      onOpenTask: vi.fn(),
      onOpenWorker: vi.fn(),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  async function render(patch: Partial<PortfolioProps> = {}) {
    props = { ...props, ...patch };
    await act(async () =>
      root.render(
        <Profiler id="portfolio" onRender={() => frames.push(host.textContent ?? "")}>
          <Portfolio {...props} />
        </Profiler>,
      ),
    );
  }
  function button(label: string) {
    const result = Array.from(host.querySelectorAll("button")).find(
      (item) => item.textContent === label,
    );
    if (!result) throw new Error(`Missing control ${label}: ${host.textContent}`);
    return result;
  }
  async function click(label: string) {
    await act(async () => button(label).click());
  }
  const changeEntry = (patch: Partial<PortfolioProps["entries"][number]>) => [
    { ...entry, ...patch },
  ];

  it("shows recorded counts, deterministic missions, coordinator and separate frozen/profile models", async () => {
    await render();
    expect(host.textContent).toContain("Current recorded summary");
    for (const [status, count] of Object.entries(available.taskCounts))
      expect(host.textContent).toContain(`${status} ${count}`);
    expect(host.textContent).toContain("Coordinator Alpha");
    expect(host.textContent).toContain("Coordinator · coordinator-model");
    expect(host.textContent).toContain("Binding model: frozen-model");
    expect(host.textContent).toContain("Profile: Implementer · profile-model");
    expect(host.textContent).toContain("Waiting for a decision · Resolver human");
    expect(host.textContent).toContain("Gate gate-1 · Target revision 4");
    expect(host.textContent?.indexOf("Alpha mission")).toBeLessThan(
      host.textContent?.indexOf("Zeta mission") ?? 0,
    );
    expect(host.textContent).toContain("Recorded paused");
    await click("Inspect task task-1");
    await click("Inspect worker worker-1");
    await click("Inspect project Project Alpha");
    expect(props.onOpenTask).toHaveBeenCalledWith({ environmentId, projectId, taskId: "task-1" });
    expect(props.onOpenWorker).toHaveBeenCalledWith({ environmentId, projectId, threadId });
    expect(props.onOpenProject).toHaveBeenCalledWith({ environmentId, projectId });
  });

  it("displays only named recorded count buckets from metadata with extra fields", async () => {
    const data = {
      ...available,
      taskCounts: { ...available.taskCounts, extraBody: "Hidden body must not render" },
    };
    await render({ entries: changeEntry({ snapshot: { ...entry.snapshot, data } }) });
    expect(host.textContent).toContain("unknown 10");
    expect(host.textContent).not.toContain("Hidden body must not render");
    expect(host.textContent).not.toContain("extraBody");
  });

  it("replaces environment and project ownership without foreign records in any committed frame", async () => {
    await render();
    const held = button("Inspect worker worker-1");
    frames = [];
    await render({
      entries: [
        {
          ...entry,
          environmentId: otherEnvironmentId,
          projectId: otherProjectId,
          title: "Project Beta",
        },
      ],
    });
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame).not.toContain("Coordinator Alpha");
      expect(frame).not.toContain("frozen-model");
      expect(frame).not.toContain("unknown 10");
      expect(frame).toContain("Snapshot owner mismatch");
    }
    await act(async () => held.click());
    expect(props.onOpenWorker).not.toHaveBeenCalled();
    await click("Inspect project Project Beta");
    expect(props.onOpenProject).toHaveBeenCalledWith({
      environmentId: otherEnvironmentId,
      projectId: otherProjectId,
    });
    const { coordinator: _coordinator, ...withoutCoordinator } = available;
    const beta = {
      ...withoutCoordinator,
      projectId: otherProjectId,
      bindings: { items: [], hasMore: false },
      missions: { items: [], hasMore: false },
    };
    await render({
      entries: [
        {
          ...entry,
          environmentId: otherEnvironmentId,
          projectId: otherProjectId,
          title: "Project Beta",
          snapshot: { environmentId: otherEnvironmentId, receivedAt: now, data: beta },
        },
      ],
    });
    expect(host.textContent).toContain("Current recorded summary");
    expect(host.textContent).not.toContain("Coordinator Alpha");
  });

  it.each(["environment", "project"])(
    "rejects a foreign %s snapshot independently",
    async (owner) => {
      await render({
        entries: changeEntry({
          snapshot: {
            ...entry.snapshot,
            ...(owner === "environment"
              ? { environmentId: otherEnvironmentId }
              : { data: { ...available, projectId: otherProjectId } }),
          },
        }),
      });
      expect(host.textContent).toContain("Snapshot owner mismatch");
      expect(host.textContent).not.toContain("unknown 10");
      expect(host.textContent).not.toContain("frozen-model");
    },
  );

  it.each([
    { connected: false, label: "Disconnected" },
    { enabled: false, label: "Project Work is disabled" },
    { supported: false, label: "Supervision is unsupported" },
    { current: false, label: "Cached" },
    { error: "Read failed", label: "Read failed" },
    { error: "", label: "Read error" },
  ])(
    "revokes held controls on $label and permits explicit project inspection",
    async ({ label, ...patch }) => {
      await render();
      const heldTask = button("Inspect task task-1");
      const heldWorker = button("Inspect worker worker-1");
      await render({ entries: changeEntry(patch) });
      expect(host.textContent).toContain(label);
      expect(host.textContent).toContain("Cached · received 30s ago");
      await act(async () => {
        heldTask.click();
        heldWorker.click();
      });
      expect(props.onOpenTask).not.toHaveBeenCalled();
      expect(props.onOpenWorker).not.toHaveBeenCalled();
      await click("Inspect project Project Alpha");
      expect(props.onOpenProject).toHaveBeenCalledWith({ environmentId, projectId });
      await render();
      await render({ entries: [entry] });
      await click("Inspect worker worker-1");
      expect(props.onOpenWorker).toHaveBeenCalledOnce();
    },
  );

  it("uses supplied receive age and disables inspection during loading", async () => {
    await render({ entries: changeEntry({ connected: false }) });
    expect(host.textContent).toContain("received 30s ago");
    await render({ now: now + 90_000 });
    expect(host.textContent).toContain("received 2m ago");
    await render({ now, entries: [entry] });
    const held = button("Inspect task task-1");
    await render({ loading: true });
    expect(host.textContent).toContain("Loading summaries");
    await act(async () => held.click());
    expect(props.onOpenTask).not.toHaveBeenCalled();
    expect(button("Refresh portfolio").disabled).toBe(true);
  });

  it.each([NaN, Infinity, -1, now + 1])(
    "makes invalid or future receive time %s unavailable",
    async (receivedAt) => {
      await render({ entries: changeEntry({ snapshot: { ...entry.snapshot, receivedAt } }) });
      expect(host.textContent).toContain("Invalid or future receive time");
      expect(host.textContent).not.toContain("Current recorded summary");
      expect(host.textContent).not.toContain("NaN");
      expect(host.textContent).not.toContain("Infinity");
      expect(host.textContent).not.toContain("Inspect worker worker-1");
      await click("Inspect project Project Alpha");
      expect(props.onOpenProject).toHaveBeenCalledOnce();
    },
  );

  it.each([NaN, Infinity, -1])("makes invalid current clock %s unavailable", async (clock) => {
    await render({ now: clock });
    expect(host.textContent).toContain("Invalid or future receive time");
    expect(host.textContent).not.toContain("Current recorded summary");
  });

  it.each(["missing", "deleted", "archived", "tombstoned", "unsupported"] as const)(
    "removes stale summaries and links when project becomes %s",
    async (availability) => {
      await render();
      const held = button("Inspect worker worker-1");
      await render({
        entries: changeEntry({
          snapshot: { ...entry.snapshot, data: { projectId, availability } },
        }),
      });
      expect(host.textContent).toContain(`Project ${availability}`);
      expect(host.textContent).not.toContain("Coordinator Alpha");
      expect(host.textContent).not.toContain("unknown 10");
      await act(async () => held.click());
      expect(props.onOpenWorker).not.toHaveBeenCalled();
      await click("Inspect project Project Alpha");
      expect(props.onOpenProject).toHaveBeenCalledOnce();
    },
  );

  it("distinguishes no snapshot from loading and failed reads", async () => {
    await render({ entries: [entryWithoutSnapshot] });
    expect(host.textContent).toContain("No summary received");
    await render({ loading: true });
    expect(host.textContent).toContain("Loading summaries");
    await render({
      loading: false,
      entries: [{ ...entryWithoutSnapshot, error: "Connection read failed" }],
    });
    expect(host.textContent).toContain("Connection read failed");
  });

  it("bounds project rendering at25 and visibly directs overflow to another page", async () => {
    await render({
      entries: Array.from({ length: 27 }, (_, index) => ({
        ...entryWithoutSnapshot,
        projectId: ProjectId.make(`project-${index}`),
        title: `Project ${index}`,
      })),
    });
    expect(host.querySelectorAll("h3")).toHaveLength(25);
    expect(host.textContent).toContain("Showing 25 of 27 projects");
    expect(host.textContent).not.toContain("Project 25");
    expect(host.textContent).not.toContain("Project 26");
  });

  it("shows each bounded hasMore notice with an explicit project inspection control", async () => {
    await render({
      entries: changeEntry({
        snapshot: {
          ...entry.snapshot,
          data: {
            ...available,
            missions: { ...available.missions, hasMore: true },
            bindings: { ...available.bindings, hasMore: true },
            blockers: { ...available.blockers, hasMore: true },
            questions: { ...available.questions, hasMore: true },
          },
        },
      }),
    });
    for (const category of ["missions", "bindings", "blockers", "questions"]) {
      expect(host.textContent).toContain(`More ${category} recorded`);
      await click(`Inspect more ${category} in Project Alpha`);
    }
    expect(props.onOpenProject).toHaveBeenCalledTimes(4);
  });

  it.each(["missions", "bindings", "blockers", "questions"] as const)(
    "rejects oversized %s metadata instead of rendering unbounded previews",
    async (category) => {
      const data = {
        ...available,
        [category]: {
          items: Array.from({ length: 9 }, () => available[category].items[0]),
          hasMore: true,
        },
      };
      await render({ entries: changeEntry({ snapshot: { ...entry.snapshot, data } }) });
      expect(host.textContent).toContain("Malformed summary metadata");
      expect(host.textContent).not.toContain("frozen-model");
      expect(host.textContent).not.toContain("Inspect task task-1");
    },
  );

  it.each(["reserved", "running", "stopping", "quarantined"])(
    "shows recorded %s bindings without asserting liveness",
    async (status) => {
      await render({
        entries: changeEntry({
          snapshot: {
            ...entry.snapshot,
            data: { ...available, bindings: { items: [{ ...binding, status }], hasMore: false } },
          },
        }),
      });
      expect(host.textContent).toContain(`Recorded ${status}`);
      expect(host.textContent).toContain("Binding model: frozen-model");
      expect(host.textContent).not.toContain("eligible");
      expect(host.textContent).not.toContain("live worker");
    },
  );

  it.each([
    { ...binding, supported: false, status: "future-running" },
    { ...binding, supported: true, status: "future-running" },
    {
      recordId: "binding-1",
      revision: 1,
      status: "running",
      supported: false as const,
      issue: "malformed" as const,
    },
    { ...binding, profile: { ...profile, supported: false, status: "future-profile" } },
  ])(
    "keeps unsupported/malformed binding metadata inspectable without navigation",
    async (item) => {
      await render();
      const held = button("Inspect worker worker-1");
      await render({
        entries: changeEntry({
          snapshot: {
            ...entry.snapshot,
            data: { ...available, bindings: { items: [item], hasMore: false } },
          },
        }),
      });
      expect(host.textContent).toContain("binding-1");
      expect(host.textContent).toMatch(/Unsupported|Malformed/);
      expect(host.textContent).not.toContain("Inspect task task-1");
      expect(host.textContent).not.toContain("Inspect worker worker-1");
      await act(async () => held.click());
      expect(props.onOpenWorker).not.toHaveBeenCalled();
    },
  );

  it("suppresses malformed and future question links while preserving question identity", async () => {
    await render({
      entries: changeEntry({
        snapshot: {
          ...entry.snapshot,
          data: {
            ...available,
            questions: {
              items: [
                {
                  recordId: "question-malformed",
                  revision: 1,
                  status: "pending",
                  supported: false,
                  issue: "malformed",
                },
                {
                  ...metadata,
                  recordId: "question-future",
                  status: "future-pending",
                  supported: false,
                  taskId: "future-task",
                  senderId: "sender",
                  targetGateId: "gate",
                  targetRevision: 2,
                },
              ],
              hasMore: false,
            },
          },
        },
      }),
    });
    expect(host.textContent).toContain("question-malformed");
    expect(host.textContent).toContain("question-future");
    expect(host.textContent).not.toContain("Inspect task future-task");
  });

  it("routes blocker and question task inspection to the exact project", async () => {
    await render();
    await click("Inspect task task-blocked");
    await click("Inspect task task-question");
    expect(props.onOpenTask).toHaveBeenNthCalledWith(1, {
      environmentId,
      projectId,
      taskId: "task-blocked",
    });
    expect(props.onOpenTask).toHaveBeenNthCalledWith(2, {
      environmentId,
      projectId,
      taskId: "task-question",
    });
  });

  it("supports previous/next/refresh and revokes held paging controls while unavailable", async () => {
    await render({ hasPrevious: true, hasNext: true });
    await click("Previous portfolio page");
    await click("Next portfolio page");
    await click("Refresh portfolio");
    expect(props.onPrevious).toHaveBeenCalledOnce();
    expect(props.onNext).toHaveBeenCalledOnce();
    expect(props.onRefresh).toHaveBeenCalledOnce();
    const held = button("Next portfolio page");
    await render({ entries: changeEntry({ supported: false }), hasPrevious: false });
    await act(async () => held.click());
    expect(props.onNext).toHaveBeenCalledOnce();
    expect(button("Refresh portfolio").disabled).toBe(true);
    await render({ entries: [entry], hasPrevious: true });
    await click("Previous portfolio page");
    expect(props.onPrevious).toHaveBeenCalledTimes(2);
    await render({ hasNext: false });
    expect(button("Next portfolio page").disabled).toBe(true);
  });

  it("routes identical task/thread IDs independently across simultaneous environment/project cards", async () => {
    const beta = {
      ...entry,
      environmentId: otherEnvironmentId,
      projectId: otherProjectId,
      title: "Project Beta",
      snapshot: {
        environmentId: otherEnvironmentId,
        data: { ...available, projectId: otherProjectId },
        receivedAt: now,
      },
    };
    await render({ entries: [entry, beta] });
    const workers = Array.from(host.querySelectorAll("button")).filter(
      (control) => control.textContent === "Inspect worker worker-1",
    );
    const tasks = Array.from(host.querySelectorAll("button")).filter(
      (control) => control.textContent === "Inspect task task-1",
    );
    expect(workers).toHaveLength(2);
    await act(async () => {
      workers[0]?.click();
      workers[1]?.click();
      tasks[0]?.click();
      tasks[1]?.click();
    });
    expect(props.onOpenWorker).toHaveBeenNthCalledWith(1, { environmentId, projectId, threadId });
    expect(props.onOpenWorker).toHaveBeenNthCalledWith(2, {
      environmentId: otherEnvironmentId,
      projectId: otherProjectId,
      threadId,
    });
    expect(props.onOpenTask).toHaveBeenNthCalledWith(1, {
      environmentId,
      projectId,
      taskId: "task-1",
    });
    expect(props.onOpenTask).toHaveBeenNthCalledWith(2, {
      environmentId: otherEnvironmentId,
      projectId: otherProjectId,
      taskId: "task-1",
    });
  });

  it("revokes held binding controls when that binding is removed", async () => {
    await render();
    const heldTask = button("Inspect task task-1");
    const heldWorker = button("Inspect worker worker-1");
    await render({
      entries: changeEntry({
        snapshot: {
          ...entry.snapshot,
          data: { ...available, bindings: { items: [], hasMore: false } },
        },
      }),
    });
    await act(async () => {
      heldTask.click();
      heldWorker.click();
    });
    expect(props.onOpenTask).not.toHaveBeenCalled();
    expect(props.onOpenWorker).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("frozen-model");
  });

  it("refreshes an empty portfolio explicitly without automatic fanout", async () => {
    await render({ entries: [] });
    expect(host.textContent).toContain("No projects in this page");
    expect(props.onRefresh).not.toHaveBeenCalled();
    await click("Refresh portfolio");
    expect(props.onRefresh).toHaveBeenCalledOnce();
  });
});
