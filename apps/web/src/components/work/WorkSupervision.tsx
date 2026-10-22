import {
  asProjectTeamRecord,
  type ProjectWorkScope,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import type { ProjectTeamRecordRead, ProjectWorkTaskId } from "@t3tools/contracts";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  WorkEmpty,
  WorkFormStatus,
  WorkMeta,
  WorkRevision,
  WorkRow,
  WorkSection,
  WorkTime,
} from "./WorkLayout";
import { WorkNotice, WorkPager } from "./WorkNotice";
import { useWorkRead, workWriteBlockedReason } from "./useWorkRead";
import { useWorkPage } from "./useWorkRecords";
import type { WorkWriter } from "./useWorkWriter";
import {
  accountingSummary,
  bindingPhase,
  makeMessageAttentionIntent,
  messageActions,
  openMessages,
  SUPERVISION_UNAVAILABLE,
  supervisionCounts,
  type WorkMessageAction,
  type WorkMessageRecord,
} from "./workPresentation";
import { newCommandId } from "./workTaskSurface";

const COUNT_LABELS = [
  ["open", "Open"],
  ["active", "Running"],
  ["review", "In review"],
  ["blocked", "Blocked or failed"],
  ["done", "Done"],
] as const;

/** Who is working on what right now, from one bounded summary read. */
export function WorkSupervision({
  scope,
  onOpenTask,
}: {
  readonly scope: ProjectWorkScope;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const view = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "supervision",
  });
  const summary = view.special?.operation === "supervision" ? view.special.value : null;

  if (summary === null || summary.availability !== "available")
    return (
      <WorkSection title="Team activity">
        <WorkRow>
          <WorkNotice view={view} subject="team activity" />
          {summary !== null ? (
            <WorkMeta>{SUPERVISION_UNAVAILABLE[summary.availability]}</WorkMeta>
          ) : view.status === "ready" ? (
            <WorkMeta>Team activity isn't available on this environment.</WorkMeta>
          ) : null}
        </WorkRow>
      </WorkSection>
    );

  const counts = supervisionCounts(summary);
  const coordinator =
    summary.coordinator !== undefined && "name" in summary.coordinator
      ? summary.coordinator.name
      : null;

  return (
    <WorkSection
      title="Team activity"
      description={
        <>
          {coordinator ? `Coordinated by ${coordinator} · ` : ""}project{" "}
          <WorkRevision>r{summary.revision}</WorkRevision>
        </>
      }
    >
      {view.status !== "ready" ? (
        <WorkRow>
          <WorkNotice view={view} subject="team activity" />
        </WorkRow>
      ) : null}
      <WorkRow className="flex-row flex-wrap gap-x-5 gap-y-1">
        {COUNT_LABELS.map(([key, label]) => (
          <span key={key} className="text-sm">
            <span className="font-medium tabular-nums">{counts[key]}</span>{" "}
            <span className="text-muted-foreground">{label}</span>
          </span>
        ))}
        {counts.unknown > 0 ? (
          <span className="text-sm text-muted-foreground">
            <span className="tabular-nums">{counts.unknown}</span> unrecognized
          </span>
        ) : null}
      </WorkRow>
      {summary.bindings.items.length === 0 ? (
        <WorkEmpty title="No workers running" />
      ) : (
        summary.bindings.items.map((binding) => {
          if (!("taskId" in binding))
            return (
              <WorkRow key={binding.recordId}>
                <WorkMeta>A worker record this client can't read.</WorkMeta>
              </WorkRow>
            );
          const phase = bindingPhase(binding.status);
          const usage = accountingSummary(binding.accounting);
          return (
            <WorkRow key={binding.recordId} className="flex-row items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={phase.tone}>{phase.label}</Badge>
                  <span className="truncate text-sm">
                    {binding.profile && "role" in binding.profile
                      ? `${binding.profile.role} · `
                      : ""}
                    {binding.model}
                  </span>
                </div>
                {usage ? (
                  <WorkMeta className={usage.uncertain ? "text-warning-foreground" : undefined}>
                    {usage.text}
                  </WorkMeta>
                ) : null}
              </div>
              <Button
                size="xs"
                variant="outline"
                onClick={() => onOpenTask(binding.taskId as ProjectWorkTaskId)}
              >
                Open task
              </Button>
            </WorkRow>
          );
        })
      )}
      {summary.bindings.hasMore ? (
        <WorkRow>
          <WorkMeta>More workers are active than shown here.</WorkMeta>
        </WorkRow>
      ) : null}
      {summary.questions.items.map((question) =>
        "taskId" in question ? (
          <WorkRow key={question.recordId} className="flex-row items-center gap-3">
            <p className="min-w-0 flex-1 text-sm">A worker is waiting for an answer.</p>
            <Button
              size="xs"
              variant="outline"
              onClick={() => onOpenTask(question.taskId as ProjectWorkTaskId)}
            >
              Answer
            </Button>
          </WorkRow>
        ) : null,
      )}
      {summary.blockers.items.map((blocker) => (
        <WorkRow key={blocker.recordId} className="flex-row items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm break-words">{blocker.reason}</p>
            <WorkMeta>Blocked · {blocker.resolver}</WorkMeta>
          </div>
          <Button
            size="xs"
            variant="outline"
            onClick={() => onOpenTask(blocker.taskId as ProjectWorkTaskId)}
          >
            Open task
          </Button>
        </WorkRow>
      ))}
      {summary.questions.hasMore || summary.blockers.hasMore ? (
        <WorkRow>
          <WorkMeta>More questions or blockers are open than shown here.</WorkMeta>
        </WorkRow>
      ) : null}
    </WorkSection>
  );
}

const ACTION_LABEL: Record<WorkMessageAction, string> = {
  acknowledge: "Mark seen",
  resolve: "Resolve",
};

/** Messages from workers that still need a human, one page at a time. */
export function WorkInbox({
  scope,
  writer,
  onOpenTask,
}: {
  readonly scope: ProjectWorkScope;
  readonly writer: WorkWriter;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const pager = useWorkPage(
    scope.environmentId,
    { projectId: scope.projectId, operation: "foundation-records", recordKind: "message" },
    16,
  );
  const page = pager.view.page;
  const records = (page?.items ?? []).flatMap((item): ProjectTeamRecordRead[] => {
    const record = asProjectTeamRecord(item.value);
    return record === null ? [] : [record];
  });
  const messages = openMessages(records);
  const blocked = workWriteBlockedReason(pager.view, writer.canWrite);
  const current: ProjectWorkSelection | null =
    page === null ? null : { ...scope, revision: page.revision, taskRevision: 0 };

  return (
    <WorkSection title="Inbox" description="Messages from workers. Resolving one closes it.">
      {pager.view.status !== "ready" ? (
        <WorkRow>
          <WorkNotice view={pager.view} subject="messages" />
        </WorkRow>
      ) : null}
      {messages.length === 0 && page !== null ? (
        <WorkEmpty
          title={pager.offset === 0 ? "No open messages" : "No open messages on this page"}
        />
      ) : null}
      {messages.map((message) => (
        <InboxRow
          key={message.recordId}
          message={message}
          current={current}
          blocked={blocked}
          writer={writer}
          onOpenTask={onOpenTask}
        />
      ))}
      <WorkPager pager={pager} noun="Messages" />
    </WorkSection>
  );
}

function InboxRow({
  message,
  current,
  blocked,
  writer,
  onOpenTask,
}: {
  readonly message: WorkMessageRecord;
  readonly current: ProjectWorkSelection | null;
  readonly blocked: string | null;
  readonly writer: WorkWriter;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const key = `message:${message.recordId}`;
  const act = (action: WorkMessageAction) => {
    if (current === null) return;
    void writer.submit(
      key,
      current,
      current,
      makeMessageAttentionIntent(
        {
          commandId: newCommandId(),
          projectId: current.projectId,
          expectedRevision: current.revision,
        },
        message,
        action,
      ),
    );
  };
  const actions = messageActions(message);
  return (
    <WorkRow>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={message.status === "uncertain" ? "error" : "secondary"}>
          {message.status === "uncertain"
            ? "Delivery unknown"
            : message.status === "acknowledged"
              ? "Seen"
              : "New"}
        </Badge>
        <WorkMeta>
          From {message.senderId} · <WorkTime value={message.updatedAt} />
        </WorkMeta>
        <span className="min-w-0 flex-1" />
        {message.taskId ? (
          <Button size="xs" variant="ghost" onClick={() => onOpenTask(message.taskId!)}>
            Open task
          </Button>
        ) : null}
        {actions.map((action) => (
          <Button
            key={action}
            size="xs"
            variant={action === "resolve" ? "default" : "outline"}
            disabled={blocked !== null || writer.pendingKey !== null || current === null}
            title={blocked ?? undefined}
            onClick={() => act(action)}
          >
            {writer.pendingKey === key ? "Saving…" : ACTION_LABEL[action]}
          </Button>
        ))}
      </div>
      <p className="text-sm whitespace-pre-wrap break-words">{message.body}</p>
      {message.status === "uncertain" ? (
        <WorkMeta>Work can't confirm this reached its recipient, so it stays open.</WorkMeta>
      ) : null}
      <WorkFormStatus message={writer.failureFor(key)} />
    </WorkRow>
  );
}
