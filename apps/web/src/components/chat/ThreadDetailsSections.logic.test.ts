import { NodeId, PlanId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  checklistProgressByRun,
  latestTodoList,
  type TodoListPlan,
} from "./ThreadDetailsSections.logic";

const threadId = ThreadId.make("thread");
const runs = [
  { id: RunId.make("run-1"), ordinal: 1 },
  { id: RunId.make("run-2"), ordinal: 2 },
];

function todoList(
  id: string,
  runId: string,
  overrides: Partial<Pick<TodoListPlan, "status" | "steps">> = {},
): TodoListPlan {
  return {
    id: PlanId.make(id),
    threadId,
    runId: RunId.make(runId),
    nodeId: NodeId.make(`node:${id}`),
    kind: "todo_list",
    status: "active",
    steps: [{ id: "step", text: "Write the fix", status: "pending" }],
    ...overrides,
  };
}

describe("latestTodoList", () => {
  it("keeps the newest run's list across later turns", () => {
    expect(latestTodoList([todoList("newer", "run-2"), todoList("older", "run-1")], runs)?.id).toBe(
      "newer",
    );
  });

  it("skips a list the agent replaced", () => {
    expect(
      latestTodoList(
        [todoList("older", "run-1"), todoList("replaced", "run-2", { status: "superseded" })],
        runs,
      )?.id,
    ).toBe("older");
  });

  it("lets a cleared list hide an older one instead of resurfacing it", () => {
    const latest = latestTodoList(
      [
        todoList("older", "run-1"),
        todoList("cleared", "run-2", { status: "completed", steps: [] }),
      ],
      runs,
    );
    expect(latest?.id).toBe("cleared");
    expect(latest?.steps).toEqual([]);
  });
});

describe("checklistProgressByRun", () => {
  it("counts done steps per run and drops a list the agent cleared", () => {
    const progress = checklistProgressByRun([
      todoList("first", "run-1", {
        steps: [
          { id: "a", text: "Read", status: "completed" },
          { id: "b", text: "Fix", status: "running" },
        ],
      }),
      todoList("second", "run-2"),
      todoList("cleared", "run-2", { steps: [], status: "completed" }),
    ]);
    expect(progress.get(RunId.make("run-1"))).toEqual({ done: 1, total: 2 });
    expect(progress.has(RunId.make("run-2"))).toBe(false);
  });
});
