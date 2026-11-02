import {
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskId,
  type ProjectWorkActivitySummary,
  type ProjectWorkActivityTask,
  type ProjectWorkAttentionItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkHome } from "./workHome.ts";

const env = EnvironmentId.make("env-1");
const project = (id: string, archivedAt: string | null = null) => ({
  environmentId: env,
  id: ProjectId.make(id),
  archivedAt,
});
const item = (projectId: string, key: string): ProjectWorkAttentionItem => ({
  projectId: ProjectId.make(projectId),
  key,
  surface: "overview",
  kind: "decision",
  reason: "Decision to review",
  title: key,
  at: "2026-11-01T00:00:00.000Z",
});
const task = (projectId: string, taskId: string, at: string): ProjectWorkActivityTask => ({
  projectId: ProjectId.make(projectId),
  taskId: ProjectWorkTaskId.make(taskId),
  title: taskId,
  state: "in-progress",
  at,
});
const counts = (projectId: string, running: number, inReview = 0, doneThisWeek = 0) => ({
  projectId: ProjectId.make(projectId),
  open: 2,
  running,
  inReview,
  doneThisWeek,
  lastChangedAt: "2026-11-01T00:00:00.000Z",
});
const activity = (summary: Partial<ProjectWorkActivitySummary>) => [
  { environmentId: env, activity: { projects: [], active: [], recent: [], ...summary } },
];

describe("deriveWorkHome", () => {
  it("lists only projects with something waiting or moving, the ones needing you first", () => {
    const home = deriveWorkHome({
      projects: [project("busy"), project("waiting"), project("quiet"), project("recent")],
      items: [{ environmentId: env, item: item("waiting", "d1") }],
      activity: activity({
        projects: [counts("busy", 1), counts("quiet", 0), counts("recent", 0)],
        active: [task("busy", "t1", "2026-11-02T00:00:00.000Z")],
        recent: [{ ...task("recent", "t2", "2026-11-01T12:00:00.000Z"), state: "completed" }],
      }),
    });
    expect(home.active.map((entry) => entry.projectId)).toEqual(["waiting", "busy", "recent"]);
    expect(home.active.find((entry) => entry.projectId === "recent")?.open).toBe(2);
    expect(home.quiet.map((entry) => entry.projectId)).toEqual(["quiet"]);
  });

  it("totals the stat row across projects and leaves archived projects out entirely", () => {
    const home = deriveWorkHome({
      projects: [project("a"), project("b"), project("gone", "2026-10-01T00:00:00.000Z")],
      items: [
        { environmentId: env, item: item("a", "d1") },
        { environmentId: env, item: item("gone", "d2") },
      ],
      activity: activity({
        projects: [counts("a", 2, 1, 3), counts("b", 1, 0, 1), counts("gone", 5, 5, 5)],
      }),
    });
    expect(home.stats).toEqual({ needsYou: 1, running: 3, inReview: 1, doneThisWeek: 4 });
    expect(home.active.some((entry) => entry.projectId === "gone")).toBe(false);
    expect(home.quiet).toEqual([]);
  });

  it("leaves scratch and agent-owned workspaces out of the quiet list", () => {
    const home = deriveWorkHome({
      projects: [
        project("real"),
        { ...project("scratch"), isScratch: true as const },
        { ...project("agent"), assistantId: "assistant-1" },
      ],
      items: [],
      activity: activity({}),
    });
    expect(home.quiet.map((entry) => entry.projectId)).toEqual(["real"]);
  });

  it("still places projects by attention when the server sends no activity", () => {
    const home = deriveWorkHome({
      projects: [project("a"), project("b")],
      items: [{ environmentId: env, item: item("a", "d1") }],
      activity: [{ environmentId: env, activity: null }],
    });
    expect(home.active.map((entry) => [entry.projectId, entry.needsYou])).toEqual([["a", 1]]);
    expect(home.quiet.map((entry) => entry.projectId)).toEqual(["b"]);
  });
});
