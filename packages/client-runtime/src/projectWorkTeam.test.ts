import { ProjectWorkTaskId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupWorkTasks,
  memberActivity,
  taskMember,
  workTaskFilterOptions,
} from "./projectWorkTeam.ts";

describe("memberActivity", () => {
  it("does not mistake an enabled member or a finished run for a running worker", () => {
    expect(memberActivity("active", [{ status: "settled", taskId: "old" }], [], true).state).toBe(
      "available",
    );
    expect(memberActivity("paused", [], [], true).state).toBe("paused");
  });

  it("shows a question only when it belongs to the member's current work", () => {
    const bindings = [
      { status: "running", taskId: "current" },
      { status: "settled", taskId: "old" },
    ];
    expect(memberActivity("active", bindings, ["old"], true).state).toBe("running");
    expect(memberActivity("active", bindings, ["current"], true).state).toBe("waiting");
  });

  it("keeps recovery and stopping visible and never claims availability from incomplete records", () => {
    expect(
      memberActivity("active", [{ status: "quarantined", taskId: "unknown" }], [], true).state,
    ).toBe("recovery");
    expect(
      memberActivity("active", [{ status: "stopping", taskId: "closing" }], [], true).state,
    ).toBe("stopping");
    expect(memberActivity("active", [], [], false).state).toBe("unknown");
    expect(
      memberActivity("active", [{ status: "future-status", taskId: "new" }], [], true).state,
    ).toBe("unknown");
  });
});

const member = (recordId: string, taskId?: string) => ({ recordId, name: recordId, taskId });
const taskId = ProjectWorkTaskId.make("task-1");

describe("taskMember", () => {
  it("prefers the member working the task over the assignee", () => {
    const roster = [member("iris"), member("otto", "task-1")];
    expect(taskMember(roster, { taskId, assignee: { kind: "agent", id: "iris" } })?.recordId).toBe(
      "otto",
    );
  });

  it("finds the assigned member when nobody is working the task", () => {
    const roster = [member("iris"), member("otto", "task-2")];
    expect(taskMember(roster, { taskId, assignee: { kind: "agent", id: "iris" } })?.recordId).toBe(
      "iris",
    );
  });

  it("has no member for an assignee outside the team", () => {
    expect(
      taskMember([member("iris")], { taskId, assignee: { kind: "human", displayName: "Dana" } }),
    ).toBeUndefined();
  });
});

describe("groupWorkTasks", () => {
  const tasks = [
    { id: "a", state: "in-review" },
    { id: "b", state: "in-progress" },
    { id: "c", state: "from-a-newer-server" },
    { id: "d", state: "canceled" },
  ];

  it("groups by what the task needs, with a state it doesn't know waiting in Up next", () => {
    const groups = groupWorkTasks(tasks, null, "all");
    expect(groups.map((group) => [group.id, group.tasks.map((task) => task.id)])).toEqual([
      ["needs-you", ["a"]],
      ["running", ["b"]],
      ["up-next", ["c"]],
      ["done", ["d"]],
    ]);
  });

  it("counts the whole project only while unfiltered, and keeps a counted group with no rows", () => {
    const counts = { blocked: 2, "in-review": 1, completed: 5, total: 9 };
    const all = groupWorkTasks(tasks.slice(0, 1), counts, "all");
    expect(all.map((group) => [group.id, group.count, group.empty])).toEqual([
      ["needs-you", 3, false],
      ["running", 0, true],
      ["up-next", 0, true],
      ["done", 5, false],
    ]);
    expect(groupWorkTasks(tasks.slice(0, 1), counts, "in-review")[0]?.count).toBe(1);
  });
});

describe("workTaskFilterOptions", () => {
  it("hides empty states but keeps All and the chosen filter", () => {
    const options = workTaskFilterOptions({ total: 3, blocked: 0, draft: 3, failed: 0 }, "failed");
    expect(options.map((option) => option.state)).toEqual([
      "all",
      "in-progress",
      "in-review",
      "failed",
      "ready",
      "specified",
      "draft",
      "completed",
      "canceled",
    ]);
  });
});
