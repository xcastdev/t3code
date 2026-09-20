/* @vitest-environment happy-dom */

import { AsyncResult } from "effect/unstable/reactivity";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  write: vi.fn(),
  refreshBriefing: vi.fn(),
  read: null as unknown,
  briefingRead: null as unknown,
  briefingAtom: Symbol("project-work-briefing"),
  environment: {
    page: vi.fn((target: unknown) => target),
    pageSize: 50,
    write: Symbol("project-work-write"),
    briefing: undefined as undefined | ReturnType<typeof vi.fn>,
  },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === testState.briefingAtom ? testState.briefingRead : testState.read,
}));
vi.mock("~/state/projectWork", () => ({ projectWorkEnvironment: testState.environment }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.write,
}));
vi.mock("~/state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => testState.refreshBriefing,
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  squashAtomCommandFailure: (failure: { readonly cause?: unknown }) =>
    failure.cause ?? new Error("write failed"),
}));

import {
  EnvironmentId,
  ProjectId,
  ProjectWorkKnowledgeId,
  ProjectWorkTaskId,
} from "@t3tools/contracts";

import { WorkKnowledge } from "./WorkKnowledge";
import { WorkTasks } from "./WorkTasks";

const task = {
  taskId: ProjectWorkTaskId.make("task-1"),
  projectId: ProjectId.make("project-1"),
  title: "Document the release checklist",
  state: "draft",
  watchers: [],
  revision: 4,
  specRevision: 0,
  createdAt: "2026-09-17T15:00:00.000Z",
  updatedAt: "2026-09-17T15:00:00.000Z",
} as Record<string, unknown>;

describe("WorkTasks interactions", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    testState.write.mockReset();
    testState.refreshBriefing.mockReset();
    testState.environment.briefing = undefined;
    testState.environment.page.mockClear();
    testState.read = AsyncResult.success({
      projectId: "project-1",
      revision: 4,
      offset: 0,
      limit: 51,
      hasMore: false,
      items: [task],
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function fill(selector: string, value: string) {
    const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    const prototype =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(field, value);
    await act(async () => field.dispatchEvent(new Event("input", { bubbles: true })));
  }

  it("retries only the failed specification stage after criterion creation succeeds", async () => {
    testState.write
      .mockResolvedValueOnce({ _tag: "Success", value: { revision: 5 } })
      .mockResolvedValueOnce({ _tag: "Failure" })
      .mockResolvedValueOnce({ _tag: "Success", value: { revision: 6 } });

    await act(async () =>
      root.render(
        <StrictMode>
          <WorkTasks
            environmentId={EnvironmentId.make("environment-1")}
            projectId={ProjectId.make("project-1")}
            connected
            enabled
          />
        </StrictMode>,
      ),
    );

    await fill('[placeholder="What outcome should exist?"]', "Document the release checklist");
    await fill('[placeholder="What is included?"]', "The release process");
    await fill('[placeholder="What is explicitly excluded?"]', "Automating the release");
    await fill('[placeholder="How will we know it is done?"]', "The checklist is documented");
    expect(
      (host.querySelector('[placeholder="What outcome should exist?"]') as HTMLTextAreaElement)
        .value,
    ).toBe("Document the release checklist");
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Save specification"))
        ?.click();
    });

    expect(testState.write).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("write failed");
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Retry"))
        ?.click();
    });

    expect(testState.write).toHaveBeenCalledTimes(3);
    expect(testState.write.mock.calls[0]?.[0].input.type).toBe("project-work.criterion.upsert");
    expect(testState.write.mock.calls[1]?.[0].input.type).toBe("project-work.task.specify");
    expect(testState.write.mock.calls[2]?.[0].input.type).toBe("project-work.task.specify");
    expect(testState.write.mock.calls[2]?.[0].input.expectedRevision).toBe(5);
    expect(testState.write.mock.calls[2]?.[0].input.commandId).toBe(
      testState.write.mock.calls[1]?.[0].input.commandId,
    );
  });

  it("retries the criterion stage before starting specification", async () => {
    testState.write
      .mockResolvedValueOnce({ _tag: "Failure" })
      .mockResolvedValueOnce({ _tag: "Success", value: { revision: 5 } })
      .mockResolvedValueOnce({ _tag: "Success", value: { revision: 6 } });

    await act(async () =>
      root.render(
        <StrictMode>
          <WorkTasks
            environmentId={EnvironmentId.make("environment-1")}
            projectId={ProjectId.make("project-1")}
            connected
            enabled
          />
        </StrictMode>,
      ),
    );
    await fill('[placeholder="What outcome should exist?"]', "Document the release checklist");
    await fill('[placeholder="What is included?"]', "The release process");
    await fill('[placeholder="What is explicitly excluded?"]', "Automating the release");
    await fill('[placeholder="How will we know it is done?"]', "The checklist is documented");
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Save specification"))
        ?.click();
    });
    expect(host.textContent).toContain("write failed");
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Retry"))
        ?.click();
    });

    expect(testState.write).toHaveBeenCalledTimes(3);
    expect(testState.write.mock.calls[0]?.[0].input.type).toBe("project-work.criterion.upsert");
    expect(testState.write.mock.calls[1]?.[0].input.type).toBe("project-work.criterion.upsert");
    expect(testState.write.mock.calls[1]?.[0].input.commandId).toBe(
      testState.write.mock.calls[0]?.[0].input.commandId,
    );
    expect(testState.write.mock.calls[2]?.[0].input.type).toBe("project-work.task.specify");
  });

  it("retries a failed draft creation with the same command envelope", async () => {
    testState.read = AsyncResult.success([]);
    testState.write
      .mockResolvedValueOnce({ _tag: "Failure" })
      .mockResolvedValueOnce({ _tag: "Success", value: { revision: 1 } });

    await act(async () =>
      root.render(
        <StrictMode>
          <WorkTasks
            environmentId={EnvironmentId.make("environment-1")}
            projectId={ProjectId.make("project-1")}
            connected
            enabled
          />
        </StrictMode>,
      ),
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[data-slot="button"]')?.click(),
    );
    await fill('[placeholder="e.g. Document the release checklist"]', "Capture the checklist");
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Create draft"))
        ?.click();
    });
    expect(host.textContent).toContain("write failed");
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Retry"))
        ?.click();
    });

    expect(testState.write).toHaveBeenCalledTimes(2);
    expect(testState.write.mock.calls[1]?.[0].input.commandId).toBe(
      testState.write.mock.calls[0]?.[0].input.commandId,
    );
    expect(testState.write.mock.calls[1]?.[0].input.taskId).toBe(
      testState.write.mock.calls[0]?.[0].input.taskId,
    );
  });

  it("retries a failed ready transition with the same command envelope", async () => {
    testState.read = AsyncResult.success({
      projectId: "project-1",
      revision: 4,
      offset: 0,
      limit: 51,
      hasMore: false,
      items: [
        {
          ...task,
          state: "specified",
          specification: {
            objective: "Document the release checklist",
            scopeIn: "The release process",
            scopeOut: "Automating the release",
            criterionIds: [],
            revision: 1,
            protected: false,
          },
          specRevision: 1,
        },
      ],
    });
    testState.write
      .mockResolvedValueOnce({ _tag: "Failure" })
      .mockResolvedValueOnce({ _tag: "Success", value: { revision: 6 } });

    await act(async () =>
      root.render(
        <StrictMode>
          <WorkTasks
            environmentId={EnvironmentId.make("environment-1")}
            projectId={ProjectId.make("project-1")}
            connected
            enabled
          />
        </StrictMode>,
      ),
    );
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click();
    });
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Mark ready"))
        ?.click();
    });
    expect(host.textContent).toContain("write failed");
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Retry"))
        ?.click();
    });

    expect(testState.write).toHaveBeenCalledTimes(2);
    expect(testState.write.mock.calls[1]?.[0].input.commandId).toBe(
      testState.write.mock.calls[0]?.[0].input.commandId,
    );
    expect(testState.write.mock.calls[1]?.[0].input.expectedRevision).toBe(4);
  });

  it("keeps the load-more cursor when a cached first page has a next page in StrictMode", async () => {
    testState.read = AsyncResult.success(
      Array.from({ length: 51 }, (_, index) => ({
        ...task,
        taskId: ProjectWorkTaskId.make(`task-${index}`),
      })),
    );

    await act(async () =>
      root.render(
        <StrictMode>
          <WorkTasks
            environmentId={EnvironmentId.make("environment-1")}
            projectId={ProjectId.make("project-1")}
            connected
            enabled
          />
        </StrictMode>,
      ),
    );

    const loadMore = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Load more tasks"),
    );
    expect(loadMore).toBeDefined();

    await act(async () => loadMore?.click());

    expect(testState.environment.page).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("environment-1"),
      projectId: ProjectId.make("project-1"),
      collection: "tasks",
      offset: 50,
    });
  });

  it("keeps the knowledge load-more cursor when a cached first page has a next page in StrictMode", async () => {
    testState.read = AsyncResult.success(
      Array.from({ length: 51 }, (_, index) => ({
        knowledgeId: ProjectWorkKnowledgeId.make(`knowledge-${index}`),
        projectId: ProjectId.make("project-1"),
        title: `Knowledge ${index}`,
        body: "A durable fact",
        sourceKind: "manual",
        updatedAt: "2026-09-17T15:00:00.000Z",
      })),
    );

    await act(async () =>
      root.render(
        <StrictMode>
          <WorkKnowledge
            environmentId={EnvironmentId.make("environment-1")}
            projectId={ProjectId.make("project-1")}
            connected
          />
        </StrictMode>,
      ),
    );

    const loadMore = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Load more knowledge"),
    );
    expect(loadMore).toBeDefined();

    await act(async () => loadMore?.click());

    expect(testState.environment.page).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("environment-1"),
      projectId: ProjectId.make("project-1"),
      collection: "knowledge",
      offset: 50,
    });
  });

  it("rebases a stale decision command and immediately submits it", async () => {
    testState.environment.briefing = vi.fn(() => testState.briefingAtom);
    testState.briefingRead = AsyncResult.success({
      text: "Current project briefing",
      sourceRevision: 4,
      includedTaskIds: [],
      includedKnowledgeIds: [],
      omittedReasons: [],
    });
    testState.refreshBriefing.mockResolvedValue({
      _tag: "Success",
      value: {
        text: "Updated project briefing",
        sourceRevision: 9,
        includedTaskIds: [],
        includedKnowledgeIds: [],
        omittedReasons: [],
      },
    });
    testState.write
      .mockResolvedValueOnce({
        _tag: "Failure",
        cause: {
          code: "stale-revision",
          message: "The project changed.",
          details: { currentRevision: 9, changedFields: ["decisions"] },
        },
      })
      .mockResolvedValueOnce({ _tag: "Success", value: { revision: 10 } });
    vi.stubGlobal(
      "prompt",
      vi
        .fn()
        .mockReturnValueOnce("Choose SQLite")
        .mockReturnValueOnce("SQLite keeps the deployment self-contained"),
    );

    await act(async () =>
      root.render(
        <StrictMode>
          <WorkKnowledge
            environmentId={EnvironmentId.make("environment-1")}
            projectId={ProjectId.make("project-1")}
            connected
            canWrite
          />
        </StrictMode>,
      ),
    );
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Propose decision"))
        ?.click();
    });
    expect(host.textContent).toContain("The project changed.");
    const original = testState.write.mock.calls[0]?.[0].input;

    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Rebase on latest"))
        ?.click();
    });

    expect(testState.refreshBriefing).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("environment-1"),
      projectId: ProjectId.make("project-1"),
    });
    expect(testState.write).toHaveBeenCalledTimes(2);
    const rebased = testState.write.mock.calls[1]?.[0].input;
    const {
      commandId: originalCommandId,
      expectedRevision: _originalRevision,
      ...payload
    } = original;
    expect(rebased).toMatchObject({
      ...payload,
      expectedRevision: 9,
    });
    expect(rebased.commandId).not.toBe(originalCommandId);
    expect(host.textContent).not.toContain("The project changed.");
  });
});
