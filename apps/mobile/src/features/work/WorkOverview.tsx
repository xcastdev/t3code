import {
  asProjectTeamRecord,
  asProjectWorkBriefing,
  type ProjectWorkScope,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import { recordedTeamConfiguration, pageWindow } from "@t3tools/client-runtime/project-work-logic";
import {
  makeMessageAttentionIntent,
  messageActions,
  openMessages,
  SUPERVISION_UNAVAILABLE,
  supervisionCounts,
  type WorkMessageAction,
  type WorkMessageRecord,
} from "@t3tools/client-runtime/project-work-presentation";
import {
  ProjectWorkAttentionRead,
  type ProjectTeamRecordRead,
  type ProjectWorkTaskId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState, type ReactNode } from "react";
import { View } from "react-native";

import { RelativeTime } from "../../components/RelativeTime";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { RowPressable } from "../../components/ui/RowPressable";
import { SymbolView } from "../../components/ui/AppSymbol";
import { newCommandId, useWorkRead, workWriteBlockedReason, type WorkWriter } from "./useWork";
import { useWorkPage } from "./useWorkRecords";
import { useWorkTeamRoster, type WorkRosterMember } from "./useWorkTeamRoster";
import { isMissionRecord, workStateLabel, type WorkMissionRecord } from "./workModel";
import { WorkPager, WorkReadNotice, WorkTaskLink } from "./WorkParts";
import {
  WorkEmptyRow,
  WorkHeading,
  WorkMemberAvatar,
  WorkSeparator,
  WorkStatRow,
  WorkStatTile,
  WorkStatusChip,
} from "./WorkStatus";

const isAttention = Schema.is(ProjectWorkAttentionRead);
const REQUIRED_TASK_WINDOW = 10;

/** One project's Work at a glance, in web's order. */
export function WorkOverview(props: {
  readonly scope: ProjectWorkScope;
  readonly writer: WorkWriter;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
  readonly onOpenTeam: () => void;
}) {
  const { scope, writer, onOpenTask } = props;
  const team = useWorkTeamRoster(scope);
  return (
    <>
      <WorkProgress team={team} />
      <WorkNeedsYou scope={scope} team={team} onOpenTask={onOpenTask} />
      <WorkInbox scope={scope} writer={writer} roster={team.roster} onOpenTask={onOpenTask} />
      <WorkMissions scope={scope} onOpenTask={onOpenTask} />
      <WorkBrief scope={scope} />
      <WorkTeamRail team={team} onManage={props.onOpenTeam} onOpenTask={onOpenTask} />
    </>
  );
}

type Team = ReturnType<typeof useWorkTeamRoster>;

const COUNT_TILES = [
  ["open", "Open", "draft"],
  ["active", "In progress", "in-progress"],
  ["review", "In review", "in-review"],
  ["blocked", "Blocked", "blocked"],
  ["done", "Done", "completed"],
] as const;

function WorkProgress({ team }: { readonly team: Team }) {
  const { summary, rawSummary, view } = team;
  if (summary === null)
    return (
      <View className="gap-2">
        <WorkReadNotice view={view} subject="progress" />
        {rawSummary !== null ? (
          <Notice
            icon="info.circle"
            message={SUPERVISION_UNAVAILABLE[rawSummary.availability] ?? ""}
          />
        ) : null}
      </View>
    );
  const counts = supervisionCounts(summary);
  const tile = ([key, label, state]: (typeof COUNT_TILES)[number]) => (
    <WorkStatTile key={key} value={counts[key]} label={label} state={state} />
  );
  return (
    <View className="gap-2">
      <WorkStatRow>{COUNT_TILES.slice(0, 3).map(tile)}</WorkStatRow>
      <WorkStatRow>{COUNT_TILES.slice(3).map(tile)}</WorkStatRow>
      {counts.unknown > 0 ? (
        <Text textRole="label" className="px-2 text-foreground-muted">
          {counts.unknown} unrecognized
        </Text>
      ) : null}
    </View>
  );
}

/** Questions, blockers, recovery and decisions waiting on the user, in one card. */
function WorkNeedsYou(props: {
  readonly scope: ProjectWorkScope;
  readonly team: Team;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const { scope, onOpenTask } = props;
  const { summary, view, roster } = props.team;
  const attention = useWorkPage(
    scope.environmentId,
    { projectId: scope.projectId, operation: "attention" },
    6,
  );
  const questions = (summary?.questions.items ?? []).flatMap((q) => ("taskId" in q ? [q] : []));
  const blockers = summary?.blockers.items ?? [];
  const recovery = (summary?.bindings.items ?? []).flatMap((b) =>
    "taskId" in b && b.status === "quarantined" ? [b] : [],
  );
  // Each blocker is already listed above with its owner and reason.
  const listedBlockers = new Set(blockers.map((blocker) => blocker.taskId));
  const decisions = (attention.view.page?.items ?? [])
    .map((item) => item.value)
    .filter(isAttention)
    .filter((entry) => entry.resolvedAt === undefined)
    .filter((entry) => entry.reason !== "blocked" || !listedBlockers.has(entry.taskId));
  const rows = [
    ...questions.map((question) => (
      <NeedsYouRow
        key={question.recordId}
        chip={<WorkStatusChip state="waiting" label="Answer needed" tone="warning" />}
        scope={scope}
        taskId={question.taskId as ProjectWorkTaskId}
        detail={`${roster.find((m) => m.recordId === question.senderId)?.name ?? "A team member"} is waiting for your answer.`}
        onOpenTask={onOpenTask}
      />
    )),
    ...blockers.map((blocker) => (
      <NeedsYouRow
        key={blocker.recordId}
        chip={<WorkStatusChip state="blocked" label={`Waiting on ${blocker.resolver}`} />}
        scope={scope}
        taskId={blocker.taskId as ProjectWorkTaskId}
        detail={blocker.reason}
        onOpenTask={onOpenTask}
      />
    )),
    ...recovery.map((binding) => (
      <NeedsYouRow
        key={binding.recordId}
        chip={<WorkStatusChip state="quarantined" label="Worker needs recovery" />}
        scope={scope}
        taskId={binding.taskId as ProjectWorkTaskId}
        onOpenTask={onOpenTask}
      />
    )),
    ...decisions.map((entry) => (
      <NeedsYouRow
        key={`${entry.taskId}:${entry.reason}`}
        chip={<WorkStatusChip state={entry.reason} />}
        scope={scope}
        taskId={entry.taskId}
        {...(entry.detail ? { detail: entry.detail } : {})}
        onOpenTask={onOpenTask}
      />
    )),
  ];
  const bounded =
    summary !== null &&
    (summary.questions.hasMore || summary.blockers.hasMore || summary.bindings.hasMore);
  return (
    <View className="gap-2">
      <WorkHeading
        title="Needs you"
        count={summary === null ? null : rows.length}
        detail="Questions, blockers and decisions waiting on your input."
      />
      <WorkReadNotice view={view} subject="team activity" />
      <WorkReadNotice view={attention.view} subject="attention" />
      <ListSection>
        {summary === null && view.status === "ready" ? (
          <WorkEmptyRow title="Team activity isn't available on this environment." />
        ) : null}
        {rows.length === 0 && (summary !== null || attention.view.page !== null) ? (
          <WorkEmptyRow
            title={
              attention.offset === 0
                ? "Nothing needs you right now."
                : "No other decisions on this page."
            }
          />
        ) : null}
        {rows.map((row, index) => (
          <View key={row.key}>
            {index > 0 ? <WorkSeparator /> : null}
            {row}
          </View>
        ))}
        {bounded ? (
          <WorkEmptyRow title="This summary is bounded. Open a task to see its full activity." />
        ) : null}
        <WorkPager pager={attention} noun="Decisions" />
      </ListSection>
    </View>
  );
}

function NeedsYouRow(props: {
  readonly chip: ReactNode;
  readonly scope: ProjectWorkScope;
  readonly taskId: ProjectWorkTaskId;
  readonly detail?: string;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  return (
    <View className="gap-1 pt-3">
      <View className="px-4">{props.chip}</View>
      <WorkTaskLink scope={props.scope} taskId={props.taskId} onOpen={props.onOpenTask} />
      {props.detail ? (
        <Text textRole="footnote" className="-mt-2 px-4 pb-3 text-foreground-muted">
          {props.detail}
        </Text>
      ) : null}
    </View>
  );
}

const ACTION_LABEL: Record<WorkMessageAction, string> = {
  acknowledge: "Mark seen",
  resolve: "Resolve",
};

/** Messages from workers that still need a human, one page at a time. */
function WorkInbox(props: {
  readonly scope: ProjectWorkScope;
  readonly writer: WorkWriter;
  readonly roster: ReadonlyArray<WorkRosterMember>;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const { scope, writer } = props;
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
    <View className="gap-2">
      <WorkHeading
        title="Inbox"
        count={page === null ? null : messages.length}
        detail="Messages from workers. Resolving one closes it."
      />
      <WorkReadNotice view={pager.view} subject="messages" />
      <ListSection>
        {messages.length === 0 && page !== null ? (
          <WorkEmptyRow
            title={pager.offset === 0 ? "No open messages." : "No open messages on this page."}
          />
        ) : null}
        {messages.map((message, index) => (
          <View key={message.recordId}>
            {index > 0 ? <WorkSeparator /> : null}
            <InboxRow
              message={message}
              sender={props.roster.find((member) => member.recordId === message.senderId)}
              current={current}
              blocked={blocked}
              writer={writer}
              onOpenTask={props.onOpenTask}
            />
          </View>
        ))}
        <WorkPager pager={pager} noun="Messages" />
      </ListSection>
    </View>
  );
}

function InboxRow(props: {
  readonly message: WorkMessageRecord;
  readonly sender: WorkRosterMember | undefined;
  readonly current: ProjectWorkSelection | null;
  readonly blocked: string | null;
  readonly writer: WorkWriter;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const { message, sender, current, writer } = props;
  const key = `message:${message.recordId}`;
  const failure = writer.failureFor(key);
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
  return (
    <View className="gap-2.5 px-4 py-3">
      <View className="flex-row items-center gap-2">
        {sender ? (
          <WorkMemberAvatar
            role={sender.role}
            name={sender.name}
            avatar={sender.avatar}
            size={24}
          />
        ) : null}
        <Text
          textRole="footnote"
          numberOfLines={1}
          className="shrink font-t3-medium text-foreground"
        >
          {sender?.name ?? "A team member"}
        </Text>
        <WorkStatusChip
          state={message.status}
          icon={null}
          tone={message.status === "uncertain" ? "error" : "info"}
          label={
            message.status === "uncertain"
              ? "Delivery unknown"
              : message.status === "acknowledged"
                ? "Seen"
                : "New"
          }
        />
        <View className="flex-1" />
        <Text textRole="label" className="text-foreground-tertiary">
          <RelativeTime timestamp={message.updatedAt} />
        </Text>
      </View>
      <Text selectable textRole="body" className="text-foreground">
        {message.body}
      </Text>
      {message.status === "uncertain" ? (
        <Text textRole="footnote" className="text-foreground-muted">
          Work can't confirm this reached its recipient, so it stays open.
        </Text>
      ) : null}
      {failure ? <Notice tone="danger" message={failure} /> : null}
      <View className="flex-row flex-wrap justify-end gap-2">
        {message.taskId ? (
          <Button
            label="Open task"
            tone="text"
            size="compact"
            onPress={() => props.onOpenTask(message.taskId!)}
          />
        ) : null}
        {messageActions(message).map((action) => (
          <Button
            key={action}
            label={ACTION_LABEL[action]}
            size="compact"
            tone={action === "resolve" ? "primary" : "secondary"}
            loading={writer.pendingKey === key}
            disabled={props.blocked !== null || current === null || writer.pendingKey !== null}
            onPress={() => act(action)}
          />
        ))}
      </View>
    </View>
  );
}

function WorkMissions(props: {
  readonly scope: ProjectWorkScope;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const { scope } = props;
  const missions = useWorkPage(
    scope.environmentId,
    { projectId: scope.projectId, operation: "foundation-records", recordKind: "mission" },
    32,
  );
  const items = (missions.view.page?.items ?? []).flatMap((item): WorkMissionRecord[] => {
    const record = asProjectTeamRecord(item.value);
    return record !== null && isMissionRecord(record) ? [record] : [];
  });
  return (
    <View className="gap-2">
      <WorkHeading
        title="Missions"
        count={missions.view.page === null ? null : items.length}
        detail="Groups of tasks toward one outcome. New missions come from refining an issue in Intake."
      />
      <WorkReadNotice view={missions.view} subject="missions" />
      <ListSection>
        {items.length === 0 && missions.view.page !== null ? (
          <WorkEmptyRow title={missions.offset === 0 ? "No missions yet." : "No more missions."} />
        ) : null}
        {items.map((mission, index) => (
          <View key={mission.recordId}>
            {index > 0 ? <WorkSeparator /> : null}
            <MissionRow scope={scope} mission={mission} onOpenTask={props.onOpenTask} />
          </View>
        ))}
        <WorkPager pager={missions} noun="Missions" />
      </ListSection>
    </View>
  );
}

function MissionRow(props: {
  readonly scope: ProjectWorkScope;
  readonly mission: WorkMissionRecord;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const { mission } = props;
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const required = mission.requiredTaskIds;
  const shown = required.slice(offset, offset + REQUIRED_TASK_WINDOW);
  const window = pageWindow(
    offset,
    shown.length,
    REQUIRED_TASK_WINDOW,
    offset + REQUIRED_TASK_WINDOW < required.length,
  );
  return (
    <View>
      <View className="gap-1.5 px-4 pt-3">
        <View className="flex-row items-start gap-2">
          <Text textRole="body" className="min-w-0 flex-1 font-t3-medium text-foreground">
            {mission.title}
          </Text>
          <WorkStatusChip state={mission.status} />
        </View>
        {mission.objective ? (
          <Text selectable textRole="footnote" className="text-foreground-muted">
            {mission.objective}
          </Text>
        ) : null}
      </View>
      <ListActionRow
        icon={open ? "chevron.down" : "chevron.right"}
        label={`${required.length} required ${required.length === 1 ? "task" : "tasks"}`}
        disabled={required.length === 0}
        onPress={() => setOpen(!open)}
      />
      {open
        ? shown.map((taskId) => (
            <WorkTaskLink
              key={taskId}
              scope={props.scope}
              taskId={taskId}
              onOpen={props.onOpenTask}
            />
          ))
        : null}
      {open && required.length > REQUIRED_TASK_WINDOW ? (
        <WorkPager
          noun="Tasks"
          pager={{
            window,
            next: () => window.nextOffset !== null && setOffset(window.nextOffset),
            previous: () => window.previousOffset !== null && setOffset(window.previousOffset),
          }}
        />
      ) : null}
    </View>
  );
}

/** The generated brief, two lines until opened. */
function WorkBrief({ scope }: { readonly scope: ProjectWorkScope }) {
  const [open, setOpen] = useState(false);
  const view = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "briefing",
    kind: "standard",
  });
  const briefing = asProjectWorkBriefing(view.value);
  return (
    <ListSection>
      <RowPressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        className="bg-grouped-card"
      >
        <View className="gap-1.5 px-4 py-3">
          <View className="flex-row items-center gap-2">
            <SymbolView name="doc.text" size={16} tintColorClassName="accent-icon-muted" />
            <Text textRole="footnote" className="flex-1 font-t3-medium text-foreground">
              Project brief
            </Text>
            {briefing ? (
              <Text textRole="label" className="font-mono text-foreground-tertiary">
                r{briefing.sourceRevision}
              </Text>
            ) : null}
            <SymbolView
              name={open ? "chevron.up" : "chevron.down"}
              size={12}
              tintColorClassName="accent-chevron"
            />
          </View>
          {briefing ? (
            <Text
              selectable={open}
              textRole="footnote"
              numberOfLines={open ? undefined : 2}
              className="text-foreground-muted"
            >
              {briefing.narrative ?? briefing.text}
            </Text>
          ) : open ? null : (
            <Text textRole="footnote" className="text-foreground-tertiary">
              No brief yet.
            </Text>
          )}
        </View>
      </RowPressable>
      {open ? (
        <View className="px-4 pb-3">
          <WorkReadNotice view={view} subject="the brief" />
        </View>
      ) : null}
    </ListSection>
  );
}

/** Who is on the team and what each is doing; managing it lives in the Team section. */
function WorkTeamRail(props: {
  readonly team: Team;
  readonly onManage: () => void;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const { records, limits, roles, members, roster } = props.team;
  const recorded = [limits, roles, members].every((set) => set.complete)
    ? recordedTeamConfiguration(records)
    : null;
  return (
    <View className="gap-2">
      <WorkHeading
        title="Your team"
        {...(recorded?.kind === "configured"
          ? {
              detail: `${recorded.values.enabled ? "Team enabled" : "Team disabled"}. Workers start from approved tasks.`,
            }
          : {})}
        trailing={
          <Button label="Manage team" tone="text" size="compact" onPress={props.onManage} />
        }
      />
      <WorkRosterList
        roster={roster}
        membersComplete={members.complete}
        onOpenTask={props.onOpenTask}
      />
    </View>
  );
}

/** The compact member list: avatar, name and role, and what each is doing now. */
export function WorkRosterList(props: {
  readonly roster: ReadonlyArray<WorkRosterMember>;
  readonly membersComplete: boolean;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  if (props.roster.length === 0)
    return props.membersComplete ? (
      <ListSection>
        <WorkEmptyRow
          title="No team yet"
          detail="Set up a team to give each role a name and a model."
        />
      </ListSection>
    ) : null;
  return (
    <ListSection>
      {props.roster.map((member, index) => (
        <View key={member.recordId}>
          {index > 0 ? <WorkSeparator /> : null}
          <RowPressable
            accessibilityRole={member.taskId ? "button" : undefined}
            disabled={!member.taskId}
            onPress={() => member.taskId && props.onOpenTask(member.taskId as ProjectWorkTaskId)}
            className="bg-grouped-card"
          >
            <View className="flex-row items-center gap-3 px-4 py-2.5">
              <WorkMemberAvatar
                role={member.role}
                name={member.name}
                avatar={member.avatar}
                size={32}
              />
              <View className="min-w-0 flex-1">
                <Text
                  textRole="footnote"
                  numberOfLines={1}
                  className="font-t3-medium text-foreground"
                >
                  {member.name}
                </Text>
                <Text textRole="label" numberOfLines={1} className="text-foreground-muted">
                  {workStateLabel(member.role)}
                </Text>
              </View>
              <WorkStatusChip
                state={member.activity.state}
                label={member.activity.label}
                tone={member.activity.tone}
              />
            </View>
          </RowPressable>
        </View>
      ))}
    </ListSection>
  );
}
