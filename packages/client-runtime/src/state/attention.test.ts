import { EnvironmentId, ProjectId, ProjectWorkTaskId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectAttention, noteAttentionArrivals, workAttentionFor } from "./attention.ts";

const env = EnvironmentId.make("env-1");
const project = ProjectId.make("p1");
const archived = ProjectId.make("p2");
const projects = [
  { environmentId: env, id: project, archivedAt: null },
  { environmentId: env, id: archived, archivedAt: "2026-11-01T00:00:00.000Z" },
];
const thread = (id: string, extra: Record<string, unknown> = {}) => ({
  environmentId: env,
  id: ThreadId.make(id),
  projectId: project,
  title: `Thread ${id}`,
  updatedAt: "2026-11-01T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingSubagentRequest: null,
  source: { pendingRuntimeRequest: null },
  ...extra,
});
const workItem = (key: string, extra: Record<string, unknown> = {}) => ({
  projectId: project,
  key,
  surface: "tasks" as const,
  kind: "task" as const,
  reason: "Blocked",
  title: "Fix it",
  taskId: ProjectWorkTaskId.make("t1"),
  at: "2026-11-02T00:00:00.000Z",
  ...extra,
});

describe("collectAttention", () => {
  it("lists thread requests and Work items newest first, skipping archived threads and projects", () => {
    const entries = collectAttention({
      projects,
      threads: [
        thread("a", {
          hasPendingApprovals: true,
          source: { pendingRuntimeRequest: { id: "req-1" } },
        }),
        thread("b", { hasPendingUserInput: true, archivedAt: "2026-11-01T00:00:00.000Z" }),
        thread("c", { hasPendingUserInput: true, projectId: archived }),
        thread("d"),
      ],
      work: [{ environmentId: env, items: [workItem("task:1")] }],
    });
    expect(entries.map((entry) => entry.key)).toEqual(["env-1:task:1", "chat:env-1:a:req-1"]);
    expect(entries[1]).toMatchObject({ reason: "Approval needed" });
  });

  it("shows a blocked task once even though its blocker is also listed", () => {
    const entries = collectAttention({
      projects,
      threads: [],
      work: [
        {
          environmentId: env,
          items: [
            workItem("task:1"),
            workItem("blocker:1", {
              kind: "blocker",
              surface: "overview",
              reason: "Waiting on Wren",
            }),
          ],
        },
      ],
    });
    expect(entries).toHaveLength(1);
  });
});

describe("workAttentionFor", () => {
  it("splits one project's items between the Overview and Tasks", () => {
    const work = [
      {
        environmentId: env,
        items: [
          workItem("task:1"),
          workItem("blocker:1", { kind: "blocker", surface: "overview" }),
          workItem("task:other", { projectId: ProjectId.make("p3") }),
        ],
      },
    ];
    expect(workAttentionFor(work, env, project)).toEqual({
      overview: ["blocker:1"],
      tasks: ["task:1"],
    });
  });
});

describe("noteAttentionArrivals", () => {
  it("arrives only for keys never seen, not when items resolve", () => {
    const first = noteAttentionArrivals(new Set(), ["a", "b"]);
    expect(first.arrived).toBe(true);
    expect(noteAttentionArrivals(first.seen, ["a"]).arrived).toBe(false);
    expect(noteAttentionArrivals(first.seen, ["a", "b"]).arrived).toBe(false);
    expect(noteAttentionArrivals(first.seen, ["a", "c"]).arrived).toBe(true);
  });
});
