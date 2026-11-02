import {
  asProjectWorkTask,
  type ProjectWorkScope,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import { ProjectWorkTaskId, type ProjectWorkTaskRead } from "@t3tools/contracts";
import { PlusIcon, ListTodoIcon } from "lucide-react";
import { useState } from "react";

import { cn, randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  WorkEmpty,
  WorkField,
  WorkFormStatus,
  WorkMeta,
  WorkRow,
  WorkSection,
  WorkTime,
} from "./WorkLayout";
import { WorkNotice, WorkPager } from "./WorkNotice";
import { WorkTaskDetail } from "./WorkTaskDetail";
import { useWorkRead, WORK_PAGE_SIZE, workWriteBlockedReason } from "./useWorkRead";
import { useWorkPage } from "./useWorkRecords";
import type { WorkWriter } from "./useWorkWriter";
import { workStateLabel } from "./workModel";
import { WorkStatusGlyph } from "./WorkStatus";
import { newCommandId } from "./workTaskSurface";

const DELIVERABLES = {
  code: "Code change",
  research: "Research",
  plan: "Plan",
  review: "Review",
  "non-code": "Other deliverable",
  reminder: "Reminder",
} as const;
type Deliverable = keyof typeof DELIVERABLES;

const TASK_FILTERS = [
  "all",
  "in-progress",
  "in-review",
  "blocked",
  "failed",
  "ready",
  "specified",
  "draft",
  "completed",
  "canceled",
] as const;
type TaskFilter = (typeof TASK_FILTERS)[number];

export function WorkTasks({
  scope,
  writer,
  taskId,
  onSelectTask,
}: {
  readonly scope: ProjectWorkScope;
  readonly writer: WorkWriter;
  readonly taskId: ProjectWorkTaskId | undefined;
  readonly onSelectTask: (taskId: ProjectWorkTaskId | undefined, title?: string) => void;
}) {
  const [filter, setFilter] = useState<TaskFilter>("all");
  const view = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "supervision",
  });
  const rawSummary = view.special?.operation === "supervision" ? view.special.value : null;
  const summary =
    view.status === "ready" && rawSummary?.availability === "available" ? rawSummary : null;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div
        className={cn(
          "max-w-full overflow-x-auto pb-1",
          taskId !== undefined && "hidden @3xl/work:block",
        )}
      >
        <ToggleGroup
          aria-label="Filter tasks by status"
          value={[filter]}
          onValueChange={(next) => {
            const value = TASK_FILTERS.find((f) => f === next[0]);
            if (value) setFilter(value);
          }}
        >
          {TASK_FILTERS.map((state) => {
            const count =
              summary === null
                ? undefined
                : state === "all"
                  ? summary.taskCounts.total
                  : summary.taskCounts[state];
            if (count === 0 && state !== "all" && state !== filter) return null;
            return (
              <Toggle
                key={state}
                value={state}
                aria-label={`${state === "all" ? "All" : workStateLabel(state)}${count === undefined ? "" : ` ${count}`}`}
              >
                {state === "all" ? (
                  <ListTodoIcon aria-hidden="true" />
                ) : (
                  <WorkStatusGlyph state={state} />
                )}
                {state === "all" ? "All" : workStateLabel(state)}
                {count === undefined ? null : (
                  <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
                )}
              </Toggle>
            );
          })}
        </ToggleGroup>
      </div>
      <div className="grid min-w-0 items-start gap-6 @3xl/work:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)]">
        <div className={cn("min-w-0", taskId !== undefined && "hidden @3xl/work:block")}>
          <TaskList
            key={filter}
            scope={scope}
            writer={writer}
            taskId={taskId}
            filter={filter}
            onSelectTask={onSelectTask}
            onShowAll={() => setFilter("all")}
          />
        </div>
        <div className={cn("min-w-0", taskId === undefined && "hidden @3xl/work:block")}>
          {taskId === undefined ? (
            <div className="flex min-h-72 items-center justify-center rounded-xl border border-dashed border-border/70 bg-card/20">
              <WorkEmpty
                title="Your next step starts here"
                detail="Select a task to review its scope, approvals and team activity."
              />
            </div>
          ) : (
            <WorkTaskDetail
              key={taskId}
              scope={scope}
              taskId={taskId}
              writer={writer}
              onOpenTask={onSelectTask}
              onBack={() => onSelectTask(undefined)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function TaskList({
  scope,
  writer,
  taskId,
  filter,
  onSelectTask,
  onShowAll,
}: {
  scope: ProjectWorkScope;
  writer: WorkWriter;
  taskId: ProjectWorkTaskId | undefined;
  filter: TaskFilter;
  onSelectTask: (id: ProjectWorkTaskId, title?: string) => void;
  onShowAll: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const pager = useWorkPage(
    scope.environmentId,
    {
      projectId: scope.projectId,
      operation: "tasks",
      ...(filter === "all" ? {} : { state: filter }),
    },
    WORK_PAGE_SIZE,
  );
  const view = pager.view;
  const createBlocked = workWriteBlockedReason(view, writer.canWrite);
  const tasks = (view.page?.items ?? []).flatMap((item): ProjectWorkTaskRead[] => {
    const task = asProjectWorkTask(item.value);
    return task === null || task.projectId !== scope.projectId ? [] : [task];
  });
  const unknown = (view.page?.items.length ?? 0) - tasks.length;
  return (
    <WorkSection
      title={filter === "all" ? "Tasks" : `${workStateLabel(filter)} tasks`}
      actions={
        creating ? null : (
          <Button
            size="xs"
            disabled={createBlocked !== null}
            title={createBlocked ?? undefined}
            onClick={() => setCreating(true)}
          >
            <PlusIcon /> New task
          </Button>
        )
      }
    >
      {creating && view.page ? (
        <NewTaskForm
          scope={scope}
          writer={writer}
          selection={{ ...scope, revision: view.page.revision, taskRevision: 0 }}
          blocked={createBlocked}
          onCancel={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            onSelectTask(id);
          }}
        />
      ) : null}
      {view.status !== "ready" ? (
        <WorkRow>
          <WorkNotice view={view} subject="tasks" />
        </WorkRow>
      ) : null}
      {view.page !== null && view.page.items.length === 0 ? (
        <WorkRow>
          <WorkEmpty
            title={
              filter === "all" ? "No tasks yet" : `No ${workStateLabel(filter).toLowerCase()} tasks`
            }
            detail={
              filter === "all"
                ? "Start with a title. Scope, plan and approvals come next."
                : "Try another status to find work."
            }
          />
          {filter !== "all" ? (
            <Button size="sm" variant="ghost" onClick={onShowAll}>
              Show all tasks
            </Button>
          ) : null}
        </WorkRow>
      ) : null}
      {tasks.map((task) => (
        <button
          key={task.taskId}
          type="button"
          aria-current={task.taskId === taskId ? "page" : undefined}
          onClick={() => onSelectTask(task.taskId, task.title)}
          className={cn(
            "flex w-full min-w-0 items-start gap-3 px-4 py-3.5 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            task.taskId === taskId && "bg-accent/60",
          )}
        >
          <span className="pt-0.5">
            <WorkStatusGlyph state={task.state} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="line-clamp-2 text-sm font-medium break-words">{task.title}</span>
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
              <span>{workStateLabel(task.state)}</span>
              <span aria-hidden="true">·</span>
              <WorkTime value={task.updatedAt} />
            </span>
          </span>
        </button>
      ))}
      {unknown > 0 ? (
        <WorkRow>
          <WorkMeta>{unknown} records from a newer server can't be shown here.</WorkMeta>
        </WorkRow>
      ) : null}
      <WorkPager pager={pager} noun="Tasks" />
    </WorkSection>
  );
}

function NewTaskForm({
  scope,
  writer,
  selection,
  blocked,
  onCancel,
  onCreated,
}: {
  readonly scope: ProjectWorkScope;
  readonly writer: WorkWriter;
  readonly selection: ProjectWorkSelection;
  readonly blocked: string | null;
  readonly onCancel: () => void;
  readonly onCreated: (taskId: ProjectWorkTaskId) => void;
}) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [mode, setMode] = useState<"guided" | "simple">("guided");
  const [deliverable, setDeliverable] = useState<Deliverable>("code");
  const key = "task:create";
  const submit = async () => {
    const taskId = ProjectWorkTaskId.make(randomUUID());
    // A new task depends on nothing the user reviewed, so it binds to the current list revision.
    const sent = await writer.submit(key, selection, selection, {
      type: "project-work.task.create",
      commandId: newCommandId(),
      projectId: scope.projectId,
      expectedRevision: selection.revision,
      taskId,
      title: title.trim(),
      ...(summary.trim() ? { summary: summary.trim() } : {}),
      ...(mode === "guided" ? { deliverableKind: deliverable } : {}),
      createdAt: new Date().toISOString(),
    });
    if (sent) onCreated(taskId);
  };
  return (
    <WorkRow className="gap-3">
      <WorkField label="Title">
        {(id) => (
          <Input
            id={id}
            maxLength={4000}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        )}
      </WorkField>
      <WorkField label="Summary (optional)">
        {(id) => (
          <Textarea
            id={id}
            size="sm"
            maxLength={32000}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
        )}
      </WorkField>
      <ToggleGroup
        aria-label="Task kind"
        value={[mode]}
        onValueChange={(next) => {
          if (next[0] === "guided" || next[0] === "simple") setMode(next[0]);
        }}
      >
        <Toggle value="guided">Guided</Toggle>
        <Toggle value="simple">Simple</Toggle>
      </ToggleGroup>
      {mode === "guided" ? (
        <WorkField
          label="Deliverable"
          hint="Guided tasks record scope and plan approvals. Approving never starts work."
        >
          {(id) => (
            <Select
              value={deliverable}
              items={DELIVERABLES}
              onValueChange={(value) => {
                if (typeof value === "string" && value in DELIVERABLES)
                  setDeliverable(value as Deliverable);
              }}
            >
              <SelectTrigger id={id}>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {Object.entries(DELIVERABLES).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
        </WorkField>
      ) : (
        <WorkMeta>Simple tasks keep a scope, criteria and one approval, without a plan.</WorkMeta>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={title.trim() === "" || blocked !== null || writer.pendingKey !== null}
          onClick={() => void submit()}
        >
          {writer.pendingKey === key ? "Creating…" : "Create task"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <WorkFormStatus message={writer.failureFor(key)} />
    </WorkRow>
  );
}
