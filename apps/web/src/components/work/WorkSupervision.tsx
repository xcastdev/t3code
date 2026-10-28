import {
  asProjectTeamRecord,
  type ProjectWorkScope,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import type { ReactNode } from "react";
import type { ProjectTeamRecordRead, ProjectWorkTaskId } from "@t3tools/contracts";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { WorkEmpty, WorkFormStatus, WorkMeta, WorkRow, WorkSection, WorkTime } from "./WorkLayout";
import { WorkNotice, WorkPager } from "./WorkNotice";
import { workWriteBlockedReason } from "./useWorkRead";
import { useWorkPage } from "./useWorkRecords";
import type { WorkWriter } from "./useWorkWriter";
import {
  makeMessageAttentionIntent,
  messageActions,
  openMessages,
  supervisionCounts,
  type WorkMessageAction,
  type WorkMessageRecord,
} from "./workPresentation";
import { WorkTaskLink } from "./WorkTaskRefs";
import { WorkStatus } from "./WorkStatus";
import { WorkMemberAvatar } from "./WorkMemberAvatar";
import { useWorkTeamRoster } from "./useWorkTeamRoster";
import { newCommandId } from "./workTaskSurface";

const COUNT_LABELS = [
  ["open", "Open", "draft"],
  ["active", "In progress", "in-progress"],
  ["review", "In review", "in-review"],
  ["blocked", "Blocked or failed", "blocked"],
  ["done", "Done", "completed"],
] as const;

export function WorkProgress({ scope }: { scope: ProjectWorkScope }) {
  const { summary, view } = useWorkTeamRoster(scope);
  if (!summary)
    return (
      <WorkSection title="Progress">
        <WorkRow>
          <WorkNotice view={view} subject="progress" />
        </WorkRow>
      </WorkSection>
    );
  const counts = supervisionCounts(summary);
  return (
    <WorkSection title="Progress">
      <div className="grid grid-cols-2 gap-px">
        {COUNT_LABELS.map(([key, label, state]) => (
          <div key={key} className="flex flex-col gap-2 p-4">
            <span className="text-2xl font-semibold tabular-nums tracking-tight">
              {counts[key]}
            </span>
            <WorkStatus state={state} label={label} />
          </div>
        ))}
        {counts.unknown > 0 ? (
          <WorkRow>
            <WorkMeta>{counts.unknown} unrecognized</WorkMeta>
          </WorkRow>
        ) : null}
      </div>
    </WorkSection>
  );
}

export function WorkSupervision({
  scope,
  onOpenTask,
  children,
}: {
  readonly scope: ProjectWorkScope;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
  readonly children?: ReactNode;
}) {
  const { summary, view, roster } = useWorkTeamRoster(scope);
  const questions = summary?.questions.items ?? [];
  const blockers = summary?.blockers.items ?? [];
  const recovery = (summary?.bindings.items ?? []).filter((b) => b.status === "quarantined");
  return (
    <WorkSection
      title="Needs you"
      description="Questions, blockers and decisions waiting on your input."
    >
      {view.status !== "ready" ? (
        <WorkRow>
          <WorkNotice view={view} subject="team activity" />
        </WorkRow>
      ) : null}
      {summary === null && view.status === "ready" ? (
        <WorkRow>
          <WorkMeta>Team activity isn't available on this environment.</WorkMeta>
        </WorkRow>
      ) : null}
      {questions.map((question) =>
        "taskId" in question ? (
          <WorkRow key={question.recordId} className="gap-2 py-3.5">
            <div className="flex items-center gap-2">
              <WorkStatus state="waiting" label="Answer needed" tone="warning" />
              <span className="flex-1" />
              <Button
                size="xs"
                variant="outline"
                onClick={() => onOpenTask(question.taskId as ProjectWorkTaskId)}
              >
                Answer
              </Button>
            </div>
            <WorkTaskLink
              scope={scope}
              taskId={question.taskId as ProjectWorkTaskId}
              onOpen={onOpenTask}
            />
            <WorkMeta>
              {roster.find((m) => m.recordId === question.senderId)?.name ?? "A team member"} is
              waiting for your answer.
            </WorkMeta>
          </WorkRow>
        ) : null,
      )}
      {blockers.map((blocker) => (
        <WorkRow key={blocker.recordId} className="gap-2 py-3.5">
          <WorkStatus state="blocked" label={`Waiting on ${blocker.resolver}`} />
          <WorkTaskLink
            scope={scope}
            taskId={blocker.taskId as ProjectWorkTaskId}
            onOpen={onOpenTask}
          />
          <WorkMeta>{blocker.reason}</WorkMeta>
        </WorkRow>
      ))}
      {recovery.map((binding) =>
        "taskId" in binding ? (
          <WorkRow key={binding.recordId}>
            <WorkStatus state="quarantined" label="Worker needs recovery" />
            <WorkTaskLink
              scope={scope}
              taskId={binding.taskId as ProjectWorkTaskId}
              onOpen={onOpenTask}
            />
          </WorkRow>
        ) : null,
      )}
      {summary &&
      (summary.questions.hasMore || summary.blockers.hasMore || summary.bindings.hasMore) ? (
        <WorkRow>
          <WorkMeta>This summary is bounded. Open a task to see its full activity.</WorkMeta>
        </WorkRow>
      ) : null}
      {children}
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
  const { roster } = useWorkTeamRoster(scope);
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
          sender={roster.find((member) => member.recordId === message.senderId)}
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
  sender,
  current,
  blocked,
  writer,
  onOpenTask,
}: {
  readonly message: WorkMessageRecord;
  readonly sender: ReturnType<typeof useWorkTeamRoster>["roster"][number] | undefined;
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
        {sender ? <WorkMemberAvatar member={sender} /> : null}
        <span className="min-w-0 truncate text-sm font-medium">
          {sender?.name ?? "A team member"}
        </span>
        <Badge variant={message.status === "uncertain" ? "error" : "info"}>
          {message.status === "uncertain"
            ? "Delivery unknown"
            : message.status === "acknowledged"
              ? "Seen"
              : "New"}
        </Badge>
        <WorkMeta>
          <WorkTime value={message.updatedAt} />
        </WorkMeta>
      </div>
      <p className="text-sm whitespace-pre-wrap break-words">{message.body}</p>
      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
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
      {message.status === "uncertain" ? (
        <WorkMeta>Work can't confirm this reached its recipient, so it stays open.</WorkMeta>
      ) : null}
      <WorkFormStatus message={writer.failureFor(key)} />
    </WorkRow>
  );
}
