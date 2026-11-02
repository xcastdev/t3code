import { ProjectWorkAttentionSummary } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  type ActivitySource,
  type AttentionSource,
  deriveProjectWorkActivity,
  deriveProjectWorkAttention,
} from "./ProjectWorkAttention.ts";

const task = (
  taskId: string,
  state: string,
  extra: Partial<AttentionSource["tasks"][number]> = {},
) => ({
  projectId: "p1",
  taskId,
  title: `Task ${taskId}`,
  state,
  specRevision: 2,
  approvedSpecRevision: null,
  failureKind: null,
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...extra,
});
const decodeSummary = Schema.decodeSync(ProjectWorkAttentionSummary);
const empty: AttentionSource = {
  tasks: [],
  attention: [],
  blockers: [],
  decisions: [],
  records: [],
};
const keys = (source: AttentionSource) =>
  deriveProjectWorkAttention(source).items.map(
    (item) => `${item.surface}:${item.kind}:${item.reason}`,
  );

describe("deriveProjectWorkAttention", () => {
  it("asks for task approval only when the current scope revision is unapproved", () => {
    expect(
      keys({
        ...empty,
        tasks: [
          task("a", "specified"),
          task("b", "specified", { approvedSpecRevision: 2 }),
          task("c", "ready", { approvedSpecRevision: 2 }),
        ],
      }),
    ).toEqual(["tasks:task:Needs approval"]);
  });

  it("counts a task once even when several things point at it", () => {
    const summary = deriveProjectWorkAttention({
      ...empty,
      tasks: [task("a", "blocked")],
      attention: [{ projectId: "p1", taskId: "a", reason: "blocked", detail: "blocker-uuid" }],
      blockers: [
        { projectId: "p1", blockerId: "x", taskId: "a", reason: "Needs a repro", resolver: "Wren" },
      ],
    });
    expect(summary.items.filter((item) => item.surface === "tasks")).toEqual([
      expect.objectContaining({ reason: "Blocked", detail: "Waiting on Wren: Needs a repro" }),
    ]);
    expect(summary.items.find((item) => item.kind === "blocker")).toMatchObject({
      surface: "overview",
      reason: "Waiting on Wren",
      detail: "Needs a repro",
    });
  });

  it("ignores finished tasks and anything already answered or resolved", () => {
    expect(
      keys({
        ...empty,
        tasks: [task("a", "completed"), task("b", "canceled")],
        attention: [{ projectId: "p1", taskId: "a", reason: "failed", detail: null }],
        blockers: [
          { projectId: "p1", blockerId: "x", taskId: "b", reason: "old", resolver: "Wren" },
        ],
        records: [
          {
            projectId: "p1",
            recordId: "q",
            kind: "question",
            status: "answered",
            taskId: "a",
            body: "Which branch?",
            gate: null,
            updatedAt: "2026-11-01T00:00:00.000Z",
          },
          {
            projectId: "p1",
            recordId: "m",
            kind: "message",
            status: "resolved",
            taskId: null,
            body: "Done",
            gate: null,
            updatedAt: "2026-11-01T00:00:00.000Z",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("puts decisions, questions and messages on the Overview, newest first, and decodes", () => {
    const summary = deriveProjectWorkAttention({
      ...empty,
      tasks: [task("a", "in-progress")],
      decisions: [
        {
          projectId: "p1",
          decisionId: "d",
          title: "Use SQLite",
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
      records: [
        {
          projectId: "p1",
          recordId: "q",
          kind: "question",
          status: "pending",
          taskId: "a",
          body: "Which branch?",
          gate: null,
          updatedAt: "2026-11-02T00:00:00.000Z",
        },
        {
          projectId: "p1",
          recordId: "g",
          kind: "gate",
          status: "pending",
          taskId: "a",
          body: null,
          gate: "plan",
          updatedAt: "2026-10-30T00:00:00.000Z",
        },
      ],
    });
    expect(summary.items.map((item) => `${item.surface}:${item.reason}`)).toEqual([
      "overview:Answer needed",
      "overview:Decision to review",
      "tasks:Needs approval",
    ]);
    expect(() => decodeSummary(summary)).not.toThrow();
  });
});

describe("deriveProjectWorkActivity", () => {
  const row = (
    taskId: string,
    state: string,
    extra: Partial<ActivitySource["active"][number]> = {},
  ) => ({
    projectId: "p1",
    taskId,
    title: `Task ${taskId}`,
    state,
    updatedAt: "2026-11-01T00:00:00.000Z",
    assigneeId: null,
    assigneeName: null,
    ...extra,
  });
  const team: Pick<ActivitySource, "members" | "roles"> = {
    members: [
      {
        recordId: "m-iris",
        name: "Iris",
        avatarJson: JSON.stringify({
          kind: "generated",
          version: 1,
          seed: 3,
          tone: "sage",
          expression: "curious",
          motion: true,
        }),
        roleRevisionId: "r-inv",
      },
      { recordId: "m-otto", name: "Otto", avatarJson: null, roleRevisionId: "r-impl" },
    ],
    roles: [
      { recordId: "r-inv", role: "investigator" },
      { recordId: "r-impl", role: "implementer" },
    ],
  };

  it("names the running member over the assignee, then an assigned member, then a person", () => {
    const activity = deriveProjectWorkActivity({
      counts: [],
      recent: [],
      ...team,
      bindings: [{ taskId: "a", memberId: "m-otto" }],
      active: [
        row("a", "in-progress", { assigneeId: "m-iris" }),
        row("b", "in-review", { assigneeId: "m-iris" }),
        row("c", "in-progress", { assigneeName: "Dana Okafor" }),
      ],
    });
    expect(activity.active.map((task) => [task.taskId, task.worker?.name, task.assignee])).toEqual([
      ["a", "Otto", undefined],
      ["b", "Iris", undefined],
      ["c", undefined, "Dana Okafor"],
    ]);
    expect(activity.active[1]?.worker).toMatchObject({ role: "investigator", avatar: { seed: 3 } });
  });

  it("keeps per-project counts and decodes as the wire summary", () => {
    const activity = deriveProjectWorkActivity({
      ...team,
      bindings: [],
      active: [],
      recent: [row("d", "completed")],
      counts: [
        {
          projectId: "p1",
          open: 4,
          running: 1,
          inReview: 2,
          doneThisWeek: 3,
          lastChangedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    });
    expect(decodeSummary({ items: [], truncated: false, activity }).activity?.projects).toEqual([
      {
        projectId: "p1",
        open: 4,
        running: 1,
        inReview: 2,
        doneThisWeek: 3,
        lastChangedAt: "2026-11-01T00:00:00.000Z",
      },
    ]);
  });
});
