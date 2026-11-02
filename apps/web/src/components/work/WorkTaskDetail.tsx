import {
  asProjectTeamRecord,
  asProjectWorkTaskContext,
  type ProjectWorkScope,
} from "@t3tools/client-runtime/project-work";
import type {
  ProjectTeamRecordRead,
  ProjectWorkTaskId,
  ProjectWorkTaskRead,
} from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  ListChecksIcon,
  ShieldCheckIcon,
  ShieldIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { RelativeTime } from "../RelativeTime";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkApprovalRow } from "./WorkApprovalRow";
import { WorkFormStatus, WorkMeta, WorkRevision, WorkTime } from "./WorkLayout";
import { WorkNotice, WorkRecordsNotice } from "./WorkNotice";
import { WorkTaskActivity } from "./WorkTaskActivity";
import { WorkTaskAssignee } from "./WorkTaskAssignee";
import { WorkTaskControls } from "./WorkTaskControls";
import { WorkTaskDelivery } from "./WorkTaskDelivery";
import { WorkTaskMemory } from "./WorkTaskMemory";
import { WorkTaskReview } from "./WorkTaskReview";
import { WorkTaskTeam } from "./WorkTaskTeam";
import { WorkTaskRelationships } from "./WorkTaskRelationships";
import { WorkTaskPlan, WorkTaskScope } from "./WorkTaskScope";
import { useWorkRead, workWriteBlockedReason } from "./useWorkRead";
import { useWorkRecords, workRecordsBlockedReason } from "./useWorkRecords";
import { useWorkTeamRoster } from "./useWorkTeamRoster";
import type { WorkWriter } from "./useWorkWriter";
import { WorkStatus } from "./WorkStatus";
import { deriveWorkTask, workStateLabel, workStateVariant } from "./workModel";
import type { WorkTaskSurface } from "./workTaskSurface";

/** Focused detail for one task: approvals first, then scope, plan, links, steering and notes. */
export function WorkTaskDetail({
  scope,
  taskId,
  writer,
  onOpenTask,
  onBack,
}: {
  readonly scope: ProjectWorkScope;
  readonly taskId: ProjectWorkTaskId;
  readonly writer: WorkWriter;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
  readonly onBack: () => void;
}) {
  const contextView = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "task-context",
    taskId,
  });
  // Membership and current gates may sit anywhere in a task's history, so the
  // whole task-filtered set must load at one revision before the kind is known.
  const records = useWorkRecords(scope.environmentId, {
    projectId: scope.projectId,
    operation: "foundation-records",
    taskId,
  });
  const context = asProjectWorkTaskContext(contextView.value);
  const owned =
    context !== null &&
    context.projectId === scope.projectId &&
    context.task.taskId === taskId &&
    context.task.projectId === scope.projectId;

  const back = (
    <Button size="xs" variant="ghost" className="self-start @3xl/work:hidden" onClick={onBack}>
      <ArrowLeftIcon /> All tasks
    </Button>
  );

  if (!owned) {
    return (
      <div className="flex min-w-0 flex-col gap-3">
        {back}
        <WorkNotice view={contextView} subject="this task" />
        {contextView.status === "ready" && context === null ? (
          <WorkMeta>This task isn't in this project, or it was removed.</WorkMeta>
        ) : null}
      </div>
    );
  }

  const task = context.task;
  const header = (
    <header className="flex min-w-0 flex-col gap-1.5">
      <h2
        id={`work-task-${taskId}`}
        className="text-xl leading-7 font-semibold tracking-tight break-words"
      >
        {task.title}
      </h2>
      {task.summary ? (
        <p className="max-w-3xl text-sm whitespace-pre-wrap break-words text-muted-foreground">
          {task.summary}
        </p>
      ) : null}
    </header>
  );

  if (!records.complete) {
    // Without every team record the task could be guided or simple; show nothing that guesses.
    return (
      <article aria-labelledby={`work-task-${taskId}`} className="flex min-w-0 flex-col gap-4">
        {back}
        <WorkStatus state={task.state} />
        {header}
        <WorkMeta>
          Updated <WorkTime value={task.updatedAt} />
        </WorkMeta>
        <WorkNotice view={contextView} subject="this task" />
        <WorkRecordsNotice set={records} subject="this task's team records" />
        <WorkFormStatus
          tone="muted"
          message="Approvals and controls appear once Work knows whether this task is guided."
        />
      </article>
    );
  }

  const teamRecords = records.records.flatMap((value): ProjectTeamRecordRead[] => {
    const record = asProjectTeamRecord(value);
    return record === null ? [] : [record];
  });
  const model = deriveWorkTask({
    context,
    records: teamRecords,
    recordsRevision: records.revision,
  });
  const surface: WorkTaskSurface = {
    scope,
    current: { ...scope, taskId, revision: context.revision, taskRevision: task.revision },
    context,
    model,
    records: teamRecords,
    writer,
    blocked:
      workWriteBlockedReason(contextView, writer.canWrite) ??
      workRecordsBlockedReason(records, "team records") ??
      (records.revision === context.revision
        ? null
        : "Team records are catching up with this task."),
  };

  const kind = model.guided
    ? model.membership
      ? `Guided · ${workStateLabel(model.membership.deliverableKind)}`
      : "Guided"
    : "Simple";
  // Wide: a reading column beside a details rail, like an issue page. Narrow: details, then the
  // sections, then the team and controls, in that DOM order.
  return (
    <article
      aria-labelledby={`work-task-${taskId}`}
      className="mx-auto grid w-full max-w-6xl min-w-0 items-start gap-x-8 gap-y-5 @3xl/work:grid-cols-[minmax(0,1fr)_17rem] @3xl/work:grid-rows-[auto_auto_1fr]"
    >
      <div className="flex min-w-0 flex-col gap-2 @3xl/work:col-span-2">
        {back}
        <div className="flex flex-wrap items-center gap-2">
          <WorkStatus state={task.state} />
          <Badge variant="outline">{kind}</Badge>
          {model.controlState !== "active" ? (
            <Badge variant={workStateVariant(model.controlState)}>
              {workStateLabel(model.controlState)}
            </Badge>
          ) : null}
        </div>
        {header}
      </div>
      <div className="min-w-0 @3xl/work:col-start-2 @3xl/work:row-start-2">
        <WorkTaskProperties
          scope={scope}
          task={task}
          kind={kind}
          projectRevision={context.revision}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-5 @3xl/work:col-start-1 @3xl/work:row-span-2 @3xl/work:row-start-2">
        <WorkNotice view={contextView} subject="this task" />
        <WorkRecordsNotice set={records} subject="this task's team records" />
        <WorkApprovalRow surface={surface} />
        <WorkTaskScope surface={surface} />
        {model.guided ? <WorkTaskPlan surface={surface} onOpenTask={onOpenTask} /> : null}
        <WorkTaskRelationships surface={surface} onOpenTask={onOpenTask} />
        <WorkTaskReview surface={surface} />
        <WorkTaskDelivery surface={surface} />
        <WorkTaskMemory surface={surface} />
        <WorkTaskActivity surface={surface} />
      </div>
      <div className="flex min-w-0 flex-col gap-5 @3xl/work:col-start-2 @3xl/work:row-start-3">
        <WorkTaskTeam surface={surface} />
        <WorkTaskControls surface={surface} />
      </div>
    </article>
  );
}

function PropertyRow(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2 px-3 py-1.5 text-xs">
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="m-0 flex min-w-0 items-center gap-1.5">{props.children}</dd>
    </div>
  );
}

function WhenValue(props: { readonly value: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="min-w-0 truncate tabular-nums" />}>
        <RelativeTime timestamp={props.value} />
      </TooltipTrigger>
      <TooltipPopup>
        <WorkTime value={props.value} />
      </TooltipPopup>
    </Tooltip>
  );
}

/** The task's facts at a glance: who, where it stands, and when it changed. */
function WorkTaskProperties(props: {
  readonly scope: ProjectWorkScope;
  readonly task: ProjectWorkTaskRead;
  readonly kind: string;
  readonly projectRevision: number;
}) {
  const { task } = props;
  const { roster } = useWorkTeamRoster(props.scope);
  const worker = roster.find((member) => member.taskId === task.taskId);
  const criteria = task.specification?.criterionIds.length ?? 0;
  const approved = task.approval !== undefined && task.approval.specRevision === task.specRevision;
  const watchers = task.watchers.flatMap((watcher) =>
    watcher.displayName ? [watcher.displayName] : [],
  );
  return (
    <section
      aria-label="Task details"
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-card/40 py-1.5"
    >
      <dl className="m-0 flex min-w-0 flex-col">
        <PropertyRow label="Status">
          <WorkStatus state={task.state} />
        </PropertyRow>
        <PropertyRow label="Assignee">
          <WorkTaskAssignee task={task} worker={worker} />
        </PropertyRow>
        <PropertyRow label="Type">
          <span className="truncate">{props.kind}</span>
        </PropertyRow>
        <PropertyRow label="Approval">
          {approved ? (
            <Badge size="sm" variant="success">
              <ShieldCheckIcon aria-hidden="true" />
              Approved
            </Badge>
          ) : task.specification ? (
            <Badge size="sm" variant="warning">
              <ShieldIcon aria-hidden="true" />
              Waiting
            </Badge>
          ) : (
            <span className="text-muted-foreground">No scope yet</span>
          )}
        </PropertyRow>
        <PropertyRow label="Criteria">
          {criteria > 0 ? (
            <span className="flex items-center gap-1.5">
              <ListChecksIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
              {criteria}
            </span>
          ) : (
            <span className="text-muted-foreground">None</span>
          )}
        </PropertyRow>
        <PropertyRow label="Watchers">
          {task.watchers.length === 0 ? (
            <span className="text-muted-foreground">None</span>
          ) : (
            <span className="truncate">
              {watchers.length > 0 ? watchers.join(", ") : task.watchers.length}
            </span>
          )}
        </PropertyRow>
        {task.failureKind ? (
          <PropertyRow label="Failure">
            <Badge size="sm" variant="error">
              <CircleAlertIcon aria-hidden="true" />
              {workStateLabel(task.failureKind)}
            </Badge>
          </PropertyRow>
        ) : null}
        {task.blockerId ? (
          <PropertyRow label="Blocker">
            <WorkStatus state="blocked" label="Open blocker" />
          </PropertyRow>
        ) : null}
      </dl>
      <div className="mx-3 my-1.5 border-t border-border/50" />
      <dl className="m-0 flex min-w-0 flex-col">
        <PropertyRow label="Created">
          <WhenValue value={task.createdAt} />
        </PropertyRow>
        <PropertyRow label="Updated">
          <WhenValue value={task.updatedAt} />
        </PropertyRow>
        {task.completedAt ? (
          <PropertyRow label="Completed">
            <WhenValue value={task.completedAt} />
          </PropertyRow>
        ) : null}
        {task.canceledAt ? (
          <PropertyRow label="Canceled">
            <WhenValue value={task.canceledAt} />
          </PropertyRow>
        ) : null}
        <PropertyRow label="Revision">
          <span className="truncate text-muted-foreground">
            task <WorkRevision>r{task.revision}</WorkRevision> · project{" "}
            <WorkRevision>r{props.projectRevision}</WorkRevision>
          </span>
        </PropertyRow>
      </dl>
    </section>
  );
}
