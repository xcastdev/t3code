import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { WorkTasks } from "./WorkTasks";
import type { WorkWriter } from "./useWorkWriter";

vi.mock("./WorkTaskDetail", () => ({ WorkTaskDetail: () => null }));
vi.mock("../../state/projectWork", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { Schema } = await import("effect");
  const { ProjectWorkTaskRead } = await import("@t3tools/contracts");
  const { normalizeProjectWorkPage } = await import("@t3tools/client-runtime/state/project-work");
  const decodeTask = Schema.decodeUnknownSync(ProjectWorkTaskRead);
  const tasks = Array.from({ length: 70 }, (_, index) =>
    decodeTask({
      taskId: `task-${index}`,
      projectId: "filter-project",
      title: `Task ${index}`,
      state: index === 68 ? "blocked" : "ready",
      revision: 1,
      specRevision: 0,
      watchers: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      attribution: {
        actor: { kind: "human" },
        source: { kind: "web" },
        recordedAt: "2026-01-01T00:00:00.000Z",
      },
    }),
  );
  const empty = { items: [], hasMore: false };
  const summary = {
    projectId: "filter-project",
    availability: "available",
    revision: 1,
    taskCounts: {
      draft: 0,
      specified: 0,
      ready: 69,
      "in-progress": 0,
      blocked: 1,
      "in-review": 0,
      completed: 0,
      failed: 0,
      canceled: 0,
      unknown: 0,
      total: 70,
    },
    missions: empty,
    bindings: empty,
    questions: empty,
    blockers: empty,
  };
  const family = Atom.family((key: string) => {
    const { input } = JSON.parse(key);
    const filtered = tasks.filter((t) => input.state === undefined || t.state === input.state);
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 64;
    const value =
      input.operation === "supervision"
        ? summary
        : {
            projectId: "filter-project",
            revision: 1,
            items: filtered.slice(offset, offset + limit),
            hasMore: offset + limit < filtered.length,
            nextOffset: offset + limit < filtered.length ? offset + limit : null,
            operation: "tasks",
            offset,
            limit,
          };
    return Atom.make({
      status: "ready",
      label: null,
      result: AsyncResult.success(value),
      value,
      page: input.operation === "tasks" ? normalizeProjectWorkPage(input, value) : null,
      special:
        input.operation === "supervision" ? { operation: "supervision", value: summary } : null,
    });
  });
  return { projectWorkEnvironment: { read: (target: unknown) => family(JSON.stringify(target)) } };
});

function setup() {
  const writer: WorkWriter = {
    canWrite: false,
    canIssue: false,
    canDeliver: false,
    pendingKey: null,
    failure: null,
    submit: vi.fn(async () => false),
    runIssue: vi.fn(async () => null),
    runDelivery: vi.fn(async () => null),
    failureFor: () => null,
    dismiss: () => {},
  };
  return {
    writer,
    scope: {
      environmentId: EnvironmentId.make("filter-env"),
      projectId: ProjectId.make("filter-project"),
      checkoutPath: "/demo",
    },
  };
}

it("starts a status filter on its first page after paging the unfiltered list", async () => {
  const { writer, scope } = setup();
  await using screen = await render(
    <WorkTasks scope={scope} writer={writer} taskId={undefined} onSelectTask={() => {}} />,
  );
  await expect.element(screen.getByText("Task 0", { exact: true })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Next", exact: true }));
  await expect.element(screen.getByText("Task 64", { exact: true })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Filter tasks", exact: true }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: "Blocked 1", exact: true }));
  await expect.element(screen.getByText("Task 68", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Task 64", { exact: true })).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Next", exact: true }))
    .not.toBeInTheDocument();
});
