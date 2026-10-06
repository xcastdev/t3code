/* @vitest-environment happy-dom */

import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  configAtom: Symbol("config"),
  config: { settings: { projectWorkEnabled: true } } as {
    settings: { projectWorkEnabled: boolean };
    environment?: { capabilities: { projectWorkStream: boolean } };
  },
  pages: new Map<string, unknown>(),
  streams: new Map<string, unknown>(),
  environment: {
    page: vi.fn((target: unknown) => target),
    stream: vi.fn((target: unknown) => ({ ...(target as object), _stream: true })),
    pageSize: 50,
    write: Symbol("project-work-write"),
  },
}));

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: unknown) => {
    if (atom === testState.configAtom) return testState.config;
    if (typeof atom === "object" && atom !== null && "projectId" in atom) {
      const target = atom as {
        projectId: string;
        offset: number;
        collection: string;
        afterCursor?: number;
        _stream?: boolean;
      };
      if (target._stream === true)
        return (
          testState.streams.get(`${target.projectId}:${target.afterCursor ?? 0}`) ??
          AsyncResult.success({
            cursor: target.afterCursor ?? 0,
            healthy: true,
            resyncRequired: false,
          })
        );
      return (
        testState.pages.get(`${target.projectId}:${target.collection}:${target.offset}`) ??
        AsyncResult.success([])
      );
    }
    return AsyncResult.success([]);
  },
}));
vi.mock("@t3tools/client-runtime/environment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/environment")>()),
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
}));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: "connected" } }),
}));
vi.mock("~/state/entities", () => ({ useProject: () => ({ title: "Project" }) }));
vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: () => testState.configAtom },
}));
vi.mock("~/state/projectWork", () => ({ projectWorkEnvironment: testState.environment }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));
vi.mock("~/state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => vi.fn(),
}));
vi.mock("../ui/sidebar", () => ({
  SidebarInset: ({ children, ...props }: { children?: ReactNode; className?: string }) => (
    <div {...props}>{children}</div>
  ),
}));
vi.mock("./WorkOverview", () => ({ WorkOverview: () => <div>overview</div> }));

import {
  EnvironmentId,
  ProjectId,
  ProjectWorkKnowledgeId,
  ProjectWorkTaskId,
} from "@t3tools/contracts";

import { WorkPage } from "./WorkPage";

const makeTaskPage = (projectId: ProjectId, count: number) =>
  AsyncResult.success(
    Array.from({ length: count }, (_, index) => ({
      taskId: ProjectWorkTaskId.make(`${projectId}-task-${index}`),
      projectId,
      title: `${projectId} task ${index}`,
      state: "draft",
      watchers: [],
      revision: 1,
      specRevision: 0,
      createdAt: "2026-09-17T15:00:00.000Z",
      updatedAt: "2026-09-17T15:00:00.000Z",
    })),
  );

const makeKnowledgePage = (projectId: ProjectId, count: number) =>
  AsyncResult.success(
    Array.from({ length: count }, (_, index) => ({
      knowledgeId: ProjectWorkKnowledgeId.make(`${projectId}-knowledge-${index}`),
      projectId,
      title: `${projectId} knowledge ${index}`,
      body: "A durable fact",
      sourceKind: "manual",
      updatedAt: "2026-09-17T15:00:00.000Z",
    })),
  );

describe("WorkPage project-scoped sections", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    testState.pages.clear();
    testState.streams.clear();
    delete testState.config.environment;
    testState.environment.page.mockClear();
    testState.environment.page.mockImplementation((input: unknown) => {
      const target = input as { projectId: string; collection: string; offset: number };
      return Object.assign(
        Atom.make(
          () =>
            testState.pages.get(`${target.projectId}:${target.collection}:${target.offset}`) ??
            AsyncResult.success([]),
        ),
        target,
      );
    });
    testState.environment.stream.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("opens Team and Inbox with an explicit unsupported environment state", async () => {
    await act(async () =>
      root.render(
        <WorkPage
          environmentId={EnvironmentId.make("environment-1")}
          projectId={ProjectId.make("project-1")}
        />,
      ),
    );
    for (const [tab, notice] of [
      ["Team", "does not support team supervision"],
      ["Inbox", "does not support the question inbox"],
    ]) {
      await act(async () =>
        [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
          .find((button) => button.textContent?.includes(tab!))!
          .click(),
      );
      expect(host.textContent).toContain(notice);
    }
    expect(testState.environment.page).not.toHaveBeenCalled();
  });

  it.each(["inbox", "overview"] as const)(
    "mounts the Inbox when URL selection starts at %s",
    async (initialTab) => {
      const environmentId = EnvironmentId.make("environment-1");
      const projectId = ProjectId.make("project-1");
      const renderTab = async (tab: "inbox" | "overview") => {
        await act(async () =>
          root.render(
            <StrictMode>
              <WorkPage environmentId={environmentId} projectId={projectId} selection={{ tab }} />
            </StrictMode>,
          ),
        );
      };
      await renderTab(initialTab);
      await renderTab("inbox");
      expect(host.textContent).toContain("does not support the question inbox");
      await renderTab("overview");
      const retainedInbox = [...host.querySelectorAll<HTMLDivElement>("div[hidden]")].find((node) =>
        node.textContent?.includes("does not support the question inbox"),
      );
      expect(retainedInbox).toBeDefined();
      await renderTab("inbox");
      expect(host.textContent).toContain("does not support the question inbox");
    },
  );

  it("resets a loaded task page when switching projects", async () => {
    const environmentId = EnvironmentId.make("environment-1");
    const firstProjectId = ProjectId.make("project-1");
    const secondProjectId = ProjectId.make("project-2");
    testState.pages.set(`${firstProjectId}:tasks:0`, makeTaskPage(firstProjectId, 51));
    testState.pages.set(`${firstProjectId}:tasks:50`, makeTaskPage(firstProjectId, 1));
    testState.pages.set(`${secondProjectId}:tasks:0`, makeTaskPage(secondProjectId, 1));

    await act(async () =>
      root.render(
        <StrictMode>
          <WorkPage environmentId={environmentId} projectId={firstProjectId} />
        </StrictMode>,
      ),
    );
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((button) => button.textContent?.includes("Tasks"))
        ?.click();
    });
    const loadMore = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Load more tasks"),
    );
    expect(loadMore).toBeDefined();
    await act(async () => loadMore?.click());

    await act(async () =>
      root.render(
        <StrictMode>
          <WorkPage environmentId={environmentId} projectId={secondProjectId} />
        </StrictMode>,
      ),
    );
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((button) => button.textContent?.includes("Tasks"))
        ?.click();
    });

    expect(host.textContent).toContain(`${secondProjectId} task 0`);
    expect(host.textContent).not.toContain(`${firstProjectId} task 0`);
    expect(host.textContent).not.toContain("Load more tasks");
    expect(testState.environment.page).toHaveBeenCalledWith({
      environmentId,
      projectId: secondProjectId,
      collection: "tasks",
      offset: 0,
    });
  });

  it("opens a linked task immediately and keeps the new-task draft across same-owner URL changes", async () => {
    const environmentId = EnvironmentId.make("environment-1");
    const projectId = ProjectId.make("project-1");
    testState.pages.set(`${projectId}:tasks:0`, makeTaskPage(projectId, 1));
    const render = async (taskId: string) =>
      act(async () =>
        root.render(
          <WorkPage
            environmentId={environmentId}
            projectId={projectId}
            selection={{ tab: "tasks", taskId: ProjectWorkTaskId.make(taskId) }}
          />,
        ),
      );
    await render("first");
    expect(host.textContent).toContain("The linked task requires current team records");
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
      "Tasks",
    );
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("New task"))
        ?.click(),
    );
    const input = host.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Document the release checklist"]',
    );
    expect(input).not.toBeNull();
    if (!input) throw new Error("Missing real new-task title field");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "Keep this draft",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await render("second");
    expect(
      host.querySelector<HTMLInputElement>(
        'input[placeholder="e.g. Document the release checklist"]',
      )?.value,
    ).toBe("Keep this draft");
  });

  it("resets a loaded knowledge page when switching projects", async () => {
    const environmentId = EnvironmentId.make("environment-1");
    const firstProjectId = ProjectId.make("project-1");
    const secondProjectId = ProjectId.make("project-2");
    testState.pages.set(`${firstProjectId}:knowledge:0`, makeKnowledgePage(firstProjectId, 51));
    testState.pages.set(`${firstProjectId}:knowledge:50`, makeKnowledgePage(firstProjectId, 1));
    testState.pages.set(`${secondProjectId}:knowledge:0`, makeKnowledgePage(secondProjectId, 1));

    await act(async () =>
      root.render(
        <StrictMode>
          <WorkPage environmentId={environmentId} projectId={firstProjectId} />
        </StrictMode>,
      ),
    );
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((button) => button.textContent?.includes("Knowledge"))
        ?.click();
    });
    const loadMore = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Load more knowledge"),
    );
    expect(loadMore).toBeDefined();
    await act(async () => loadMore?.click());

    await act(async () =>
      root.render(
        <StrictMode>
          <WorkPage environmentId={environmentId} projectId={secondProjectId} />
        </StrictMode>,
      ),
    );
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((button) => button.textContent?.includes("Knowledge"))
        ?.click();
    });

    expect(host.textContent).toContain(`${secondProjectId} knowledge 0`);
    expect(host.textContent).not.toContain(`${firstProjectId} knowledge 0`);
    expect(host.textContent).not.toContain("Load more knowledge");
    expect(testState.environment.page).toHaveBeenCalledWith({
      environmentId,
      projectId: secondProjectId,
      collection: "knowledge",
      offset: 0,
    });
  });

  it("resumes from an exact lower resync cursor and starts a new project at zero", async () => {
    testState.config.environment = { capabilities: { projectWorkStream: true } };
    const environmentId = EnvironmentId.make("environment-1");
    const firstProjectId = ProjectId.make("project-1");
    const secondProjectId = ProjectId.make("project-2");
    testState.streams.set(
      `${firstProjectId}:0`,
      AsyncResult.success({ cursor: 100, healthy: true, resyncRequired: false }),
    );

    await act(async () =>
      root.render(<WorkPage environmentId={environmentId} projectId={firstProjectId} />),
    );
    testState.streams.set(
      `${firstProjectId}:0`,
      AsyncResult.success({ cursor: 4, healthy: false, resyncRequired: true }),
    );
    await act(async () =>
      root.render(<WorkPage environmentId={environmentId} projectId={firstProjectId} />),
    );
    expect(testState.environment.stream).toHaveBeenCalledWith({
      environmentId,
      projectId: firstProjectId,
      afterCursor: 4,
    });

    await act(async () =>
      root.render(<WorkPage environmentId={environmentId} projectId={secondProjectId} />),
    );
    expect(testState.environment.stream).toHaveBeenCalledWith({
      environmentId,
      projectId: secondProjectId,
      afterCursor: 0,
    });
  });
});
