import {
  asProjectTeamRecord,
  asProjectWorkBriefing,
  type ProjectWorkScope,
} from "@t3tools/client-runtime/project-work";
import { ProjectWorkAttentionRead, type ProjectWorkTaskId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "../ui/collapsible";
import { WorkStatus } from "./WorkStatus";
import { Button } from "../ui/button";
import { WorkMeta, WorkRevision, WorkRow, WorkSection } from "./WorkLayout";
import { WorkNotice, WorkPager } from "./WorkNotice";
import { WorkTaskLink } from "./WorkTaskRefs";
import { WorkInbox, WorkSupervision, WorkProgress } from "./WorkSupervision";
import { WorkTeamRail } from "./WorkTeamRoster";
import { useWorkRead } from "./useWorkRead";
import { useWorkPage } from "./useWorkRecords";
import type { WorkWriter } from "./useWorkWriter";
import { pageWindow } from "./workLogic";
import { isMissionRecord, type WorkMissionRecord } from "./workModel";

const isAttention = Schema.is(ProjectWorkAttentionRead);
const REQUIRED_TASK_WINDOW = 10;

export function WorkOverview({
  scope,
  writer,
  onOpenTask,
  onOpenTeam,
}: {
  readonly scope: ProjectWorkScope;
  readonly writer: WorkWriter;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
  readonly onOpenTeam: () => void;
}) {
  const [briefOpen, setBriefOpen] = useState(false);
  const briefingView = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "briefing",
    kind: "standard",
  });
  const attention = useWorkPage(
    scope.environmentId,
    { projectId: scope.projectId, operation: "attention" },
    6,
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
    // Capped and split early, so a wide panel never stretches a few rows across the screen.
    <div className="mx-auto grid w-full max-w-6xl min-w-0 items-start gap-6 @3xl/work:grid-cols-[minmax(0,1fr)_17rem] @5xl/work:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="flex min-w-0 flex-col gap-6">
        <WorkProgress scope={scope} />
        <WorkSupervision scope={scope} onOpenTask={onOpenTask}>
          {attention.view.status !== "ready" ? (
            <WorkRow>
              <WorkNotice view={attention.view} subject="attention" />
            </WorkRow>
          ) : null}
          {attentionItems.map((entry) => (
            <WorkRow key={`${entry.taskId}:${entry.reason}`} className="gap-2 py-3.5">
              <WorkStatus state={entry.reason} />
              <WorkTaskLink scope={scope} taskId={entry.taskId} onOpen={onOpenTask} />
              {entry.detail ? <WorkMeta>{entry.detail}</WorkMeta> : null}
            </WorkRow>
          ))}
          {attentionItems.length === 0 && attention.view.page ? (
            <WorkRow>
              <WorkMeta>No other decisions on this page.</WorkMeta>
            </WorkRow>
          ) : null}
          <WorkPager pager={attention} noun="Decisions" />
        </WorkSupervision>
        <WorkInbox scope={scope} writer={writer} onOpenTask={onOpenTask} />
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
            <WorkRow>
              <WorkMeta>
                {missions.offset === 0 ? "No missions yet." : "No more missions."}
              </WorkMeta>
            </WorkRow>
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
        <div className="min-w-0 rounded-xl border border-border/60 bg-card/40">
          <Collapsible open={briefOpen} onOpenChange={setBriefOpen}>
            <div className="flex flex-wrap items-center justify-between gap-2 p-4">
              <CollapsibleTrigger render={<Button size="sm" variant="ghost" />}>
                {briefOpen ? "Hide project brief" : "Project brief"}
              </CollapsibleTrigger>
              {briefing ? (
                <WorkMeta>
                  Generated from project <WorkRevision>r{briefing.sourceRevision}</WorkRevision>
                </WorkMeta>
              ) : null}
            </div>
            {!briefOpen && briefing ? (
              <p className="line-clamp-2 px-4 pb-4 text-sm text-muted-foreground">
                {briefing.narrative ?? briefing.text}
              </p>
            ) : null}
            <CollapsiblePanel animate={false}>
              <div className="px-4 pb-4">
                <WorkNotice view={briefingView} subject="the brief" />
                {briefing ? (
                  <p className="max-w-3xl text-sm whitespace-pre-wrap break-words text-muted-foreground">
                    {briefing.narrative ?? briefing.text}
                  </p>
                ) : null}
              </div>
            </CollapsiblePanel>
          </Collapsible>
        </div>
      </div>
      <aside className="flex min-w-0 flex-col gap-6" aria-label="Team">
        <WorkTeamRail scope={scope} onManage={onOpenTeam} onOpenTask={onOpenTask} />
      </aside>
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
        <WorkStatus state={mission.status} />
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
