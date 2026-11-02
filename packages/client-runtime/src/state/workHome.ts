import type {
  EnvironmentId,
  ProjectId,
  ProjectWorkActivitySummary,
  ProjectWorkActivityTask,
  ProjectWorkAttentionItem,
} from "@t3tools/contracts";

export interface WorkHomeProject {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly needsYou: number;
  readonly running: number;
  readonly inReview: number;
  readonly open: number;
  /** In progress and in review, newest first. */
  readonly active: ReadonlyArray<ProjectWorkActivityTask>;
  /** Other tasks changed this week, newest first. */
  readonly recent: ReadonlyArray<ProjectWorkActivityTask>;
  readonly lastChangedAt: string | null;
}

export interface WorkHome {
  readonly stats: {
    readonly needsYou: number;
    readonly running: number;
    readonly inReview: number;
    readonly doneThisWeek: number;
  };
  /** Projects with something waiting or moving, the ones needing you first. */
  readonly active: ReadonlyArray<WorkHomeProject>;
  /** Live projects with nothing waiting and nothing moving. */
  readonly quiet: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }>;
}

interface WorkHomeProjectRef {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly archivedAt?: string | null | undefined;
  readonly isScratch?: true;
  readonly assistantId?: string | null | undefined;
}

const RECENT_PER_PROJECT = 3;

/**
 * The cross-project Work overview. `items` are the Work attention items already filtered to live
 * projects (as the bell shows them); `activity` is each environment's summary, absent on servers
 * that predate it, in which case only attention places a project.
 */
export function deriveWorkHome(input: {
  readonly items: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly item: ProjectWorkAttentionItem;
  }>;
  readonly activity: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly activity: ProjectWorkActivitySummary | null;
  }>;
  readonly projects: ReadonlyArray<WorkHomeProjectRef>;
}): WorkHome {
  const key = (environmentId: string, projectId: string) => `${environmentId}\u0000${projectId}`;
  // Scratch and agent-owned workspaces aren't Work projects; the server refuses their Work reads.
  const live = input.projects.filter(
    (project) => !project.archivedAt && project.isScratch !== true && !project.assistantId,
  );
  const liveKeys = new Set(live.map((project) => key(project.environmentId, project.id)));
  const byProject = new Map<string, WorkHomeProject>();
  const entry = (environmentId: EnvironmentId, projectId: ProjectId) => {
    const k = key(environmentId, projectId);
    let project = byProject.get(k);
    if (project === undefined) {
      project = {
        environmentId,
        projectId,
        needsYou: 0,
        running: 0,
        inReview: 0,
        open: 0,
        active: [],
        recent: [],
        lastChangedAt: null,
      };
      byProject.set(k, project);
    }
    return project;
  };
  const update = (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    change: (project: WorkHomeProject) => Partial<WorkHomeProject>,
  ) => {
    if (!liveKeys.has(key(environmentId, projectId))) return;
    const project = entry(environmentId, projectId);
    byProject.set(key(environmentId, projectId), { ...project, ...change(project) });
  };
  for (const { environmentId, item } of input.items) {
    update(environmentId, item.projectId, (project) => ({ needsYou: project.needsYou + 1 }));
  }
  for (const { environmentId, activity } of input.activity) {
    if (activity === null) continue;
    for (const task of activity.active) {
      update(environmentId, task.projectId, (project) => ({ active: [...project.active, task] }));
    }
    for (const task of activity.recent) {
      update(environmentId, task.projectId, (project) =>
        project.recent.length >= RECENT_PER_PROJECT ? {} : { recent: [...project.recent, task] },
      );
    }
  }
  // Counts come last so a project placed only by attention or a recent change still gets them.
  let doneThisWeek = 0;
  for (const { environmentId, activity } of input.activity) {
    if (activity === null) continue;
    for (const counts of activity.projects) {
      const k = key(environmentId, counts.projectId);
      if (!liveKeys.has(k)) continue;
      doneThisWeek += counts.doneThisWeek;
      if (counts.running === 0 && counts.inReview === 0 && !byProject.has(k)) continue;
      update(environmentId, counts.projectId, () => ({
        running: counts.running,
        inReview: counts.inReview,
        open: counts.open,
        lastChangedAt: counts.lastChangedAt ?? null,
      }));
    }
  }
  const active = [...byProject.values()].sort(
    (a, b) =>
      Number(b.needsYou > 0) - Number(a.needsYou > 0) ||
      (b.lastChangedAt ?? "").localeCompare(a.lastChangedAt ?? "") ||
      b.needsYou - a.needsYou,
  );
  return {
    stats: {
      needsYou: input.items.filter(({ environmentId, item }) =>
        liveKeys.has(key(environmentId, item.projectId)),
      ).length,
      running: active.reduce((sum, project) => sum + project.running, 0),
      inReview: active.reduce((sum, project) => sum + project.inReview, 0),
      doneThisWeek,
    },
    active,
    quiet: live
      .filter((project) => !byProject.has(key(project.environmentId, project.id)))
      .map((project) => ({ environmentId: project.environmentId, projectId: project.id })),
  };
}
