import type { EnvironmentId, ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import { ProjectTeamRecord } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { WorkCard } from "../../components/work/WorkDataNotice";
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
        return (
          <div className="flex min-w-0 flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold">Team</h2>
              <p className="text-sm text-muted-foreground">
                {props.connected && current
                  ? "Current recorded activity"
                  : "Cached or incomplete activity"}
                {updatedAt ? ` · Last recorded update ${updatedAt}` : ""}
              </p>
              {!current ? (
                <p className="text-sm text-muted-foreground">
                  Refresh to inspect a complete current team.
                </p>
              ) : null}
              {records.length !== snapshot.records.length ? (
                <p>Unsupported team records are present.</p>
              ) : null}
            </div>
            {items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No team assignments recorded.</p>
            ) : null}
            {items.slice(start, start + PAGE_SIZE).map((item) => {
              const run = item.kind === "run-binding" ? item : undefined;
              const member =
                item.kind === "member"
                  ? item
                  : members.find((candidate) => candidate.recordId === item.memberId);
              const role = roles.find(
                (candidate) =>
                  candidate.recordId === (run?.roleRevisionId ?? member?.roleRevisionId),
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
                  (record) =>
                    record.kind === "task-membership" && record.controlState === "canceling",
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
                <WorkCard key={item.recordId}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-medium">
                      {member?.name ?? "Unknown member"}
                      {member?.coordinator ? " · Coordinator" : ""}
                    </h3>
                    <Badge variant="outline">{status}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {role?.role ?? "Unknown role"} ·{" "}
                    {run?.model ?? role?.model ?? "Model not recorded"}
                  </p>
                  {run ? (
                    <div className="mt-3 flex flex-col gap-2 text-sm">
                      <p>
                        Assignment {run.taskId} · Run {run.recordId} · Recorded state {run.status}
                      </p>
                      {run.parentRunId ? <p>Parent run {run.parentRunId}</p> : null}
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
                      <p className="break-all">
                        {run.worktree} · {run.branch}
                      </p>
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
                            className="text-primary underline"
                            href={`/${encodeURIComponent(run.environmentId)}/${encodeURIComponent(run.threadId)}`}
                          >
                            Worker thread {run.threadId}
                          </a>
                        ) : (
                          <span>Worker belongs to another environment; link unavailable.</span>
                        )}
                      </div>
                      <p>Pause, resume, and cancel in the task detail.</p>
                      {failed?.kind === "effect" ? (
                        <p>
                          {failed.effectKind}: {failed.outcome ?? "Outcome not recorded"}
                        </p>
                      ) : null}
                      {activity?.kind === "message" ? (
                        <p className="line-clamp-3">
                          Latest message · {activity.status}: {activity.body.slice(0, 500)}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-muted-foreground">No assignment recorded.</p>
                  )}
                </WorkCard>
              );
            })}
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
