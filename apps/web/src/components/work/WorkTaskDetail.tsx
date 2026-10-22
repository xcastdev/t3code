import {
  asProjectTeamRecord,
  asProjectWorkTaskContext,
  type ProjectWorkScope,
} from "@t3tools/client-runtime/project-work";
import type { ProjectTeamRecordRead, ProjectWorkTaskId } from "@t3tools/contracts";
import { ArrowLeftIcon } from "lucide-react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { WorkApprovalRow } from "./WorkApprovalRow";
import { WorkFormStatus, WorkMeta, WorkRevision } from "./WorkLayout";
import { WorkNotice, WorkRecordsNotice } from "./WorkNotice";
import { WorkTaskActivity } from "./WorkTaskActivity";
import { WorkTaskControls } from "./WorkTaskControls";
import { WorkTaskDelivery } from "./WorkTaskDelivery";
import { WorkTaskMemory } from "./WorkTaskMemory";
import { WorkTaskReview } from "./WorkTaskReview";
import { WorkTaskTeam } from "./WorkTaskTeam";
import { WorkTaskRelationships } from "./WorkTaskRelationships";
import { WorkTaskPlan, WorkTaskScope } from "./WorkTaskScope";
import { useWorkRead, workWriteBlockedReason } from "./useWorkRead";
import { useWorkRecords, workRecordsBlockedReason } from "./useWorkRecords";
import type { WorkWriter } from "./useWorkWriter";
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
    <header className="flex flex-col gap-1.5">
      <h2 id={`work-task-${taskId}`} className="text-lg font-semibold tracking-tight break-words">
        {task.title}
      </h2>
      {task.summary ? (
        <p className="text-sm whitespace-pre-wrap break-words text-muted-foreground">
          {task.summary}
        </p>
      ) : null}
      <WorkMeta>
        Task <WorkRevision>r{task.revision}</WorkRevision> · project{" "}
        <WorkRevision>r{context.revision}</WorkRevision> ·{" "}
        <span className="break-all">{scope.checkoutPath}</span>
      </WorkMeta>
    </header>
  );

  if (!records.complete) {
    // Without every team record the task could be guided or simple; show nothing that guesses.
    return (
      <article aria-labelledby={`work-task-${taskId}`} className="flex min-w-0 flex-col gap-4">
        {back}
        <Badge variant={workStateVariant(task.state)} className="self-start">
          {workStateLabel(task.state)}
        </Badge>
        {header}
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

  return (
    <article aria-labelledby={`work-task-${taskId}`} className="flex min-w-0 flex-col gap-5">
      {back}
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={workStateVariant(task.state)}>{workStateLabel(task.state)}</Badge>
          <Badge variant="outline">
            {model.guided
              ? model.membership
                ? `Guided · ${workStateLabel(model.membership.deliverableKind)}`
                : "Guided"
              : "Simple"}
          </Badge>
          {model.controlState !== "active" ? (
            <Badge variant={workStateVariant(model.controlState)}>
              {workStateLabel(model.controlState)}
            </Badge>
          ) : null}
        </div>
        {header}
      </div>
      <WorkNotice view={contextView} subject="this task" />
      <WorkRecordsNotice set={records} subject="this task's team records" />
      <WorkApprovalRow surface={surface} />
      <WorkTaskScope surface={surface} />
      {model.guided ? <WorkTaskPlan surface={surface} onOpenTask={onOpenTask} /> : null}
      <WorkTaskRelationships surface={surface} onOpenTask={onOpenTask} />
      <WorkTaskTeam surface={surface} />
      <WorkTaskReview surface={surface} />
      <WorkTaskDelivery surface={surface} />
      <WorkTaskMemory surface={surface} />
      <WorkTaskControls surface={surface} />
      <WorkTaskActivity surface={surface} />
    </article>
  );
}
