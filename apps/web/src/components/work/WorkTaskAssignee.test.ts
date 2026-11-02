import { ProjectWorkTaskId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { taskMember, type WorkRosterMember } from "./WorkTaskAssignee";

const member = (recordId: string, taskId?: string) =>
  ({ recordId, name: recordId, taskId }) as unknown as WorkRosterMember;
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
