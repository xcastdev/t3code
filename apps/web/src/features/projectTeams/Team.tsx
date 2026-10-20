import type { EnvironmentId, ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import { ProjectTeamRecord } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { WorkCard } from "../../components/work/WorkDataNotice";
import {
  WorkDetails,
  WorkLabel,
  WorkSectionHeader,
  WorkTime,
  workStateLabel,
} from "../../components/work/WorkLayout";
import { WorkTeamFoundation } from "../../components/work/WorkTeamFoundation";
import {
  asProjectTeamBindingAccounting,
  projectTeamAccountingCaptions,
} from "@t3tools/client-runtime/project-work";

const knownRecord = Schema.is(ProjectTeamRecord);
const PAGE_SIZE = 128;

export interface TeamViewProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly connected: boolean;
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}

function teamStatusVariant(status: string) {
  if (status === "Waiting for human answer" || status === "Stopping") return "warning" as const;
  if (status === "Quarantined" || status.startsWith("Effect ")) return "error" as const;
  if (status === "running" || status === "Queued" || status === "reserved") return "info" as const;
  if (status === "Disconnected") return "outline" as const;
  return "secondary" as const;
}

/** Supervise recorded assignments without subscribing to worker transcripts. */
export function Team(props: TeamViewProps) {
  return <TeamSession key={JSON.stringify([props.environmentId, props.projectId])} {...props} />;
}

function TeamSession(props: TeamViewProps) {
  const [offset, setOffset] = useState(0);
  if (!props.supported) return <p>This environment does not support team supervision.</p>;
  return (
    <WorkTeamFoundation {...props}>
      {({ snapshot, current }) => {
        const records = snapshot.records.filter(knownRecord);
        const runs = records.filter((record) => record.kind === "run-binding");
        const members = records.filter((record) => record.kind === "member");
        const roles = records.filter((record) => record.kind === "role-revision");
        const items = [
          ...runs,
          ...members.filter((member) => !runs.some((run) => run.memberId === member.recordId)),
        ];
        const start = offset < items.length ? offset : 0;
        const updatedAt = records.reduce(
          (latest, record) => (record.updatedAt > latest ? record.updatedAt : latest),
          "",
        );
        const card = (item: (typeof items)[number]) => {
          const run = item.kind === "run-binding" ? item : undefined;
          const member =
            item.kind === "member"
              ? item
              : members.find((candidate) => candidate.recordId === item.memberId);
          const role = roles.find(
            (candidate) => candidate.recordId === (run?.roleRevisionId ?? member?.roleRevisionId),
          );
          const related = run
            ? records.filter((record) => "taskId" in record && record.taskId === run.taskId)
            : [];
          const question = related.find(
            (record) =>
              run?.status === "running" &&
              record.kind === "question" &&
              record.status === "pending" &&
              record.senderId === run.memberId,
          );
          const stopping =
            run?.status === "stopping" ||
            related.some(
              (record) => record.kind === "task-membership" && record.controlState === "canceling",
            );
          const failed = related.find(
            (record) =>
              record.kind === "effect" &&
              record.runId === run?.recordId &&
              (record.status === "failed" || record.status === "uncertain"),
          );
          const status = !props.connected
            ? "Disconnected"
            : run?.status === "settled" || run?.status === "revoked"
              ? run.status
              : stopping
                ? "Stopping"
                : run?.status === "quarantined"
                  ? "Quarantined"
                  : failed
                    ? `Effect ${failed.status}`
                    : question
                      ? "Waiting for human answer"
                      : run?.status === "reserved"
                        ? "Queued"
                        : run
                          ? run.status
                          : (member?.status ?? "Unknown member");
          const activity = related
            .filter((record) => record.kind === "message")
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
          return (
            <WorkCard key={item.recordId} className={run ? undefined : "p-3"}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium">
                  {member?.name ?? "Unknown member"}
                  {member?.coordinator ? " · Coordinator" : ""}
                </h3>
                <Badge variant={teamStatusVariant(status)}>{workStateLabel(status)}</Badge>
              </div>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {role?.role ?? "Unknown role"} · {run?.model ?? role?.model ?? "Model not recorded"}
              </p>
              {run ? (
                <div className="mt-3 flex flex-col gap-2 text-sm">
                  {projectTeamAccountingCaptions(
                    asProjectTeamBindingAccounting(
                      snapshot.accounting?.find((item) => item.bindingId === run.recordId),
                      run,
                    ),
                  ).map((caption) => (
                    <p key={caption} className="break-words text-xs text-muted-foreground">
                      {caption}
                    </p>
                  ))}
                  <WorkDetails>
                    <p>
                      Assignment {run.taskId} · Run {run.recordId} · Recorded state {run.status}
                    </p>
                    {run.parentRunId ? <p>Parent run {run.parentRunId}</p> : null}
                    <p>
                      {run.worktree} · {run.branch}
                    </p>
                  </WorkDetails>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => props.onOpenTask(run.taskId)}
                    >
                      Open task {run.taskId}
                    </Button>
                    {run.environmentId === props.environmentId ? (
                      <a
                        className="rounded-sm text-sm text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        href={`/${encodeURIComponent(run.environmentId)}/${encodeURIComponent(run.threadId)}`}
                      >
                        Worker thread {run.threadId}
                      </a>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Worker belongs to another environment; link unavailable.
                      </span>
                    )}
                  </div>
                  {failed?.kind === "effect" ? (
                    <p className="text-destructive-foreground">
                      {failed.effectKind}: {failed.outcome ?? "Outcome not recorded"}
                    </p>
                  ) : null}
                  {activity?.kind === "message" ? (
                    <p className="line-clamp-3 text-muted-foreground">
                      Latest message · {activity.status}: {activity.body.slice(0, 500)}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">No assignment recorded.</p>
              )}
            </WorkCard>
          );
        };
        return (
          <div className="flex min-w-0 flex-col gap-4">
            <WorkSectionHeader
              title="Team"
              status={
                <>
                  {props.connected && current
                    ? "Current recorded activity"
                    : "Cached or incomplete activity"}
                  {updatedAt ? (
                    <>
                      {" · Last recorded update "}
                      <WorkTime value={updatedAt} />
                    </>
                  ) : null}
                </>
              }
              description={
                <>
                  Who is working on what. Pause, resume and cancel from the task.
                  {!current ? " Refresh to inspect a complete current team." : ""}
                </>
              }
            />
            {records.length !== snapshot.records.length ? (
              <p className="text-sm text-warning-foreground">
                Unsupported team records are present.
              </p>
            ) : null}
            {items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No team assignments recorded.</p>
            ) : null}
            {(() => {
              const visible = items.slice(start, start + PAGE_SIZE);
              const assigned = visible.filter((item) => item.kind === "run-binding");
              const idle = visible.filter((item) => item.kind !== "run-binding");
              return (
                <>
                  {assigned.map(card)}
                  {idle.length > 0 ? (
                    <div className="space-y-2">
                      {assigned.length > 0 ? <WorkLabel>Without an assignment</WorkLabel> : null}
                      <div className="grid gap-2 sm:grid-cols-2">{idle.map(card)}</div>
                    </div>
                  ) : null}
                </>
              );
            })()}
            <div className="flex gap-2">
              {start > 0 ? (
                <Button variant="outline" size="sm" onClick={() => setOffset(start - PAGE_SIZE)}>
                  Previous team page
                </Button>
              ) : null}
              {start + PAGE_SIZE < items.length ? (
                <Button variant="outline" size="sm" onClick={() => setOffset(start + PAGE_SIZE)}>
                  Next team page
                </Button>
              ) : null}
            </div>
          </div>
        );
      }}
    </WorkTeamFoundation>
  );
}
