import {
  asProjectWorkTask,
  type ProjectWorkScope,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import { ProjectWorkTaskId, type ProjectWorkTaskRead } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ChevronRightIcon, ListFilterIcon, ListTodoIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn, randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { SettingsGroup } from "../settings/SettingsGroup";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkEmpty, WorkField, WorkFormStatus, WorkMeta, WorkRow, WorkTime } from "./WorkLayout";
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
type TaskCounts = Partial<Record<TaskFilter | "total", number>>;

// Grouped by what the task needs from you; a state from a newer server waits in Up next.
const TASK_GROUPS = [
  { id: "needs-you", label: "Needs you", states: ["in-review", "blocked", "failed"] },
  { id: "running", label: "Running", states: ["in-progress"] },
  { id: "up-next", label: "Up next", states: ["ready", "specified", "draft"] },
  { id: "done", label: "Done", states: ["completed", "canceled"] },
] as const;
type TaskGroup = (typeof TASK_GROUPS)[number];
const taskGroupOf = (state: string): TaskGroup =>
  TASK_GROUPS.find((group) => (group.states as ReadonlyArray<string>).includes(state)) ??
  TASK_GROUPS[2];

const COLLAPSED_GROUPS_KEY = "t3code:work:collapsed-task-groups";
const GroupIds = Schema.Array(Schema.String);
const DEFAULT_COLLAPSED_GROUPS: ReadonlyArray<string> = ["done"];

export function WorkTasks({
  scope,
  writer,
  taskId,
  onSelectTask,
  fullscreen,
}: {
  readonly scope: ProjectWorkScope;
  readonly writer: WorkWriter;
  readonly taskId: ProjectWorkTaskId | undefined;
  readonly onSelectTask: (taskId: ProjectWorkTaskId | undefined, title?: string) => void;
  /** The panel's full screen control, shown with the list's own actions. */
  readonly fullscreen?: ReactNode;
}) {
  const [filter, setFilter] = useState<TaskFilter>("all");
  const view = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "supervision",
  });
  const rawSummary = view.special?.operation === "supervision" ? view.special.value : null;
  const counts: TaskCounts | null =
    view.status === "ready" && rawSummary?.availability === "available"
      ? rawSummary.taskCounts
      : null;
  if (taskId !== undefined) {
    return (
      <WorkTaskDetail
        key={taskId}
        scope={scope}
        taskId={taskId}
        writer={writer}
        onOpenTask={onSelectTask}
        onBack={() => onSelectTask(undefined)}
      />
    );
  }
  return (
    <TaskList
      key={filter}
      scope={scope}
      writer={writer}
      filter={filter}
      counts={counts}
      fullscreen={fullscreen}
      onFilterChange={setFilter}
      onSelectTask={onSelectTask}
    />
  );
}

function TaskFilterMenu(props: {
  readonly filter: TaskFilter;
  readonly counts: TaskCounts | null;
  readonly onFilterChange: (filter: TaskFilter) => void;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant={props.filter === "all" ? "ghost" : "secondary"}
                  aria-label="Filter tasks"
                />
              }
            />
          }
        >
          <ListFilterIcon />
        </TooltipTrigger>
        <TooltipPopup>Filter tasks</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="min-w-52">
        <MenuRadioGroup
          value={props.filter}
          onValueChange={(value) => {
            const next = TASK_FILTERS.find((candidate) => candidate === value);
            if (next) props.onFilterChange(next);
          }}
        >
          {TASK_FILTERS.map((state) => {
            const count = props.counts?.[state === "all" ? "total" : state];
            if (count === 0 && state !== "all" && state !== props.filter) return null;
            const label = state === "all" ? "All tasks" : workStateLabel(state);
            return (
              <MenuRadioItem
                key={state}
                value={state}
                closeOnClick
                aria-label={`${label}${count === undefined ? "" : ` ${count}`}`}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {state === "all" ? (
                    <ListTodoIcon aria-hidden="true" className="size-3.5" />
                  ) : (
                    <WorkStatusGlyph state={state} />
                  )}
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {count === undefined ? null : (
                    <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
                  )}
                </span>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function TaskList({
  scope,
  writer,
  filter,
  counts,
  fullscreen,
  onFilterChange,
  onSelectTask,
}: {
  scope: ProjectWorkScope;
  writer: WorkWriter;
  filter: TaskFilter;
  counts: TaskCounts | null;
  fullscreen: ReactNode;
  onFilterChange: (filter: TaskFilter) => void;
  onSelectTask: (id: ProjectWorkTaskId, title?: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useLocalStorage(
    COLLAPSED_GROUPS_KEY,
    DEFAULT_COLLAPSED_GROUPS,
    GroupIds,
  );
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
  const groups = TASK_GROUPS.map((group) => ({
    ...group,
    tasks: tasks.filter((task) => taskGroupOf(task.state).id === group.id),
    count:
      counts === null || filter !== "all"
        ? undefined
        : group.states.reduce((sum, state) => sum + (counts[state] ?? 0), 0),
  }));
  const hasGroups = groups.some((group) => group.tasks.length > 0 || (group.count ?? 0) > 0);
  const toggleGroup = (id: string) =>
    setCollapsedGroups((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  const total = filter === "all" ? counts?.total : counts?.[filter];
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-h-7 items-center gap-2 px-1">
        <h2 className="m-0 min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {filter === "all" ? "Tasks" : `${workStateLabel(filter)} tasks`}
          {total === undefined ? null : (
            <span className="ms-1.5 text-xs font-normal tabular-nums text-muted-foreground">
              {total}
            </span>
          )}
        </h2>
        <TaskFilterMenu filter={filter} counts={counts} onFilterChange={onFilterChange} />
        {fullscreen}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                aria-label="New task"
                disabled={creating || createBlocked !== null}
                onClick={() => setCreating(true)}
              />
            }
          >
            <PlusIcon />
          </TooltipTrigger>
          <TooltipPopup>{createBlocked ?? "New task"}</TooltipPopup>
        </Tooltip>
      </div>
      {creating && view.page ? (
        <SettingsGroup>
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
        </SettingsGroup>
      ) : null}
      {view.status !== "ready" ? (
        <SettingsGroup>
          <WorkRow>
            <WorkNotice view={view} subject="tasks" />
          </WorkRow>
        </SettingsGroup>
      ) : null}
      {view.page !== null && view.page.items.length === 0 ? (
        <SettingsGroup>
          <WorkRow>
            <WorkEmpty
              title={
                filter === "all"
                  ? "No tasks yet"
                  : `No ${workStateLabel(filter).toLowerCase()} tasks`
              }
              detail={
                filter === "all"
                  ? "Start with a title. Scope, plan and approvals come next."
                  : "Try another status to find work."
              }
            />
            {filter !== "all" ? (
              <Button size="sm" variant="ghost" onClick={() => onFilterChange("all")}>
                Show all tasks
              </Button>
            ) : null}
          </WorkRow>
        </SettingsGroup>
      ) : null}
      {hasGroups ? (
        // One structure: a sectioned list while narrow, a board of columns once the panel is wide.
        <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card/20 @3xl/work:grid @3xl/work:grid-cols-2 @3xl/work:items-start @3xl/work:gap-3 @3xl/work:overflow-visible @3xl/work:rounded-none @3xl/work:border-0 @3xl/work:bg-transparent @4xl/work:grid-cols-4">
          {groups.map((group) => {
            const collapsed = collapsedGroups.includes(group.id);
            const empty = group.tasks.length === 0 && (group.count ?? 0) === 0;
            return (
              <section
                key={group.id}
                aria-label={group.label}
                // Empty groups stay out of the list but keep their board column.
                className={cn(
                  "-mt-px flex min-w-0 flex-col border-t border-border/70 @3xl/work:mt-0 @3xl/work:gap-2 @3xl/work:rounded-xl @3xl/work:border @3xl/work:bg-card/30 @3xl/work:p-2",
                  empty && "hidden @3xl/work:flex",
                )}
              >
                <button
                  type="button"
                  aria-expanded={!collapsed}
                  onClick={() => toggleGroup(group.id)}
                  className={cn(
                    "flex w-full items-center gap-1.5 px-4 py-2 text-left text-xs font-medium outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @3xl/work:pointer-events-none @3xl/work:px-1.5 @3xl/work:py-0.5",
                    group.id === "needs-you" ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  <ChevronRightIcon
                    aria-hidden="true"
                    className={cn("size-3 shrink-0 @3xl/work:hidden", !collapsed && "rotate-90")}
                  />
                  <span className="flex-1">{group.label}</span>
                  <span className="tabular-nums">{group.count ?? group.tasks.length}</span>
                </button>
                <div
                  className={cn(
                    "flex min-w-0 flex-col @3xl/work:gap-2",
                    collapsed && "hidden @3xl/work:flex",
                  )}
                >
                  {group.tasks.map((task) => (
                    <TaskItem key={task.taskId} task={task} onSelectTask={onSelectTask} />
                  ))}
                  {empty ? (
                    <span className="px-1.5 pb-1 text-xs text-muted-foreground/70">No tasks</span>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      ) : null}
      {unknown > 0 ? (
        <WorkMeta>{unknown} records from a newer server can't be shown here.</WorkMeta>
      ) : null}
      <WorkPager pager={pager} noun="Tasks" />
    </div>
  );
}

function TaskMeta({ task }: { readonly task: ProjectWorkTaskRead }) {
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
      <span>{workStateLabel(task.state)}</span>
      <span aria-hidden="true">·</span>
      <WorkTime value={task.updatedAt} />
    </span>
  );
}

function TaskItem(props: {
  readonly task: ProjectWorkTaskRead;
  readonly onSelectTask: (id: ProjectWorkTaskId, title?: string) => void;
}) {
  const { task } = props;
  return (
    <button
      type="button"
      onClick={() => props.onSelectTask(task.taskId, task.title)}
      className="flex w-full min-w-0 items-start gap-3 border-t border-border/50 px-4 py-3 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @3xl/work:gap-2.5 @3xl/work:rounded-lg @3xl/work:border @3xl/work:border-border/70 @3xl/work:bg-card @3xl/work:px-3 @3xl/work:py-2.5"
    >
      <span className="pt-0.5">
        <WorkStatusGlyph state={task.state} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="line-clamp-2 text-sm font-medium break-words @3xl/work:line-clamp-3">
          {task.title}
        </span>
        <TaskMeta task={task} />
      </span>
    </button>
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
