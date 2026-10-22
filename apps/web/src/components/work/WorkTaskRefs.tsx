import { asProjectWorkTask, type ProjectWorkScope } from "@t3tools/client-runtime/project-work";
import type { ProjectWorkTaskId, ProjectWorkTaskRead } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { useWorkRead } from "./useWorkRead";
import { useWorkPage } from "./useWorkRecords";
import { WorkMeta, WorkRevision } from "./WorkLayout";
import { WorkNotice, WorkPager } from "./WorkNotice";
import { workStateLabel, workStateVariant } from "./workModel";

const NO_TASKS: ReadonlyArray<ProjectWorkTaskId> = [];
const rowClass =
  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60";

/** A task named by ID elsewhere (relationship, dependency, mission), opened in this project. */
export function WorkTaskLink({
  scope,
  taskId,
  prefix,
  onOpen,
}: {
  readonly scope: ProjectWorkScope;
  readonly taskId: ProjectWorkTaskId;
  readonly prefix?: string;
  readonly onOpen: (taskId: ProjectWorkTaskId) => void;
}) {
  const view = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "task",
    taskId,
  });
  const task = asProjectWorkTask(view.value);
  const known = task !== null && task.taskId === taskId && task.projectId === scope.projectId;
  return (
    // A semantic row: the whole line opens the referenced task.
    <button type="button" className={rowClass} onClick={() => onOpen(taskId)}>
      {prefix ? <span className="shrink-0 text-muted-foreground">{prefix}</span> : null}
      <span className="min-w-0 flex-1 truncate">
        {known
          ? task.title
          : view.status === "loading"
            ? "Loading task…"
            : view.error
              ? "Task unavailable"
              : `Task ${taskId.slice(0, 8)}`}
      </span>
      {known ? (
        <Badge size="sm" variant={workStateVariant(task.state)}>
          {workStateLabel(task.state)}
        </Badge>
      ) : null}
    </button>
  );
}

/** Bounded, pageable task choice for linking, dependencies and intake targets. */
export function WorkTaskPicker({
  scope,
  label,
  selectedTaskId,
  excludeTaskIds = NO_TASKS,
  onSelect,
}: {
  readonly scope: ProjectWorkScope;
  readonly label: string;
  readonly selectedTaskId: ProjectWorkTaskId | null;
  readonly excludeTaskIds?: ReadonlyArray<ProjectWorkTaskId>;
  readonly onSelect: (task: ProjectWorkTaskRead) => void;
}) {
  const pager = useWorkPage(
    scope.environmentId,
    { projectId: scope.projectId, operation: "tasks" },
    16,
  );
  const tasks = (pager.view.page?.items ?? []).flatMap((item): ProjectWorkTaskRead[] => {
    const task = asProjectWorkTask(item.value);
    return task === null || task.projectId !== scope.projectId ? [] : [task];
  });
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-col gap-0.5 rounded-lg border border-border/60 p-1"
    >
      <WorkNotice view={pager.view} subject="tasks" />
      {tasks.map((task) => {
        const excluded = excludeTaskIds.includes(task.taskId);
        const selected = task.taskId === selectedTaskId;
        return (
          <button
            key={task.taskId}
            type="button"
            aria-pressed={selected}
            disabled={excluded}
            className={cn(rowClass, selected && "bg-accent/60")}
            onClick={() => onSelect(task)}
          >
            <CheckIcon className={cn("size-3.5 shrink-0", !selected && "invisible")} />
            <span className="min-w-0 flex-1 truncate">{task.title}</span>
            <WorkRevision className="text-muted-foreground">r{task.revision}</WorkRevision>
          </button>
        );
      })}
      {pager.view.page !== null && tasks.length === 0 ? (
        <WorkMeta className="px-2 py-1.5">No tasks here.</WorkMeta>
      ) : null}
      <WorkPager pager={pager} noun="Tasks" />
    </div>
  );
}
