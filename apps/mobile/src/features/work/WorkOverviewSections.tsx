import {
  asProjectTeamRecord,
  type ProjectWorkScope,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import type {
  EnvironmentId,
  ProjectId,
  ProjectTeamRecordRead,
  ProjectWorkTaskId,
} from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { WorkBlock, WorkPager, WorkReadNotice, WorkText } from "./WorkParts";
import { newCommandId, useWorkRead, workWriteBlockedReason, type WorkWriter } from "./useWork";
import { useWorkPage } from "./useWorkRecords";
import {
  accountingSummary,
  bindingPhase,
  makeMessageAttentionIntent,
  messageActions,
  openMessages,
  portfolioEntries,
  portfolioPage,
  SUPERVISION_UNAVAILABLE,
  supervisionCounts,
  type WorkMessageAction,
} from "./workPresentation";

/** Who is working on what, from one bounded summary read. */
export function WorkSupervisionSection({
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
      <ListSection title="Team activity">
        <WorkReadNotice view={view} subject="team activity" />
        {summary !== null ? (
          <WorkBlock>
            <WorkText muted>{SUPERVISION_UNAVAILABLE[summary.availability] ?? ""}</WorkText>
          </WorkBlock>
        ) : null}
      </ListSection>
    );
  const counts = supervisionCounts(summary);
  return (
    <>
      <WorkReadNotice view={view} subject="team activity" />
      <ListSection
        title="Team activity"
        footer={`${counts.open} open · ${counts.active} running · ${counts.review} in review · ${counts.blocked} blocked or failed · ${counts.done} done`}
      >
        {summary.bindings.items.length === 0 ? (
          <WorkBlock>
            <WorkText muted>No workers running.</WorkText>
          </WorkBlock>
        ) : null}
        {summary.bindings.items.map((binding) =>
          "taskId" in binding ? (
            <ListRow
              key={binding.recordId}
              icon="person.crop.circle"
              label={`${bindingPhase(binding.status).label} · ${binding.model}`}
              {...(accountingSummary(binding.accounting)
                ? { description: accountingSummary(binding.accounting)!.text }
                : {})}
              onPress={() => onOpenTask(binding.taskId as ProjectWorkTaskId)}
            />
          ) : null,
        )}
        {summary.questions.items.map((question) =>
          "taskId" in question ? (
            <ListRow
              key={question.recordId}
              icon="questionmark.bubble"
              label="A worker is waiting for an answer"
              onPress={() => onOpenTask(question.taskId as ProjectWorkTaskId)}
            />
          ) : null,
        )}
        {summary.blockers.items.map((blocker) => (
          <ListRow
            key={blocker.recordId}
            icon="exclamationmark.triangle"
            label={blocker.reason}
            description={`Blocked · ${blocker.resolver}`}
            onPress={() => onOpenTask(blocker.taskId as ProjectWorkTaskId)}
          />
        ))}
        {summary.bindings.hasMore || summary.questions.hasMore || summary.blockers.hasMore ? (
          <WorkBlock>
            <WorkText muted>More is open than shown here.</WorkText>
          </WorkBlock>
        ) : null}
      </ListSection>
    </>
  );
}

const ACTION_LABEL: Record<WorkMessageAction, string> = {
  acknowledge: "Mark seen",
  resolve: "Resolve",
};

/** Messages from workers that still need a human, one page at a time. */
export function WorkInboxSection({
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
    <>
      <WorkReadNotice view={pager.view} subject="messages" />
      <ListSection title="Inbox" footer="Messages from workers. Resolving one closes it.">
        {messages.length === 0 && page !== null ? (
          <WorkBlock>
            <WorkText muted>No open messages.</WorkText>
          </WorkBlock>
        ) : null}
        {messages.map((message) => {
          const key = `message:${message.recordId}`;
          return (
            <WorkBlock key={message.recordId}>
              <WorkText>{message.body}</WorkText>
              <WorkText muted>
                {message.senderId}
                {message.status === "uncertain"
                  ? " · delivery unknown, so it stays open"
                  : message.status === "acknowledged"
                    ? " · seen"
                    : ""}
              </WorkText>
              {writer.failureFor(key) ? <WorkText muted>{writer.failureFor(key)}</WorkText> : null}
              <View className="flex-row flex-wrap gap-2">
                {message.taskId ? (
                  <Button
                    label="Open task"
                    tone="text"
                    onPress={() => onOpenTask(message.taskId!)}
                  />
                ) : null}
                {messageActions(message).map((action) => (
                  <Button
                    key={action}
                    label={ACTION_LABEL[action]}
                    tone={action === "resolve" ? "primary" : "secondary"}
                    loading={writer.pendingKey === key}
                    disabled={blocked !== null || current === null || writer.pendingKey !== null}
                    onPress={() => {
                      if (current === null) return;
                      void writer.submit(
                        key,
                        current,
                        current,
                        makeMessageAttentionIntent(
                          {
                            commandId: newCommandId(),
                            projectId: scope.projectId,
                            expectedRevision: current.revision,
                          },
                          message,
                          action,
                        ),
                      );
                    }}
                  />
                ))}
              </View>
            </WorkBlock>
          );
        })}
        <WorkPager pager={pager} noun="Messages" />
      </ListSection>
    </>
  );
}

/**
 * Every project checkout with a bounded Work summary, grouped by environment.
 * Only the current page of projects mounts summary reads; paging replaces it.
 */
export function WorkProjectList(props: {
  readonly onOpenProject: (environmentId: EnvironmentId, projectId: ProjectId) => void;
  readonly onOpenTask?: (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    taskId: ProjectWorkTaskId,
  ) => void;
}) {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const [pageIndex, setPageIndex] = useState(0);
  const page = portfolioPage(portfolioEntries(projects), pageIndex);
  if (page.shown.length === 0)
    return (
      <EmptyState
        variant="plain"
        title="No projects"
        detail="Add a project on a connected environment to track its Work."
      />
    );
  const groups = environments
    .map((environment) => ({
      environment,
      entries: page.shown.filter((entry) => entry.environmentId === environment.environmentId),
    }))
    .filter((group) => group.entries.length > 0);
  return (
    <>
      {groups.map((group) => (
        <ListSection key={group.environment.environmentId} title={group.environment.label}>
          {group.entries.map((entry) => (
            <PortfolioRow
              key={entry.projectId}
              environmentId={entry.environmentId}
              projectId={entry.projectId}
              title={entry.title}
              checkoutPath={entry.checkoutPath}
              onOpenProject={props.onOpenProject}
              {...(props.onOpenTask ? { onOpenTask: props.onOpenTask } : {})}
            />
          ))}
        </ListSection>
      ))}
      {page.pageCount > 1 ? (
        <ListSection title={`${page.first + 1}–${page.first + page.shown.length} of ${page.total}`}>
          <ListActionRow
            label="Previous projects"
            disabled={page.page === 0}
            onPress={() => setPageIndex(page.page - 1)}
          />
          <ListActionRow
            label="Next projects"
            disabled={page.page >= page.pageCount - 1}
            onPress={() => setPageIndex(page.page + 1)}
          />
        </ListSection>
      ) : null}
    </>
  );
}

function PortfolioRow(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly checkoutPath: string;
  readonly onOpenProject: (environmentId: EnvironmentId, projectId: ProjectId) => void;
  readonly onOpenTask?: (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    taskId: ProjectWorkTaskId,
  ) => void;
}) {
  const { environmentId, projectId } = props;
  const view = useWorkRead(environmentId, { projectId, operation: "supervision" });
  const summary = view.special?.operation === "supervision" ? view.special.value : null;
  let detail = props.checkoutPath;
  if (summary !== null && summary.availability === "available") {
    const counts = supervisionCounts(summary);
    const running = summary.bindings.items.filter(
      (binding) => "taskId" in binding && bindingPhase(binding.status).live,
    ).length;
    const questions = summary.questions.items.length;
    detail = `${counts.open + counts.active + counts.review} open · ${running} running${
      counts.blocked > 0 ? ` · ${counts.blocked} blocked` : ""
    }${questions > 0 ? ` · ${questions}${summary.questions.hasMore ? "+" : ""} waiting for you` : ""}\n${props.checkoutPath}`;
  } else if (summary !== null)
    detail = `${SUPERVISION_UNAVAILABLE[summary.availability] ?? ""}\n${props.checkoutPath}`;
  const question =
    summary !== null && summary.availability === "available"
      ? summary.questions.items.find((entry) => "taskId" in entry)
      : undefined;
  return (
    <ListRow
      icon="folder"
      label={props.title}
      description={detail}
      onPress={() =>
        question && "taskId" in question && props.onOpenTask
          ? props.onOpenTask(environmentId, projectId, question.taskId as ProjectWorkTaskId)
          : props.onOpenProject(environmentId, projectId)
      }
    />
  );
}
