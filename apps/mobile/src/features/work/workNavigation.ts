import type { EnvironmentId, ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";

export type WorkTabSection = "overview" | "tasks" | "knowledge" | "intake";

export interface WorkLocation {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly section: WorkTabSection;
  /** Task detail opened from the project, with the tasks visited before it for Back. */
  readonly tasks: ReadonlyArray<ProjectWorkTaskId>;
}

const TASK_HISTORY = 16;

/**
 * Opening a task inside the same checkout stacks it for Back; a task in
 * another environment or project starts a fresh location, so Back never
 * crosses into a different checkout's task.
 */
export function openWorkTask(
  location: WorkLocation | null,
  target: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly taskId: ProjectWorkTaskId;
  },
): WorkLocation {
  if (
    location === null ||
    location.environmentId !== target.environmentId ||
    location.projectId !== target.projectId
  )
    return {
      environmentId: target.environmentId,
      projectId: target.projectId,
      section: "tasks",
      tasks: [target.taskId],
    };
  if (location.tasks.at(-1) === target.taskId) return location;
  return {
    ...location,
    section: "tasks",
    tasks: [...location.tasks, target.taskId].slice(-TASK_HISTORY),
  };
}

/** One step back: the previous task, then the project, then (single pane) the list. */
export function backWorkLocation(
  location: WorkLocation | null,
  mode: "full" | "list" | "detail",
): WorkLocation | null | undefined {
  if (location === null || mode === "list") return undefined;
  if (location.tasks.length > 0) return { ...location, tasks: location.tasks.slice(0, -1) };
  return mode === "full" ? null : undefined;
}
