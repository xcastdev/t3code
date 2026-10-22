import {
  asProjectTeamRecord,
  asProjectWorkBriefing,
  type ProjectWorkScope,
} from "@t3tools/client-runtime/project-work";
import { ProjectWorkAttentionRead, type ProjectWorkTaskId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { WorkEmpty, WorkMeta, WorkRevision, WorkRow, WorkSection } from "./WorkLayout";
import { WorkNotice, WorkPager } from "./WorkNotice";
import { WorkTaskLink } from "./WorkTaskRefs";
import { WorkInbox, WorkSupervision } from "./WorkSupervision";
import { WorkTeam } from "./WorkTeam";
import { useWorkRead } from "./useWorkRead";
import { useWorkPage } from "./useWorkRecords";
import type { WorkWriter } from "./useWorkWriter";
import { pageWindow } from "./workLogic";
import {
  isMissionRecord,
  workStateLabel,
  workStateVariant,
  type WorkMissionRecord,
} from "./workModel";

const isAttention = Schema.is(ProjectWorkAttentionRead);
const REQUIRED_TASK_WINDOW = 10;

export function WorkOverview({
  scope,
  writer,
  onOpenTask,
}: {
  readonly scope: ProjectWorkScope;
  readonly writer: WorkWriter;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const briefingView = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "briefing",
    kind: "standard",
  });
  const attention = useWorkPage(
    scope.environmentId,
    { projectId: scope.projectId, operation: "attention" },
    32,
  );
  const missions = useWorkPage(
    scope.environmentId,
    { projectId: scope.projectId, operation: "foundation-records", recordKind: "mission" },
    32,
  );
  const briefing = asProjectWorkBriefing(briefingView.value);
  const attentionItems = (attention.view.page?.items ?? [])
    .map((item) => item.value)
    .filter(isAttention)
    .filter((entry) => entry.resolvedAt === undefined);
  const missionItems = (missions.view.page?.items ?? []).flatMap((item): WorkMissionRecord[] => {
    const record = asProjectTeamRecord(item.value);
    return record !== null && isMissionRecord(record) ? [record] : [];
  });

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <WorkSection
        title="Brief"
        description={
          briefing ? (
            <>
              Generated from project revision{" "}
              <WorkRevision>r{briefing.sourceRevision}</WorkRevision>
            </>
          ) : undefined
        }
      >
        {briefing === null ? (
          <WorkRow>
            <WorkNotice view={briefingView} subject="the brief" />
            {briefingView.status === "ready" ? (
              <WorkMeta>No brief is available yet.</WorkMeta>
            ) : null}
          </WorkRow>
        ) : (
          <WorkRow className="gap-2">
            <p className="max-w-3xl text-sm whitespace-pre-wrap break-words">
              {briefing.narrative ?? briefing.text}
            </p>
            {briefing.omittedReasons.length > 0 ? (
              <WorkMeta>Shortened: {briefing.omittedReasons.join(" · ")}</WorkMeta>
            ) : null}
          </WorkRow>
        )}
      </WorkSection>

      <WorkSupervision scope={scope} onOpenTask={onOpenTask} />
      <WorkInbox scope={scope} writer={writer} onOpenTask={onOpenTask} />

      <WorkSection title="Needs attention">
        {attention.view.status !== "ready" ? (
          <WorkRow>
            <WorkNotice view={attention.view} subject="attention" />
          </WorkRow>
        ) : null}
        {attentionItems.length === 0 && attention.view.page !== null ? (
          <WorkEmpty
            title={attention.offset === 0 ? "Nothing needs attention" : "Nothing open on this page"}
          />
        ) : null}
        {attentionItems.map((entry) => (
          <WorkRow key={`${entry.taskId}:${entry.reason}`} className="flex-row items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm">{workStateLabel(entry.reason)}</p>
              {entry.detail ? <WorkMeta className="break-words">{entry.detail}</WorkMeta> : null}
            </div>
            <Button size="xs" variant="outline" onClick={() => onOpenTask(entry.taskId)}>
              Open task
            </Button>
          </WorkRow>
        ))}
        <WorkPager pager={attention} noun="Items" />
      </WorkSection>

      <WorkSection
        title="Missions"
        description="Groups of tasks toward one outcome. New missions come from refining an issue in Intake."
      >
        {missions.view.status !== "ready" ? (
          <WorkRow>
            <WorkNotice view={missions.view} subject="missions" />
          </WorkRow>
        ) : null}
        {missionItems.length === 0 && missions.view.page !== null ? (
          <WorkEmpty title={missions.offset === 0 ? "No missions" : "No more missions"} />
        ) : null}
        {missionItems.map((mission) => (
          <MissionRow
            key={mission.recordId}
            scope={scope}
            mission={mission}
            onOpenTask={onOpenTask}
          />
        ))}
        <WorkPager pager={missions} noun="Missions" />
      </WorkSection>

      <WorkTeam scope={scope} writer={writer} />
    </div>
  );
}

function MissionRow({
  scope,
  mission,
  onOpenTask,
}: {
  readonly scope: ProjectWorkScope;
  readonly mission: WorkMissionRecord;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
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
    <WorkRow className="gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm font-medium break-words">{mission.title}</p>
        <Badge variant={workStateVariant(mission.status)}>{workStateLabel(mission.status)}</Badge>
      </div>
      {mission.objective ? (
        <p className="text-sm whitespace-pre-wrap break-words text-muted-foreground">
          {mission.objective}
        </p>
      ) : null}
      <div>
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={open}
          disabled={required.length === 0}
          onClick={() => setOpen(!open)}
        >
          {required.length} required {required.length === 1 ? "task" : "tasks"}
        </Button>
      </div>
      {open ? (
        <div className="flex flex-col gap-0.5">
          {shown.map((taskId) => (
            <WorkTaskLink key={taskId} scope={scope} taskId={taskId} onOpen={onOpenTask} />
          ))}
          {required.length > REQUIRED_TASK_WINDOW ? (
            <div className="flex items-center justify-between gap-2 px-2">
              <WorkMeta className="tabular-nums">
                {window.from}–{window.to} of {required.length}
              </WorkMeta>
              <div className="flex gap-1.5">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={window.previousOffset === null}
                  onClick={() => window.previousOffset !== null && setOffset(window.previousOffset)}
                >
                  Previous
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={window.nextOffset === null}
                  onClick={() => window.nextOffset !== null && setOffset(window.nextOffset)}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </WorkRow>
  );
}
