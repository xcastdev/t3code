import {
  asProjectWorkTask,
  type ProjectWorkScope,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import { ProjectWorkTaskId, type ProjectWorkTaskRead } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { cn, randomUUID } from "../../lib/utils";
import { Badge } from "../ui/badge";
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
  WorkRevision,
  WorkRow,
  WorkSection,
} from "./WorkLayout";
import { WorkNotice, WorkPager } from "./WorkNotice";
import { WorkTaskDetail } from "./WorkTaskDetail";
import { WORK_PAGE_SIZE, workWriteBlockedReason } from "./useWorkRead";
import { useWorkPage } from "./useWorkRecords";
import type { WorkWriter } from "./useWorkWriter";
import { workStateLabel, workStateVariant } from "./workModel";
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

export function WorkTasks({
  scope,
  writer,
  taskId,
  onSelectTask,
}: {
  readonly scope: ProjectWorkScope;
  readonly writer: WorkWriter;
  readonly taskId: ProjectWorkTaskId | undefined;
  readonly onSelectTask: (taskId: ProjectWorkTaskId | undefined) => void;
}) {
  const [creating, setCreating] = useState(false);
  const pager = useWorkPage(
    scope.environmentId,
    { projectId: scope.projectId, operation: "tasks" },
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
    <div className="grid min-w-0 gap-5 @3xl/work:grid-cols-[minmax(15rem,19rem)_minmax(0,1fr)]">
      <div
        className={cn(
          "flex min-w-0 flex-col gap-3",
          taskId !== undefined && "hidden @3xl/work:flex",
        )}
      >
        <WorkSection
          title="Tasks"
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
              onCreated={(created) => {
                setCreating(false);
                onSelectTask(created);
              }}
            />
          ) : null}
          {view.status !== "ready" ? (
            <WorkRow>
              <WorkNotice view={view} subject="tasks" />
            </WorkRow>
          ) : null}
          {pager.offset === 0 && view.page !== null && view.page.items.length === 0 ? (
            <WorkEmpty
              title="No tasks yet"
              detail="Start with a title. Scope, plan and approvals come next."
            />
          ) : null}
          {tasks.map((task) => (
            <TaskRow
              key={task.taskId}
              task={task}
              selected={task.taskId === taskId}
              onSelect={() => onSelectTask(task.taskId)}
            />
          ))}
          {unknown > 0 ? (
            <WorkRow>
              <WorkMeta>{unknown} records from a newer server can't be shown here.</WorkMeta>
            </WorkRow>
          ) : null}
          <WorkPager pager={pager} noun="Tasks" />
        </WorkSection>
      </div>
      <div className={cn("min-w-0", taskId === undefined && "hidden @3xl/work:block")}>
        {taskId === undefined ? (
          <WorkEmpty
            title="Select a task"
            detail="Open a task to review its scope, plan and approvals."
          />
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
  );
}

function TaskRow({
  task,
  selected,
  onSelect,
}: {
  readonly task: ProjectWorkTaskRead;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const approval =
    task.specification === undefined
      ? null
      : task.approval?.specRevision === task.specRevision
        ? "approved"
        : null;
  return (
    // A semantic row, not a styled control: the whole row opens the task.
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 flex-col gap-1 px-3 py-2.5 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4",
        selected && "bg-accent/60",
      )}
    >
      <span className="line-clamp-2 text-sm font-medium break-words">{task.title}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge size="sm" variant={workStateVariant(task.state)}>
          {workStateLabel(task.state)}
        </Badge>
        {approval ? (
          <Badge size="sm" variant="success">
            Scope approved
          </Badge>
        ) : null}
        <WorkRevision className="text-muted-foreground">r{task.revision}</WorkRevision>
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
